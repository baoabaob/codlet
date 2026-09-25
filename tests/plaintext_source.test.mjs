import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';
import http from 'node:http';
import https from 'node:https';
import net from 'node:net';
import { once } from 'node:events';
import { createRequire } from 'node:module';
import test from 'node:test';
import { nativeTraffic, listen, read, idle, bodyBytes } from './support/native-traffic.mjs';
const require = createRequire(import.meta.url);
const { connectTrafficPeer } = require('../runtime/traffic-wire.cjs');
const { WebSocket, WebSocketServer } = require('../frontend/node_modules/ws');
const tick = ms => new Promise(resolve => setTimeout(resolve, ms));
const frame = value => { const bytes=Buffer.from(JSON.stringify(value));const result=Buffer.alloc(bytes.length+4);result.writeUInt32BE(bytes.length);bytes.copy(result,4);return result; };
const token = 'a'.repeat(43);

test('source updates pin active exchanges and atomically change future requests', {timeout:15000}, async t => {
  let release, started; const gate=new Promise(r=>release=r), seen=new Promise(r=>started=r);
  t.after(()=>release());
  const first=await listen(http.createServer(async(req,res)=>{assert.equal(req.url,'/v1/responses?q=%2F..');started();await gate;res.end('first');}),t);
  const second=await listen(http.createServer((req,res)=>{assert.equal(req.url,'/v2/responses');res.end('second');}),t);
  const f=await nativeTraffic(t);const client=f.client();await client.ready;
  const route=client.reserveRoute({upstreamBaseUrl:first+'/v1'});await route.ready;
  const old=read(route.baseUrl+'/responses?q=%2F..');await seen;
  await route.update({upstreamBaseUrl:second+'/v2'});
  assert.equal((await read(route.baseUrl+'/responses')).body.toString(),'second');
  release();assert.equal((await old).body.toString(),'first');await route.close();await idle(f);
});

test('source route CA is scoped, replaceable, bounded and fully validated', {timeout:15000}, async t=>{
  const [cert,key,ca]=await Promise.all(['localhost-cert.pem','localhost-key.pem','localhost-ca.pem'].map(n=>readFile(new URL('./fixtures/traffic-tls/'+n,import.meta.url),'utf8')));
  const origin=(await listen(https.createServer({cert,key},(_req,res)=>res.end('trusted')),t)).replace('http:','https:');
  const f=await nativeTraffic(t);const client=f.client();await client.ready;
  const route=client.reserveRoute({upstreamBaseUrl:origin,additionalCaPem:ca});await route.ready;
  assert.equal((await read(route.baseUrl)).status,200);
  await route.update({upstreamBaseUrl:origin,additionalCaPem:''});assert.equal((await read(route.baseUrl)).status,502);
  await assert.rejects(route.update({upstreamBaseUrl:origin,additionalCaPem:'bad PEM'}));
  await route.update({upstreamBaseUrl:origin,additionalCaPem:ca});assert.equal((await read(route.baseUrl)).status,200);
  await route.close();await idle(f);
});

test('private source rejects wrong credentials and enforces route collision and path boundaries', {timeout:15000},async t=>{
  const f=await nativeTraffic(t);
  await assert.rejects(connectTrafficPeer({...f.descriptor.endpoint,token:'wrong'}),{code:'peer_closed'});
  const peer=await connectTrafficPeer(f.descriptor.endpoint);t.after(()=>peer.close());
  await peer.request('route.register',{token,upstreamBaseUrl:'https://example.invalid/v1'});
  await assert.rejects(peer.request('route.register',{token,upstreamBaseUrl:'https://example.invalid/v1'}),{code:'route_collision'});
  for(const suffix of ['/%252e%252e/escape','/%2fescape','/%5cescape']) assert.equal((await read(f.descriptor.routeBaseUrl+'/'+token+suffix)).status,400);
  for(const base of ['https://example.invalid/a/../b','https://example.invalid/%2e','https://user:pass@example.invalid','https://example.invalid/?q=x']){
    await assert.rejects(peer.request('route.update',{token,upstreamBaseUrl:base}),{code:'invalid_target'});
  }
  await peer.request('route.close',{token});assert.equal((await read(f.descriptor.routeBaseUrl+'/'+token)).status,404);
});

test('concurrent source registrations have a hard 32-route budget and peer teardown releases it', {timeout:15000},async t=>{
  const f=await nativeTraffic(t);const peer=await connectTrafficPeer(f.descriptor.endpoint);t.after(()=>peer.close());
  const results=await Promise.allSettled(Array.from({length:40},(_,i)=>peer.request('route.register',{token:Buffer.alloc(32,i+1).toString('base64url'),upstreamBaseUrl:'https://example.invalid'})));
  assert.equal(results.filter(r=>r.status==='fulfilled').length,32);assert(results.filter(r=>r.status==='rejected').every(r=>r.reason.code==='resource_limit'));
  assert.equal((await f.call('resources')).routes,32);peer.close();
  for(let i=0;i<100&&(await f.call('resources')).routes;i++)await tick(10);
  assert.equal((await f.call('resources')).routes,0);
});

test('simultaneous authenticated source candidates admit one peer and Core shutdown closes it', {timeout:15000},async t=>{
  const f=await nativeTraffic(t),endpoint=f.descriptor.endpoint;
  const sockets=[net.connect(endpoint.port,endpoint.host),net.connect(endpoint.port,endpoint.host)];t.after(()=>sockets.forEach(s=>s.destroy()));
  await Promise.all(sockets.map(s=>once(s,'connect')));
  for(const socket of sockets){socket.on('error',()=>{});socket.resume();socket.write(frame({token:endpoint.token}));}
  await tick(100);assert.equal(sockets.filter(s=>!s.destroyed).length,1);
  await f.close();await tick(20);assert(sockets.every(s=>s.destroyed));
});

for(const unread of [false,true]) test(`delegated redirect cancellation releases ${unread?'unread':'streamed'} bodies before the next hop`,{timeout:15000},async t=>{
  const f=await nativeTraffic(t),client=f.client();await client.ready;const outer=new AbortController();let cancelled=false,forwardSignal;
  const body={cancel(){cancelled=true;},[Symbol.asyncIterator](){let first=true;return {next:()=>first?(first=false,Promise.resolve({done:false,value:'prefix'})):new Promise(()=>{}),return:async()=>{cancelled=true;return {done:true};}};}};
  const response=await client.interceptHttp({url:'https://desktop.invalid/first',method:'GET',headers:[]},{signal:outer.signal,forward:async(input,{signal})=>{forwardSignal=signal;return {status:302,finalUrl:input.url,headers:[['location','/second']],body};}});
  if(!unread)assert.equal((await response.body[Symbol.asyncIterator]().next()).value.toString(),'prefix');
  await response.body.cancel();assert.equal(cancelled,true);assert.equal(forwardSignal.aborted,true);
  const next=await client.interceptHttp({url:'https://desktop.invalid/second',method:'GET',headers:[]},{signal:outer.signal,forward:async input=>({status:200,headers:[],finalUrl:input.url,body:'done'})});
  assert.equal((await bodyBytes(next.body)).toString(),'done');assert.equal(outer.signal.aborted,false);await idle(f);
});

for(const revoke of [false,true]) test(`delegated ${revoke?'interceptor revocation':'caller cancellation'} aborts original forward`,{timeout:15000},async t=>{
  const origin='https://desktop.invalid',f=await nativeTraffic(t,{origins:[origin]}),client=f.client();await client.ready;
  const hook=await f.runtime().api.registerInterceptor({id:'cancel',origins:[origin]},{request:()=>null});
  const controller=new AbortController();let started,cancelled=false;const seen=new Promise(r=>started=r);
  const pending=client.interceptHttp({url:origin+'/data',method:'GET',headers:[]},{signal:controller.signal,forward:(_input,{signal})=>new Promise((_,reject)=>{started();signal.addEventListener('abort',()=>{cancelled=true;reject(Object.assign(new Error('cancelled'),{code:'request_cancelled'}));},{once:true});})});
  const rejected=assert.rejects(pending);await seen;
  if(revoke)await hook.close();else controller.abort();await rejected;
  for(let i=0;i<100&&!cancelled;i++)await tick(10);assert.equal(cancelled,true);await idle(f);
});

test('automatic redirected final responses remain hidden without a final-origin grant',{timeout:15000},async t=>{
  const origin='https://desktop.invalid',f=await nativeTraffic(t,{origins:[origin]}),client=f.client();await client.ready;let observed=0;
  await f.runtime().api.registerInterceptor({id:'response',origins:[origin]},{response(){observed++;}});
  const response=await client.interceptHttp({url:origin+'/first',method:'GET',headers:[]},{forward:async()=>({status:200,headers:[],finalUrl:'https://other.invalid/private',body:'private'})});
  assert.equal((await bodyBytes(response.body)).toString(),'private');assert.equal(observed,0);await idle(f);
});

test('five simultaneous WebSockets leave native HTTP capacity available and route close cancels all',{timeout:15000},async t=>{
  const server=http.createServer((_req,res)=>res.end('http')),ws=new WebSocketServer({server});t.after(()=>{for(const socket of ws.clients)socket.terminate();ws.close();});
  const origin=await listen(server,t),f=await nativeTraffic(t),client=f.client();await client.ready;
  const route=client.reserveRoute({upstreamBaseUrl:origin});await route.ready;
  const sockets=Array.from({length:5},()=>new WebSocket(route.baseUrl.replace('http:','ws:')));t.after(()=>sockets.forEach(s=>s.terminate()));
  await Promise.all(sockets.map(s=>once(s,'open')));assert.equal((await read(route.baseUrl)).body.toString(),'http');
  const closed=sockets.map(s=>once(s,'close'));await route.close();await Promise.all(closed);await idle(f);
});
