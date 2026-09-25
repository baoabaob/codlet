import test from 'node:test';
import assert from 'node:assert/strict';
import http from 'node:http';
import https from 'node:https';
import net from 'node:net';
import {readFile} from 'node:fs/promises';
import {once} from 'node:events';
import {createRequire} from 'node:module';
import {nativeTraffic,listen,read,idle} from './support/native-traffic.mjs';
const {WebSocket,WebSocketServer}=createRequire(import.meta.url)('../frontend/node_modules/ws');
const tick=ms=>new Promise(r=>setTimeout(r,ms));

test('native profiles tunnel HTTPS/WSS with scoped trust and separate proxy/origin credentials',{timeout:15000},async t=>{
  const [key,cert,ca]=await Promise.all(['localhost-key.pem','localhost-cert.pem','localhost-ca.pem'].map(n=>readFile(new URL('./fixtures/traffic-tls/'+n,import.meta.url),'utf8')));
  const received=[],connects=[];const server=https.createServer({key,cert},(req,res)=>{received.push(req.headers);res.end('secure');});
  const origin=(await listen(server,t)).replace('http:','https:');const wss=new WebSocketServer({server});t.after(()=>{for(const s of wss.clients)s.terminate();wss.close();});
  wss.on('connection',(socket,req)=>{received.push(req.headers);socket.on('message',(bytes,binary)=>socket.send(bytes,{binary}));});
  const proxy=http.createServer();proxy.on('connect',(req,socket,head)=>{
    connects.push(req.headers);const remote=net.connect(Number(req.url.split(':').at(-1)),'127.0.0.1',()=>{socket.write('HTTP/1.1 200 Connection Established\r\n\r\n');if(head.length)remote.write(head);socket.pipe(remote);remote.pipe(socket);});
    socket.on('error',()=>remote.destroy());socket.on('close',()=>remote.destroy());remote.on('error',()=>socket.destroy());
  });
  const proxyUrl=await listen(proxy,t),f=await nativeTraffic(t,{origins:[origin,proxyUrl]});
  // The debug-only fixture uses an in-memory credential backend.
  const originKey=await f.call('services.credentials.put',{expectedRevision:0,origin,secret:'origin-token'});
  const proxyKey=await f.call('services.credentials.put',{expectedRevision:1,origin:proxyUrl,secret:'proxy-user:proxy-pass'});
  const {profile}=await f.call('services.network.createProfile',{proxy:{url:proxyUrl,credentialRef:proxyKey.credential.reference},caPem:ca});
  const channel=await f.runtime().api.openChannel({}, {
    http:(_,ex)=>ex.forward({url:origin+'/http',networkProfile:profile,credentialRef:originKey.credential.reference}),
    webSocket:(_,ex)=>ex.forward({url:origin.replace('https:','wss:')+'/ws',networkProfile:profile,credentialRef:originKey.credential.reference}),
  });
  assert.equal((await read(channel.endpoint)).body.toString(),'secure');
  const ws=new WebSocket(channel.endpoint.replace('http:','ws:'));t.after(()=>ws.terminate());await once(ws,'open');const next=once(ws,'message');ws.send('proxy');assert.equal((await next)[0].toString(),'proxy');const closed=once(ws,'close');ws.close();await closed;
  assert.equal(connects.length,2);assert.equal(received.length,2);
  for(const headers of connects){assert.equal(headers['proxy-authorization'],'Basic '+Buffer.from('proxy-user:proxy-pass').toString('base64'));assert.equal(headers.authorization,undefined);}
  for(const headers of received){assert.equal(headers.authorization,'Bearer origin-token');assert.equal(headers['proxy-authorization'],undefined);}
  await f.call('services.network.closeProfile',{profile});assert.equal((await read(channel.endpoint)).status,502);assert.equal(connects.length,2);
  await channel.close();await idle(f);
});

test('cancelling a stalled CONNECT closes the proxy socket before any tunnel exists',{timeout:15000},async t=>{
  let enter,end;const entered=new Promise(r=>enter=r),ended=new Promise(r=>end=r);
  const proxy=http.createServer();proxy.on('connect',(_req,socket)=>{socket.on('close',end);socket.on('end',()=>socket.end());socket.resume();enter();});
  const proxyUrl=await listen(proxy,t),f=await nativeTraffic(t,{origins:[proxyUrl,'https://example.invalid']});
  const {profile}=await f.call('services.network.createProfile',{proxy:{url:proxyUrl}});
  const channel=await f.runtime().api.openChannel({}, {http:(_,ex)=>ex.forward({url:'https://example.invalid',networkProfile:profile})});
  const pending=read(channel.endpoint).catch(()=>null);await entered;await channel.close();
  await Promise.race([ended,tick(1500).then(()=>assert.fail('CONNECT socket survived cancellation'))]);await pending;await idle(f);
});

for(const kind of ['http','webSocket'])test(`cancelled ${kind} forwarding creates no upstream connection`,{timeout:15000},async t=>{
  let connected=0;const server=http.createServer((_req,res)=>res.end('unexpected'));server.on('connection',()=>connected++);
  const origin=await listen(server,t),f=await nativeTraffic(t,{origins:[origin]});
  const channel=await f.runtime().api.openChannel({}, {[kind]:async(_req,ex)=>{ex.cancel();await assert.rejects(ex.forward({url:kind==='http'?origin:origin.replace('http:','ws:')}),{code:'request_cancelled'});return {status:204};}});
  if(kind==='http')await read(channel.endpoint).catch(()=>null);else{
    const socket=new WebSocket(channel.endpoint.replace('http:','ws:'));socket.on('error',()=>{});t.after(()=>socket.terminate());
    await new Promise(resolve=>{socket.on('unexpected-response',(_req,res)=>{res.resume();socket.terminate();resolve();});socket.on('error',resolve);});
  }
  assert.equal(connected,0);await channel.close();await idle(f);
});

test('native transparent forwarding preserves environment proxy and NO_PROXY routing',{timeout:15000},async t=>{
  let direct=0,proxied=0;const origin=await listen(http.createServer((_req,res)=>{direct++;res.end('direct');}),t);
  const proxyUrl=await listen(http.createServer((req,res)=>{assert(req.url.startsWith(origin));proxied++;res.end('proxy');}),t);
  for(const bypass of [false,true]){
    const f=await nativeTraffic(t,{environment:{HTTP_PROXY:proxyUrl,http_proxy:proxyUrl,NO_PROXY:bypass?'127.0.0.1':'',no_proxy:bypass?'127.0.0.1':''}});
    const client=f.client();await client.ready;const route=client.reserveRoute({upstreamBaseUrl:origin});await route.ready;
    assert.equal((await read(route.baseUrl)).body.toString(),bypass?'direct':'proxy');await f.close();
  }
  assert.equal(direct,1);assert.equal(proxied,1);
});
