import test from 'node:test';
import assert from 'node:assert/strict';
import http from 'node:http';
import https from 'node:https';
import net from 'node:net';
import { readFile } from 'node:fs/promises';
import { once } from 'node:events';
import { createRequire } from 'node:module';
const require = createRequire(import.meta.url);
const { createTrafficRuntime } = require('../runtime/host-traffic-bundle.cjs');
const { WebSocket, WebSocketServer } = require('../frontend/node_modules/ws');
const error = (code,message) => Object.assign(new Error(message),{code});
async function listen(server,t) {
  const sockets=new Set(); server.on('connection',s=>{sockets.add(s);s.on('close',()=>sockets.delete(s));});
  server.listen(0,'127.0.0.1'); await once(server,'listening');
  t.after(async()=>{for(const s of sockets)s.destroy();await new Promise(resolve=>server.close(resolve));});
  return `http://127.0.0.1:${server.address().port}`;
}
function read(url) {return new Promise((resolve,reject)=>http.get(url,response=>{let body='';response.on('data',part=>body+=part);response.on('end',()=>resolve({status:response.statusCode,body}));}).on('error',reject));}

test('network profile tunnels HTTPS and WSS with scoped CA and separates proxy/origin credentials',async t=>{
  const key=await readFile(new URL('fixtures/traffic-tls/localhost-key.pem',import.meta.url));
  const ca=await readFile(new URL('fixtures/traffic-tls/localhost-cert.pem',import.meta.url),'utf8');
  const received=[],connects=[];
  const upstream=https.createServer({key,cert:ca},(req,res)=>{received.push(req.headers);res.end('secure body');});
  const upstreamUrl=(await listen(upstream,t)).replace('http:','https:');
  const wsServer=new WebSocketServer({server:upstream});
  wsServer.on('connection',(ws,req)=>{received.push(req.headers);ws.send('welcome');ws.on('message',data=>ws.send(data));});
  const proxy=http.createServer();
  proxy.on('connect',(req,socket,head)=>{
    connects.push(req.headers);
    const port=Number(req.url.split(':').at(-1));
    const remote=net.connect(port,'127.0.0.1',()=>{socket.write('HTTP/1.1 200 Connection Established\r\n\r\n');if(head.length)remote.write(head);remote.pipe(socket);socket.pipe(remote);});
    socket.on('error',()=>remote.destroy());socket.on('close',()=>remote.destroy());remote.on('error',()=>socket.destroy());
  });
  const proxyUrl=await listen(proxy,t),root=new AbortController();
  let profileLive=true;
  const runtime=createTrafficRuntime({rootSignal:root.signal,makeError:error,async coreRequest(method,params){
    if(method==='host.network.authorizeChannel')return {};
    if(method==='host.network.authorizeForward')return {url:params.url};
    if(method==='services.network.resolve'){assert.equal(params.profile,'test-profile');if(!profileLive)throw error('resource_closed','profile retired');return {proxyUrl,caPem:ca,proxyCredentialRef:'proxy-key'};}
    if(method==='services.credentials.resolve'){
      if(params.reference==='proxy-key'){assert.equal(params.origin,proxyUrl);return {secret:'proxy-user:proxy-pass'};}
      assert.equal(params.reference,'origin-key');assert.equal(params.origin,upstreamUrl);return {secret:'origin-token'};
    }
    throw error('unexpected_method',method);
  }});
  const channel=await runtime.api.openChannel({handlerTimeoutMs:5000},{
    http:(_,exchange)=>exchange.forward({url:upstreamUrl+'/http',networkProfile:'test-profile',credentialRef:'origin-key'}),
    webSocket:(_,exchange)=>exchange.forward({url:upstreamUrl.replace('https:','wss:')+'/ws',networkProfile:'test-profile',credentialRef:'origin-key'}),
  });
  t.after(async()=>{root.abort();await channel.close();runtime.closeAll();});
  assert.deepEqual(await read(channel.endpoint+'/http'),{status:200,body:'secure body'});
  const ws=new WebSocket(channel.endpoint.replace('http:','ws:')+'/socket');
  const welcome=once(ws,'message');await once(ws,'open');assert.equal((await welcome)[0].toString(),'welcome');
  const echo=once(ws,'message');ws.send('through proxy');assert.equal((await echo)[0].toString(),'through proxy');
  ws.close();await once(ws,'close');
  assert.equal(connects.length,2);assert.equal(received.length,2);
  for(const headers of connects){assert.equal(headers['proxy-authorization'],'Basic '+Buffer.from('proxy-user:proxy-pass').toString('base64'));assert.equal(headers.authorization,undefined);}
  for(const headers of received){assert.equal(headers.authorization,'Bearer origin-token');assert.equal(headers['proxy-authorization'],undefined);}
  profileLive=false;assert.equal((await read(channel.endpoint+'/again')).status,502);assert.equal(connects.length,2,'retired profile must not fall back to direct');
});

test('cancelling a stalled proxy CONNECT closes its socket before the tunnel exists',async t=>{
  let opened,closed;const open=new Promise(r=>opened=r),close=new Promise(r=>closed=r);
  const proxy=http.createServer();proxy.on('connect',(_req,socket)=>{socket.on('close',closed);socket.on('end',()=>socket.end());socket.resume();opened();});
  const proxyUrl=await listen(proxy,t),root=new AbortController();
  const runtime=createTrafficRuntime({rootSignal:root.signal,makeError:error,async coreRequest(method,params){if(method==='host.network.authorizeChannel')return {};if(method==='host.network.authorizeForward')return {url:params.url};if(method==='services.network.resolve')return {proxyUrl};throw new Error(method);}});
  const channel=await runtime.api.openChannel({handlerTimeoutMs:5000},{http:(_,exchange)=>exchange.forward({url:'https://example.invalid/',networkProfile:'proxy'})});
  t.after(()=>runtime.closeAll());const response=read(channel.endpoint).catch(()=>{});await open;await channel.close();await Promise.race([close,new Promise((_,reject)=>setTimeout(()=>reject(new Error('proxy socket leaked')),1500))]);await response;
});
