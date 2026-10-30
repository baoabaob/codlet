import test from 'node:test';
import assert from 'node:assert/strict';
import {createRequire} from 'node:module';
import {mkdtemp,rm} from 'node:fs/promises';
import {tmpdir} from 'node:os';
import path from 'node:path';
import net from 'node:net';
const require=createRequire(import.meta.url);
const {connectPlaintextSource}=require('../runtime/plaintext-source-client.cjs');
const {startClientBridge}=require('../runtime/client-bridge-bundle.cjs');
const tick=()=>new Promise(resolve=>setImmediate(resolve));
const frame=value=>{const bytes=Buffer.from(JSON.stringify(value)),packet=Buffer.alloc(bytes.length+4);packet.writeUInt32BE(bytes.length);bytes.copy(packet,4);return packet;};
async function endpoint(t,{reject=false}={}) {
  const sockets=new Set(),events=[],routeBaseUrl='http://127.0.0.1:1/private-source';
  const server=net.createServer(socket=>{
    sockets.add(socket);events.push('accepted');let buffer=Buffer.alloc(0),authenticated=false;
    socket.on('error',()=>{});socket.on('close',()=>sockets.delete(socket));
    if(reject){socket.destroy();return;}
    socket.on('data',chunk=>{
      buffer=Buffer.concat([buffer,chunk]);
      while(buffer.length>=4&&buffer.length>=buffer.readUInt32BE(0)+4){
        const size=buffer.readUInt32BE(0),message=JSON.parse(buffer.subarray(4,4+size));buffer=buffer.subarray(4+size);
        if(!authenticated){assert.deepEqual(message,{token:'owned-fixture-token'});authenticated=true;events.push('authenticated');socket.write(frame({event:'connected'}));continue;}
        events.push(message.method);
        const result=message.method==='route.register'?{baseUrl:routeBaseUrl+'/'+message.params.token}:{};
        socket.write(frame({id:message.id,result}));
      }
    });
  });
  await new Promise(resolve=>server.listen(0,'127.0.0.1',resolve));
  t.after(async()=>{for(const socket of sockets)socket.destroy();await new Promise(resolve=>server.close(resolve));});
  return{events,descriptor:{version:1,kind:'plaintext',protocols:['http'],operations:['http.intercept'],routeBaseUrl,
    endpoint:{host:'127.0.0.1',port:server.address().port,token:'owned-fixture-token'}}};
}
test('deferred source keeps one ready promise and reservations without opening a socket',async t=>{
  const f=await endpoint(t),source=connectPlaintextSource(f.descriptor,{deferredStart:true});t.after(()=>source.close());
  const ready=source.ready,route=source.reserveRoute({upstreamBaseUrl:'https://fixture.invalid/v1'});let settled=false;ready.then(()=>settled=true);
  await tick();assert.deepEqual(f.events,[]);assert.equal(settled,false);assert.equal(source.status().started,false);
  assert.equal(source.start(),ready);assert.equal(source.start(),ready);await ready;await route.ready;
  assert.equal(f.events.filter(value=>value==='accepted').length,1);assert.equal(f.events.filter(value=>value==='route.register').length,1);
  await route.close();
});
for(const cancel of ['close','signal'])test(`deferred source ${cancel} before start settles queued work and never opens a socket`,async t=>{
  const f=await endpoint(t),controller=new AbortController(),source=connectPlaintextSource(f.descriptor,{deferredStart:true,signal:controller.signal});
  const ready=assert.rejects(source.ready,{code:'host_stopping'}),route=source.registerRoute({upstreamBaseUrl:'https://fixture.invalid'}),intercept=source.interceptHttp({url:'https://fixture.invalid/'},{forward(){assert.fail('retired Native request must not forward');}});
  const routeRejected=assert.rejects(route,{code:'host_stopping'}),interceptRejected=assert.rejects(intercept,{code:'host_stopping'});
  cancel==='signal'?controller.abort():source.close();assert.equal(source.start(),source.ready);await Promise.all([ready,routeRejected,interceptRejected]);await tick();
  assert.deepEqual(f.events,[]);assert.deepEqual(source.status(),{open:false,started:false,routes:0,exchanges:0});
});
test('actual wire rejection retains peer_closed instead of becoming a startup or retirement error',async t=>{
  const f=await endpoint(t,{reject:true}),source=connectPlaintextSource(f.descriptor);await assert.rejects(source.ready,{code:'peer_closed'});
  assert.equal(source.status().open,false);assert.equal(f.events.filter(value=>value==='accepted').length,1);
});
async function bridgeFixture(t,transport) {
  const directory=await mkdtemp(path.join(tmpdir(),'codlet-deferred-source-')),token='e'.repeat(48);let source,readyCalls=0;
  const bridge=startClientBridge({app:{isReady:()=>false,getAppPath:()=>directory}},{token,source:transport.descriptor},{
    identity:()=>({pid:process.pid,executable:process.execPath,type:'browser'}),
    load:()=>({installElectronTraffic(_electron,_configuration,context){source=context.resources.get('plaintextSource');source.ready.catch(()=>{});const route=source.reserveRoute({upstreamBaseUrl:'https://fixture.invalid/v1'});route.ready.catch(()=>{});return{
      async ready(){readyCalls++;await source.ready;return{installed:true,activatedSources:[],unsupportedSources:[]};},
      async close(){await route.ready.catch(()=>{});await route.close().catch(()=>{});},
    };}}),
  });
  t.after(async()=>{await bridge.close();assert.equal(path.dirname(path.resolve(directory)),path.resolve(tmpdir()));await rm(directory,{recursive:true});});
  await bridge.installInitial({owner:'dev.source-lifecycle',generation:1,code:'controlled-source',configuration:{}});
  return{bridge,token,source:()=>source,readyCalls:()=>readyCalls};
}
function command(endpoint,token,input){return new Promise((resolve,reject)=>{
  const socket=net.createConnection(endpoint.port,endpoint.host);let body='';socket.on('error',reject);socket.on('connect',()=>socket.write(JSON.stringify({...input,token})+'\n'));
  socket.on('data',bytes=>body+=bytes);socket.on('end',()=>{try{resolve(JSON.parse(body));}catch(error){reject(error);}});
});}
test('Native install, listening, endpoint and original readiness observers cannot start the source before authenticated ready',async t=>{
  const transport=await endpoint(t),f=await bridgeFixture(t,transport),bridgeEndpoint=await f.bridge.endpoint();await tick();
  assert.deepEqual(transport.events,[]);assert.equal(f.readyCalls(),0);assert.equal(f.source().status().started,false);
  const input={op:'ready',operationId:'same-owned-startup',expectedEpoch:0};
  const first=await command(bridgeEndpoint,f.token,input),repeated=await command(bridgeEndpoint,f.token,input);
  assert.equal(first.result.outcome,'applied');assert.deepEqual(repeated,first);assert.equal(f.readyCalls(),1);
  assert.equal(transport.events.filter(value=>value==='accepted').length,1);assert.equal(transport.events.filter(value=>value==='authenticated').length,1);
});
test('Native bridge retirement before ready settles source waiters without creating a socket or deadlocking cleanup',async t=>{
  const transport=await endpoint(t),f=await bridgeFixture(t,transport);await f.bridge.endpoint();await f.bridge.close();
  await assert.rejects(f.source().ready,{code:'host_stopping'});assert.equal(f.source().status().started,false);assert.equal(f.readyCalls(),0);assert.deepEqual(transport.events,[]);
});
