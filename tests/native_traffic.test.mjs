import test from 'node:test';
import assert from 'node:assert/strict';
import http from 'node:http';
import https from 'node:https';
import net from 'node:net';
import { gzipSync } from 'node:zlib';
import { readFile } from 'node:fs/promises';
import { fileURLToPath } from 'node:url';
import { createRequire } from 'node:module';
import { once } from 'node:events';
import { nativeTraffic, bodyBytes, listen, read, idle } from './support/native-traffic.mjs';
const require = createRequire(import.meta.url);
const {WebSocket,WebSocketServer}=require('../frontend/node_modules/ws');
const {connectTrafficPeer}=require('../runtime/traffic-wire.cjs');

test('native source speaks the unchanged Adapter peer and streams HTTP/SSE', {timeout:15000}, async t=>{
  const server=http.createServer(async(req,res)=>{const bytes=await bodyBytes(req);res.writeHead(200,{'content-type':'text/event-stream'});res.write('data: ');res.end(bytes);});
  const origin=await listen(server,t);const fixture=await nativeTraffic(t,{origins:[origin]});
  const client=fixture.client();await client.ready;const route=client.reserveRoute({upstreamBaseUrl:origin});await route.ready;
  const result=await read(route.baseUrl+'/responses',{method:'POST',body:'fixture'});
  assert.equal(result.status,200);assert.equal(result.body.toString(),'data: fixture');
  await route.close();await idle(fixture);
});

test('native transparent interception invokes ordinary JS handlers and preserves hidden auth', {timeout:15000},async t=>{
  let seen;const origin=await listen(http.createServer(async(req,res)=>{seen=req.headers.authorization;res.end(await bodyBytes(req));}),t);
  const f=await nativeTraffic(t,{origins:[origin]});const runtime=f.runtime();
  const hook=await runtime.api.registerInterceptor({id:'rewrite',origins:[origin]},{request(request){assert(!request.headers.some(([name])=>name==='authorization'));return {request:{body:'changed'}};},async response(response){assert.equal((await bodyBytes(response.body)).toString(),'changed');return {body:'replied'};}});
  const source=await runtime.api.openSource({upstreamBaseUrl:origin});
  const result=await read(source.endpoint+'/responses',{method:'POST',headers:{authorization:'Bearer fixture'},body:'original'});
  assert.equal(result.status,200);assert.equal(result.body.toString(),'replied');assert.equal(seen,'Bearer fixture');
  await hook.close();await source.close();await idle(f);
});

test('explicit channel works without interception grants and checks own origins', {timeout:15000},async t=>{
  const origin=await listen(http.createServer(async(req,res)=>res.end(await bodyBytes(req))),t);
  const f=await nativeTraffic(t,{origins:[origin],noIntercept:true});const runtime=f.runtime();
  const channel=await runtime.api.openChannel({}, {http:async(request,exchange)=>{
    const result=await exchange.forward({url:origin+'/echo',method:'POST',body:request.body});return result;
  }});
  const result=await read(channel.endpoint+'/test',{method:'POST',body:'native channel'});
  assert.equal(result.status,200);assert.equal(result.body.toString(),'native channel');
  await channel.close();assert.equal(channel.status().open,false);await idle(f);
});

test('raw Host forwarding cannot change an exchange protocol to bypass concurrency budgets',async t=>{
  let connected=0;const server=http.createServer((_req,res)=>res.end());server.on('connection',()=>connected++);
  const origin=await listen(server,t),f=await nativeTraffic(t,{origins:[origin],noIntercept:true});let failure;
  const peer=await connectTrafficPeer(await f.call('services.traffic.connectPeer'),{handle:async(method,params)=>{
    assert.equal(method,'invoke');
    try{await peer.request('channel.forward',{lease:params.lease,webSocket:true,request:{url:origin.replace('http:','ws:')}});}catch(error){failure=error.code;}
    return {status:204,headers:[],body:null};
  }});t.after(()=>peer.close());
  const channel=await f.call('services.traffic.openChannel',{options:{maxConcurrent:1},handlers:['http']});
  assert.equal((await read(channel.endpoint)).status,204);assert.equal(failure,'invalid_frame');assert.equal(connected,0);
  await f.call('services.traffic.closeChannel',{channel:channel.id});await idle(f);
});

test('native WebSocket route passes and transforms both directions', {timeout:15000},async t=>{
  const server=http.createServer();const ws=new WebSocketServer({server});t.after(()=>{for(const socket of ws.clients)socket.terminate();ws.close();});
  ws.on('connection',socket=>socket.on('message',data=>socket.send('echo:'+data)));
  const origin=await listen(server,t);const f=await nativeTraffic(t,{origins:[origin]});const runtime=f.runtime();
  const hook=await runtime.api.registerInterceptor({id:'frames',origins:[origin]},{webSocket(){return {clientToServer:frame=>({...frame,data:'sent'}),serverToClient:frame=>({...frame,data:frame.data+':received'})};}});
  const source=await runtime.api.openSource({upstreamBaseUrl:origin});const socket=new WebSocket(source.endpoint.replace('http:','ws:')+'/responses');t.after(()=>socket.terminate());await once(socket,'open');
  const next=once(socket,'message');socket.send('original');assert.equal((await next)[0].toString(),'echo:sent:received');const closed=once(socket,'close');socket.close();await closed;
  await hook.close();await source.close();await idle(f);
});

test('native delegated HTTP uses original forward, handles empty redirects, and retains original finite errors', {timeout:15000},async t=>{
  const origin='https://desktop.invalid';const f=await nativeTraffic(t,{origins:[origin]});const runtime=f.runtime();let observed=0;
  const hook=await runtime.api.registerInterceptor({id:'redirect',origins:[origin]},{async response(value){observed++;if(value.status===302){assert.equal((await bodyBytes(value.body)).length,0);return {body:''};}}});
  const client=f.client();await client.ready;
  const response=await client.interceptHttp({url:origin+'/first',method:'GET',headers:[]},{forward:async request=>({status:302,headers:[['location','/next']],finalUrl:request.url,body:(async function*(){})()})});
  assert.equal(response.status,302);assert.equal((await bodyBytes(response.body)).length,0);assert.equal(observed,1);
  await assert.rejects(client.interceptHttp({url:origin+'/failure',method:'GET',headers:[]},{forward:async()=>{throw Object.assign(new Error('fixture private detail'),{code:'upstream_fixture_failure'});}}),{code:'upstream_fixture_failure'});
  await hook.close();await idle(f);
});

test('delegated absent bodies stay null and do not become consumed empty streams',async t=>{
  const origin='https://desktop.invalid',f=await nativeTraffic(t,{origins:[origin]});
  await f.runtime().api.registerInterceptor({id:'absence',origins:[origin]},{request(r){assert.equal(r.body,null);},response(r){assert.equal(r.body,null);}});
  const client=f.client();await client.ready;
  const response=await client.interceptHttp({url:origin+'/get',method:'GET',headers:[]},{forward:async r=>{assert.equal(r.body,null);return {status:204,headers:[]};}});
  assert.equal(response.status,204);await bodyBytes(response.body);await idle(f);
});

test('traffic URLs retain their 8 KiB contract across channels and delegated callbacks',async t=>{
  const origin=await listen(http.createServer((req,res)=>res.end(String(req.url.length))),t),f=await nativeTraffic(t,{origins:[origin]});
  const target=origin+'/?q='+'x'.repeat(7000);
  const channel=await f.runtime().api.openHttpChannel({},(_,exchange)=>exchange.forward({url:target}));
  assert.equal((await read(channel.endpoint)).body.toString(),'7004');await channel.close();
  await f.runtime().api.registerInterceptor({id:'long-url',origins:[origin]},{request(r){assert.equal(r.url,target);return {request:{url:target}};}});
  const client=f.client();await client.ready;
  const result=await client.interceptHttp({url:target,method:'GET',headers:[]},{forward:async r=>{assert.equal(r.url,target);return {status:204,headers:[]};}});
  assert.equal(result.status,204);await bodyBytes(result.body);await idle(f);
});

test('native explicit WS bridges before a handler waits for its close promise', {timeout:15000},async t=>{
  const server=http.createServer();const ws=new WebSocketServer({server});t.after(()=>{for(const socket of ws.clients)socket.terminate();ws.close();});
  ws.on('connection',socket=>socket.on('message',(data,binary)=>socket.send(data,{binary})));
  const origin=await listen(server,t);const f=await nativeTraffic(t,{origins:[origin],noIntercept:true});let ended;
  const finished=new Promise(resolve=>{ended=resolve;});
  const channel=await f.runtime().api.openChannel({}, {webSocket:async(_,exchange)=>{const bridge=await exchange.forward({url:origin.replace('http:','ws:')+'/echo'});await bridge.closed;ended();}});
  const socket=new WebSocket(channel.endpoint.replace('http:','ws:')+'/echo');t.after(()=>socket.terminate());
  await once(socket,'open');const next=once(socket,'message');socket.send('live');assert.equal((await next)[0].toString(),'live');
  const closed=once(socket,'close');socket.close(1000,'done');assert.equal((await closed)[0],1000);await finished;await channel.close();await idle(f);
});

test('native channels preserve WebSocket 426 so the caller can fall back to HTTP', {timeout:15000},async t=>{
  const origin=await listen(http.createServer((_req,res)=>{res.writeHead(426);res.end('use HTTP');}),t);
  const f=await nativeTraffic(t,{origins:[origin]});const channel=await f.runtime().api.openChannel({}, {webSocket:(_,exchange)=>exchange.forward({url:origin.replace('http:','ws:')+'/responses'})});
  const socket=new WebSocket(channel.endpoint.replace('http:','ws:')+'/responses');t.after(()=>socket.terminate());socket.on('error',()=>{});
  const status=await new Promise((resolve,reject)=>{socket.once('open',()=>reject(new Error('must reject upgrade')));socket.once('unexpected-response',(_req,res)=>{res.resume();resolve(res.statusCode);socket.terminate();});});
  assert.equal(status,426);await channel.close();await idle(f);
});

for (const trust of ['untrusted','profile','inherited']) test(`native HTTPS/WSS validate ${trust} CA trust`,{timeout:15000},async t=>{
  const trusted = trust !== 'untrusted';
  const ca=await readFile(new URL('./fixtures/traffic-tls/localhost-ca.pem',import.meta.url),'utf8');
  const cert=await readFile(new URL('./fixtures/traffic-tls/localhost-cert.pem',import.meta.url),'utf8');
  const key=await readFile(new URL('./fixtures/traffic-tls/localhost-key.pem',import.meta.url),'utf8');
  const server=https.createServer({key,cert},(_req,res)=>res.end('verified'));
  const ws=new WebSocketServer({server});t.after(()=>{for(const socket of ws.clients)socket.terminate();ws.close();});ws.on('connection',socket=>socket.on('message',(data,binary)=>socket.send(data,{binary})));
  const httpOrigin=await listen(server,t);const origin=httpOrigin.replace('http:','https:');
  const f=await nativeTraffic(t,{origins:[origin],environment:{NODE_TLS_REJECT_UNAUTHORIZED:'0',NODE_EXTRA_CA_CERTS:trust==='inherited'?fileURLToPath(new URL('./fixtures/traffic-tls/localhost-ca.pem',import.meta.url)):''}});
  const profile=trust==='profile'?(await f.call('services.network.createProfile',{proxy:'direct',caPem:ca})).profile:undefined;
  const channel=await f.runtime().api.openChannel({}, {http:(_,ex)=>ex.forward({url:origin,networkProfile:profile}),webSocket:(_,ex)=>ex.forward({url:origin.replace('https:','wss:'),networkProfile:profile})});
  const result=await read(channel.endpoint);assert.equal(result.status,trusted?200:502,result.body.toString()+' '+f.stderr());if(trusted)assert.equal(result.body.toString(),'verified');
  const socket=new WebSocket(channel.endpoint.replace('http:','ws:'));t.after(()=>socket.terminate());socket.on('error',()=>{});
  if(trusted){await once(socket,'open');const next=once(socket,'message');socket.send('secure');assert.equal((await next)[0].toString(),'secure');socket.close();}
  else{const status=await new Promise(resolve=>socket.once('unexpected-response',(_req,res)=>{res.resume();socket.terminate();resolve(res.statusCode);}));assert.equal(status,502);}
  await channel.close();await idle(f);
});

test('native request order, reversed response order and cancellation survive dynamic disable', {timeout:15000},async t=>{
  const origin=await listen(http.createServer((_req,res)=>res.end('upstream')),t);const f=await nativeTraffic(t,{origins:[origin]});const trace=[];const runtime=f.runtime();
  const last=await runtime.api.registerInterceptor({id:'last',origins:[origin],priority:10},{request(){trace.push('last:req');},response(){trace.push('last:res');}});
  const first=await runtime.api.registerInterceptor({id:'first',origins:[origin],priority:-10},{request(){trace.push('first:req');},response(){trace.push('first:res');}});
  const source=await runtime.api.openSource({upstreamBaseUrl:origin});assert.equal((await read(source.endpoint)).status,200);assert.deepEqual(trace,['first:req','last:req','last:res','first:res']);
  await first.setEnabled(false);trace.length=0;assert.equal((await read(source.endpoint)).status,200);assert.deepEqual(trace,['last:req','last:res']);
  await last.close();await first.close();await source.close();await idle(f);
});

test('native forwarding preserves repeated and Latin-1 headers, compressed bytes, HEAD and bodyless status', {timeout:15000},async t=>{
  const compressed=gzipSync('compress me');
  const origin=await listen(http.createServer((req,res)=>{
    res.writeHead(req.url==='/empty'?204:200,{'set-cookie':['a=1','b=2'],'x-latin':'caf\xe9','content-encoding':'gzip'});
    res.end(compressed);
  }),t);
  const f=await nativeTraffic(t),client=f.client();await client.ready;const route=client.reserveRoute({upstreamBaseUrl:origin});await route.ready;
  const raw=async(method,path)=>new Promise((resolve,reject)=>{
    const req=http.request(route.baseUrl+path,{method},async res=>{try{resolve({status:res.statusCode,headers:res.headers,body:await bodyBytes(res)});}catch(e){reject(e);}});req.on('error',reject);req.end();
  });
  const response=await raw('GET','/');assert.deepEqual(response.body,compressed);assert.deepEqual(response.headers['set-cookie'],['a=1','b=2']);assert.equal(response.headers['x-latin'],'caf\xe9');
  assert.equal((await raw('HEAD','/')).body.length,0);assert.equal((await raw('GET','/empty')).status,204);await route.close();await idle(f);
});

test('invalid ingress upgrades and CONNECT never reach an upstream', {timeout:15000},async t=>{
  let seen=0;const origin=await listen(http.createServer((_req,res)=>{seen++;res.end();}),t),f=await nativeTraffic(t);
  const client=f.client();await client.ready;const route=client.reserveRoute({upstreamBaseUrl:origin});await route.ready;const url=new URL(route.baseUrl);
  for(const [head,status] of [
    [`CONNECT example.invalid:443 HTTP/1.1\r\nHost: example.invalid:443`,405],
    [`GET ${url.pathname}/ HTTP/1.1\r\nHost: 127.0.0.1\r\nConnection: Upgrade\r\nUpgrade: h2c`,400],
    [`GET ${url.pathname}/ HTTP/1.1\r\nHost: 127.0.0.1\r\nConnection: Upgrade\r\nUpgrade: websocket\r\nSec-WebSocket-Key: invalid`,400],
  ]){
    const socket=net.connect(Number(url.port),url.hostname);t.after(()=>socket.destroy());await once(socket,'connect');
    const incoming=once(socket,'data');socket.write(head+'\r\n\r\n');assert((await incoming)[0].toString().startsWith('HTTP/1.1 '+status));socket.destroy();
  }
  assert.equal(seen,0);await route.close();await idle(f);
});

test('four simultaneous 64 MiB responses stream with bounded chunks', {timeout:60000},async t=>{
  const bytes=Buffer.alloc(32*1024,0x5a),maximum=64*1024*1024;let entered=0,release;
  const ready=new Promise(r=>release=r);t.after(()=>release());
  const server=http.createServer(async(_req,res)=>{entered++;if(entered===4)release();await ready;
    for(let sent=0;sent<maximum;sent+=bytes.length){if(!res.write(bytes))await once(res,'drain');}res.end();
  });
  const origin=await listen(server,t),f=await nativeTraffic(t),client=f.client();await client.ready;
  const route=client.reserveRoute({upstreamBaseUrl:origin});await route.ready;
  await Promise.all(Array.from({length:4},async()=>{
    const response=await fetch(route.baseUrl);assert.equal(response.status,200);let count=0;
    for await(const chunk of response.body){count+=chunk.length;assert.equal(chunk[0],0x5a);assert(chunk.length<=128*1024);}
    assert.equal(count,maximum);
  }));
  assert.equal(entered,4);await route.close();await idle(f);
});

test('8 MiB WebSocket binary frames retain full traffic callback support', {timeout:60000},async t=>{
  const server=http.createServer(),ws=new WebSocketServer({server});t.after(()=>{for(const socket of ws.clients)socket.terminate();ws.close();});
  ws.on('connection',socket=>socket.on('message',(data,binary)=>socket.send(data,{binary})));
  const origin=await listen(server,t),f=await nativeTraffic(t,{origins:[origin]});const runtime=f.runtime();
  await runtime.api.registerInterceptor({id:'large-frame',origins:[origin],timeoutMs:2000},{webSocket:()=>({clientToServer:frame=>frame,serverToClient:frame=>frame})});
  const source=await runtime.api.openSource({upstreamBaseUrl:origin}),socket=new WebSocket(source.endpoint.replace('http:','ws:'));t.after(()=>socket.terminate());await once(socket,'open');
  const bytes=Buffer.alloc(8*1024*1024,0x5a),next=once(socket,'message');socket.send(bytes);assert.deepEqual((await next)[0],bytes);
  const closed=once(socket,'close');socket.close();await closed;await source.close();await idle(f);
});
