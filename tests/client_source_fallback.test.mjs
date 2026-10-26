import test from 'node:test';
import assert from 'node:assert/strict';
import {createRequire} from 'node:module';
const require=createRequire(import.meta.url);
const {listenTrafficPeer}=require('../runtime/traffic-wire.cjs');
const {installElectronTraffic}=require('../runtime/core-modules/client-source.cjs');
test('the packaged standalone fallback uses the current Native source for routes and streaming bodies',async t=>{
  const controller=new AbortController();let bytes=0,source;
  const routeBaseUrl='http://127.0.0.1:44001/private';
  const listener=await listenTrafficPeer({signal:controller.signal,handle:async(peer,method,params)=>{
    if(method==='route.register')return{baseUrl:`${routeBaseUrl}/${params.token}`};
    if(method==='route.close'||method==='http.release')return{closed:true};
    if(method==='http.intercept') {
      for(;;){const item=await peer.request('relay',{lease:params.exchange,operation:'stream.read',payload:params.request.body});if(item.done)break;const chunk=Buffer.from(item.bytes,'base64');assert(chunk.length<=32768);bytes+=chunk.length;}
      return {status:200,headers:[],body:null};
    }
    throw Error(`unexpected ${method}`);
  }});
  const configuration={deadlineUnixMs:Date.now()-1,source:{version:1,kind:'plaintext',endpoint:listener.endpoint,routeBaseUrl,protocols:['http','sse','webSocket'],operations:['route.register','route.update','route.close','http.intercept']}};
  const entry=installElectronTraffic({app:{isReady:()=>true}},configuration,{resources:new Map(),modules:{}},{diagnose(){},
    installBackend(input){source=input.source;return{inspect:()=>({available:false,reason:'child_unavailable'}),ready:async()=>({available:false}),ownsProcess:()=>false,close(){}};},
    installDesktop:()=>({inspect:()=>({available:true,taskConfigurationAvailable:false}),ready:async()=>({available:true}),close(){}})
  });
  t.after(async()=>{await entry.close();controller.abort();});
  await entry.ready();
  const routes=Array.from({length:100},(_,index)=>source.reserveRoute({upstreamBaseUrl:`http://127.0.0.1:44002/provider-${index}`}));
  await Promise.all(routes.map(route=>route.ready));assert.equal(source.status().routes,100);
  const chunk=Buffer.alloc(32768),body=(function*(){for(let i=0;i<2049;i++)yield chunk;})();
  const response=await source.interceptHttp({url:'http://127.0.0.1:44002/upload',method:'POST',body},{forward(){throw Error('unexpected upstream fallback');}});
  assert.equal(response.status,200);assert.equal(bytes,64*1024*1024+32768);assert.equal(source.status().exchanges,0);
});
