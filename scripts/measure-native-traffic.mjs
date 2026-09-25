// Windows resource comparison of the real Core engine and an optional prior
// bundled worker from Git. Never launches or modifies the user's client.
// Build codlet-traffic-fixture with test-fixtures first. Outputs contain only
// resource counters; private routes, credentials and payloads are omitted.
import assert from 'node:assert/strict';
import http from 'node:http';
import { spawn, execFile } from 'node:child_process';
import { once } from 'node:events';
import { promisify } from 'node:util';
import { createRequire } from 'node:module';
import { nativeTraffic, idle } from '../tests/support/native-traffic.mjs';
const require=createRequire(import.meta.url),execute=promisify(execFile);
const {WebSocket,WebSocketServer}=require('../frontend/node_modules/ws');
const {connectPlaintextSource}=require('../runtime/plaintext-source-client.cjs');
const baseline=process.argv[2];
if(process.platform!=='win32')throw new Error('This sampler currently uses Windows process counters');
const tick=ms=>new Promise(r=>setTimeout(r,ms));
const results={schema:1,node:process.version,workload:{rounds:4,httpPerRound:1000,responseBytes:4096,webSocketFramesPerRound:200,webSocketFrameBytes:1024},cases:[]};
const server=http.createServer((_req,res)=>res.end(Buffer.alloc(4096,0x78))),sockets=new Set();
server.on('connection',socket=>{sockets.add(socket);socket.on('close',()=>sockets.delete(socket));});
const wss=new WebSocketServer({server});wss.on('connection',socket=>socket.on('message',(data,binary)=>socket.send(data,{binary})));
await new Promise(r=>server.listen(0,'127.0.0.1',r));const origin='http://127.0.0.1:'+server.address().port;
const agent=new http.Agent({keepAlive:true});
async function memory(pids){
  assert(pids.every(Number.isInteger));
  const command=`@(${pids.map(pid=>`Get-Process -Id ${pid}`).join(';')}) | Select-Object Id,WorkingSet64,PrivateMemorySize64,HandleCount,CPU | ConvertTo-Json -Compress`;
  const result=await execute('powershell.exe',['-NoProfile','-NonInteractive','-Command',command],{windowsHide:true,timeout:10000});
  const parsed=JSON.parse(result.stdout),processes=Array.isArray(parsed)?parsed:[parsed];
  return {processes,workingSet:processes.reduce((n,p)=>n+p.WorkingSet64,0),privateCommit:processes.reduce((n,p)=>n+p.PrivateMemorySize64,0),cpuSeconds:processes.reduce((n,p)=>n+p.CPU,0),handles:processes.reduce((n,p)=>n+p.HandleCount,0)};
}
async function request(url){return new Promise((resolve,reject)=>{const req=http.get(url,{agent},res=>{let size=0;res.on('data',chunk=>size+=chunk.length);res.on('error',reject);res.on('end',()=>{try{assert.equal(res.statusCode,200);assert.equal(size,4096);resolve();}catch(e){reject(e);}});});req.on('error',reject);req.setTimeout(5000,()=>req.destroy(new Error('fixture_request_timeout')));});}
try{
  for(const kind of baseline?['legacy','native']:['native'])for(const callbacks of [false,true]){
    const f=await nativeTraffic(null,{origins:[origin],engine:kind==='legacy'?'legacy':'off'});let worker,source,runtime,hook;
    const root=new AbortController(),item={kind,callbacks,samples:[],rounds:[]};results.cases.push(item);
    try{
      item.samples.push({stage:'core_without_engine',...await memory([f.pid])});
      if(kind==='legacy'){
        const code="process.once('message',async c=>{const root=new AbortController();try{const w=await require(c.bundle).startTrafficWorker({endpoint:c.endpoint},{signal:root.signal});process.on('disconnect',()=>{root.abort();w.close();});process.send({ready:true});}catch(e){process.send({error:e.code||'worker_failed'});process.exitCode=1;process.disconnect();}});";
        worker=spawn(process.execPath,['--max-semi-space-size=4','--eval',code],{windowsHide:true,stdio:['ignore','ignore','ignore','ipc'],env:{...process.env,NO_PROXY:'*',no_proxy:'*'}});
        const ready=once(worker,'message');worker.send({bundle:baseline,endpoint:f.gateway});assert.equal((await ready)[0].ready,true);
      }else await f.call('start');
      const descriptor=(await f.call('descriptor')).source;
      source=connectPlaintextSource(descriptor);await source.ready;const route=source.reserveRoute({upstreamBaseUrl:origin});await route.ready;
      if(callbacks){
        if(kind==='legacy'){
          // The old worker bundle exports only its worker. Its ordinary Host
          // companion is extracted alongside it for identical real callbacks.
          const companion=baseline.replace(/traffic-worker-bundle\.cjs$/,'host-traffic-bundle.cjs');
          runtime=require(companion).createTrafficRuntime({rootSignal:root.signal,makeError:code=>Object.assign(new Error(code),{code}),coreRequest:(method,params)=>f.call(method,params)});
        }else runtime=f.runtime();
        hook=await runtime.api.registerInterceptor({id:'noop',origins:[origin],timeoutMs:2000},{request:()=>null,response:()=>null,webSocket:()=>({})});
      }
      const pids=worker?[f.pid,worker.pid]:[f.pid];
      await tick(500);item.samples.push({stage:'cold',...await memory(pids)});
      for(let round=1;round<=4;round++){
        const times=[],start=performance.now();
        for(let n=0;n<1000;n++){const before=performance.now();await request(route.baseUrl+'/http');times.push(performance.now()-before);}
        const socket=new WebSocket(route.baseUrl.replace('http:','ws:')+'/echo');await once(socket,'open');
        for(let n=0;n<200;n++){const next=once(socket,'message');socket.send('x'.repeat(1024));assert.equal((await next)[0].length,1024);}
        const closed=once(socket,'close');socket.close();await closed;times.sort((a,b)=>a-b);
        item.rounds.push({round,elapsedMs:performance.now()-start,httpMedianMs:times[500],httpP95Ms:times[949]});
        await tick(100);item.samples.push({stage:'round_'+round,...await memory(pids)});
      }
      await tick(3000);item.samples.push({stage:'idle_after_load',...await memory(pids)});item.resources=await idle(f);
    }finally{
      try { await hook?.close(); } finally {
        runtime?.closeAll();root.abort();source?.close();
        try {
          if(worker&&worker.exitCode===null){const closed=once(worker,'exit');worker.disconnect();const timer=setTimeout(()=>worker.kill(),3000);await closed;clearTimeout(timer);}
        } finally { await f.close(); }
      }
    }
  }
}finally{agent.destroy();for(const socket of wss.clients)socket.terminate();wss.close();for(const socket of sockets)socket.destroy();await new Promise(r=>server.close(r));}
process.stdout.write(JSON.stringify(results,null,2)+'\n');
