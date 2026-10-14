'use strict';
const fs=require('node:fs'),path=require('node:path'),http=require('node:http'),crypto=require('node:crypto');
const {AsyncResource}=require('node:async_hooks');
const capability={name:'compatibility.acceptance.host',api:1,scope:'runtime'};
let state;
const assert=(condition,message)=>{if(!condition)throw Error(message);};
const delay=ms=>new Promise(resolve=>setTimeout(resolve,ms));
async function wait(check,timeout=8000){const end=Date.now()+timeout;while(Date.now()<end){const value=await check();if(value)return value;await delay(40);}throw Error('Timed out waiting for a test resource');}
function fixture(root){
  try {
    const config=JSON.parse(fs.readFileSync(path.join(root,'fixture.json'),'utf8'));
    const parent=path.dirname(path.dirname(root));
    const url=new URL(config.baseUrl);
    const owned=fs.readFileSync(path.join(parent,'owner.txt'),'utf8')==='codlet-desktop-acceptance\n';
    return {autorun:owned&&config.autorun===true&&url.protocol==='http:'&&url.hostname==='127.0.0.1',baseUrl:url.origin,root:parent};
  }catch{return {autorun:false,baseUrl:null,root:null};}
}
function echoServer(){
  const server=http.createServer(async(req,res)=>{
    const chunks=[];let size=0;
    for await(const chunk of req){size+=chunk.length;if(size>65536){res.writeHead(413).end();return;}chunks.push(chunk);}
    if(req.url==='/auth'){res.writeHead(200,{'content-type':'application/json'}).end(JSON.stringify({matched:req.headers.authorization==='Bearer codlet-synthetic-secret'}));return;}
    if(req.url==='/sse'){res.writeHead(200,{'content-type':'text/event-stream'});res.write('data: first\n\n');await delay(30);res.end('data: second\n\n');return;}
    res.writeHead(200,{'content-type':'text/plain'}).end(Buffer.concat(chunks).toString()||'codlet-original-response');
  });
  server.on('upgrade',(req,socket)=>{
    const accept=crypto.createHash('sha1').update(req.headers['sec-websocket-key']+'258EAFA5-E914-47DA-95CA-C5AB0DC85B11').digest('base64');
    socket.write('HTTP/1.1 101 Switching Protocols\r\nUpgrade: websocket\r\nConnection: Upgrade\r\nSec-WebSocket-Accept: '+accept+'\r\n\r\n');
    let buffered=Buffer.alloc(0);
    socket.on('error',()=>{});
    socket.on('data',chunk=>{
      buffered=Buffer.concat([buffered,chunk]);
      while(buffered.length>=2){
        const opcode=buffered[0]&15,masked=!!(buffered[1]&128);let size=buffered[1]&127,offset=2;
        if(size===126){if(buffered.length<4)return;size=buffered.readUInt16BE(2);offset=4;}
        if(size===127||size>32768){socket.destroy();return;}
        if(buffered.length<offset+(masked?4:0)+size)return;
        const mask=masked?buffered.subarray(offset,offset+4):null;if(masked)offset+=4;
        const data=Buffer.from(buffered.subarray(offset,offset+size));if(mask)for(let i=0;i<data.length;i++)data[i]^=mask[i%4];
        buffered=buffered.subarray(offset+size);
        if(opcode===8){socket.end(Buffer.from([136,0]));return;}
        const header=size<126?Buffer.from([128|opcode,size]):Buffer.from([128|opcode,126,size>>8,size&255]);socket.write(Buffer.concat([header,data]));
      }
    });
  });
  return server;
}
async function websocket(url,text){
  return new Promise((resolve,reject)=>{
    const ws=new WebSocket(url),timer=setTimeout(()=>{ws.close();reject(Error('WebSocket fixture timeout'));},6000);
    ws.onopen=()=>ws.send(text);ws.onmessage=event=>{clearTimeout(timer);resolve(String(event.data));ws.close();};
    ws.onerror=()=>{clearTimeout(timer);reject(Error('WebSocket fixture failed'));};
  });
}
exports.activate=async context=>{
  const report={schema:1,version:context.plugin.version,generation:context.plugin.generation,phase:'idle',checks:[],coverage:'synthetic plugin-owned operations'};
  const ownership=fixture(context.root),s=context.services;
  const native={request:0,response:0,webSocket:0,clientFrames:0,serverFrames:0};
  state={context,report,ownership,alive:true,running:null,server:null,topic:null,native,nativeInterceptor:null,detached:new AsyncResource('codlet-functional-tests')};
  const owned=state;
  async function beginNative(){
  assert(ownership.autorun,'Native model checks require an owned loopback fixture');
  if(owned.nativeInterceptor)return native;
  owned.nativeInterceptor=await context.traffic.registerInterceptor({id:'owned-model',origins:[ownership.baseUrl]}, {
    async request(request){
      if(!request.url.endsWith('/responses'))return;
      native.request++;let body='';for await(const chunk of request.body)body+=Buffer.from(chunk).toString('utf8');
      const value=JSON.parse(body);value.model='codlet-intercepted-model';
      return {request:{headers:[...request.headers.filter(([key])=>key.toLowerCase()!=='content-length'),['x-codlet-acceptance','modified']],body:JSON.stringify(value).replaceAll('codlet-original-request','codlet-modified-request')}};
    },
    response(response){native.response++;return {headers:(response.headers??[]).filter(([key])=>key.toLowerCase()!=='content-length'),body:(async function*(){for await(const chunk of response.body??[])yield Buffer.from(chunk).toString('utf8').replaceAll('codlet-original-response','codlet-modified-response');})()};},
    webSocket(request){native.webSocket++;return {
      request:{headers:[...request.headers,['x-codlet-acceptance','modified']]},
      clientToServer(frame){native.clientFrames++;const value=JSON.parse(typeof frame.data==='string'?frame.data:Buffer.from(frame.data).toString('utf8'));value.model='codlet-intercepted-model';return JSON.stringify(value).replaceAll('codlet-original-request','codlet-modified-request');},
      serverToClient(frame){native.serverFrames++;return (typeof frame.data==='string'?frame.data:Buffer.from(frame.data).toString('utf8')).replaceAll('codlet-original-response','codlet-modified-response');}
    };},
  });
  return native;
  }
  const save=()=>fs.writeFileSync(path.join(context.root,'host-report.json'),JSON.stringify(report,null,2));
  async function check(id,fn){if(!owned.alive)throw Error('Test retired');const started=Date.now();try{const detail=await fn();report.checks.push({id,status:'passed',milliseconds:Date.now()-started,detail});}catch(error){report.checks.push({id,status:'failed',milliseconds:Date.now()-started,error:{code:error.code??'test_failed',message:error.message}});}if(owned.alive)save();}
  const authorize=invocation=>assert(invocation.caller.pluginId===context.plugin.id,'Only the test plugin may invoke its Host');
  context.rpc.provide(capability,'native.begin',async(_args,invocation)=>{authorize(invocation);return beginNative();});
  context.rpc.provide(capability,'inspect',(_args,invocation)=>{authorize(invocation);return {fixture:ownership,report,native};});
  context.rpc.provide(capability,'save-report',(args,invocation)=>{
    authorize(invocation);const result=args?.report;
    assert(result?.schema===1&&result.version===context.plugin.version&&result.generation===context.plugin.generation&&['complete','failed'].includes(result.phase),'Only this generation may save a completed report');
    const text=JSON.stringify(result,null,2);assert(Buffer.byteLength(text)<=65536,'Functional report exceeds its size limit');
    fs.writeFileSync(path.join(context.root,'functional-report.json'),text+'\n');return {saved:true};
  });
  context.rpc.provide(capability,'echo',(args,invocation)=>{authorize(invocation);return {value:args.value,hostGeneration:context.plugin.generation};});
  context.rpc.provide(capability,'events',async(_args,invocation)=>{
    authorize(invocation);if(!owned.topic)owned.topic=await s.events.createTopic({name:'cross-world',maxEvents:8});
    await s.events.publish({topic:owned.topic.topic,event:{marker:'host-to-renderer'}});return owned.topic;
  });
  context.rpc.provide(capability,'run',async(_args,invocation)=>{
    authorize(invocation);if(owned.running)return report;
    report.phase='running';report.checks=[];
    // Detach work from the short observing RPC: tasks and network streams retain
    // their own bounded lifetimes when the page leaves or the RPC returns.
    owned.running=owned.detached.runInAsyncScope(()=>new Promise(resolve=>setTimeout(resolve,0)).then(async()=>{
      await check('host.system',async()=>{const info=await context.system.info();assert(info.logicalCpus>0,'Missing system information');return {os:info.os,architecture:info.architecture};});
      await check('storage.transaction-and-conflict',async()=>{
        const before=await s.storage.snapshot(),key='test-'+crypto.randomUUID();
        const saved=await s.storage.transaction({expectedRevision:before.revision,operations:[{op:'set',key,value:{marker:'synthetic',unicode:'中文'}}]});
        try{assert((await s.storage.get({key})).value.unicode==='中文','Stored value changed');
          let rejected=false;try{await s.storage.transaction({expectedRevision:before.revision,operations:[{op:'set',key,value:'wrong'}]});}catch(e){rejected=e.code==='storage_conflict';}assert(rejected,'A stale write was accepted');
          const changes=await s.storage.changes({afterCursor:before.cursor});assert(changes.changes.some(change=>change.keys.includes(key)),'Storage change missing');return {revision:saved.revision};
        }finally{const now=await s.storage.snapshot();await s.storage.transaction({expectedRevision:now.revision,operations:[{op:'remove',key}]});}
      });
      await check('events.replay-and-close',async()=>{
        const topic=await s.events.createTopic({name:'test-'+crypto.randomUUID(),maxEvents:4}),subscription=await s.events.subscribe({topic:topic.topic,after:topic.cursor});
        try{await s.events.publish({topic:topic.topic,event:{marker:'event'}});const batch=await s.events.read({subscription:subscription.subscription,after:topic.cursor});assert(batch.events[0]?.value.marker==='event','Event did not arrive');await s.events.ack({subscription:subscription.subscription,cursor:batch.cursor});return {received:batch.events.length};}
        finally{await s.events.close({resource:subscription.subscription});await s.events.close({resource:topic.topic});}
      });
      await check('tasks.progress-idempotency-and-cancellation',async()=>{
        const runner=await s.tasks.register('fixture-'+crypto.randomUUID(),async(input,task)=>{await task.progress({started:true});if(input.wait){await new Promise((resolve,reject)=>{const timer=setTimeout(resolve,3000);task.signal.addEventListener('abort',()=>{clearTimeout(timer);reject(task.signal.reason);},{once:true});});}return {value:input.value};});
        try{const args={input:{value:17},operationKey:crypto.randomUUID(),timeoutMs:5000},first=await runner.start(args),again=await runner.start(args);assert(first.task===again.task,'Operation key replay created another task');
          const done=await wait(async()=>{const value=await s.tasks.get({task:first.task});return value.terminal&&value;});assert(done.state==='succeeded'&&done.result.value===17,'Task result changed');
          const waiting=await runner.start({input:{wait:true,value:0},operationKey:crypto.randomUUID(),timeoutMs:5000});await wait(async()=>(await s.tasks.get({task:waiting.task})).state==='running');await s.tasks.cancel({task:waiting.task});
          const cancelled=await wait(async()=>{const value=await s.tasks.get({task:waiting.task});return value.terminal&&value;});assert(cancelled.state==='cancelled','Task ignored cancellation');return {result:done.state,cancellation:cancelled.state};
        }finally{await runner.close();}
      });
      await check('files.atomic-read-watch-and-cleanup',async()=>{
        const file=path.join(context.root,'synthetic-'+crypto.randomUUID()+'.txt'),data=Buffer.from('Codlet 中文 fixture').toString('base64');let watch;
        try{const created=await s.files.writeAtomic({path:file,expectedVersion:null,data});watch=await s.files.watch({path:file});
          assert(Buffer.from((await s.files.read({path:file,maxBytes:4096})).data,'base64').toString()==='Codlet 中文 fixture','Read bytes changed');
          const legacy=await context.fs.readText({path:file,maxBytes:4096});assert(legacy.text==='Codlet 中文 fixture','Legacy broker read changed');
          const replaced=await s.files.writeAtomic({path:file,expectedVersion:created.version,data:Buffer.from('updated fixture').toString('base64')});
          await wait(async()=>{const changes=await s.files.changes({watch:watch.watch,after:watch.cursor});return changes.events.length;},6000);
          let denied=false;try{await s.files.writeAtomic({path:file,expectedVersion:created.version,data});}catch{denied=true;}assert(denied,'Stale file version accepted');return {bytes:replaced.bytesWritten,watch:true};
        }finally{if(watch)await s.files.unwatch({watch:watch.watch});if(fs.existsSync(file)){const meta=await s.files.stat({path:file});await s.files.remove({path:file,expectedVersion:meta.version});}}
      });
      await check('processes.streaming-and-receipts',async()=>{
        const processInfo=await s.processes.start({executable:process.execPath,args:['-e','process.stdin.on("data",chunk=>process.stdout.write(chunk));process.stdin.on("end",()=>process.stderr.write("done"));'],stdin:'pipe',operationKey:crypto.randomUUID()});
        try{const params={process:processInfo.process,bytes:Buffer.from('fixture input'),sequence:'0'},first=await s.processes.write(params),again=await s.processes.write(params);assert(first.nextSequence===again.nextSequence&&again.replayedReceipt,'Stdin replay did not return its receipt');await s.processes.endInput({process:processInfo.process});
          let output='',errors='';await wait(async()=>{output+=Buffer.from((await s.processes.read({process:processInfo.process,stream:'stdout',waitMs:50})).bytes).toString();errors+=Buffer.from((await s.processes.read({process:processInfo.process,stream:'stderr',waitMs:50})).bytes).toString();return (await s.processes.status({process:processInfo.process})).workerDone;});
          assert(output==='fixture input'&&errors==='done','Process stream duplicated or lost data');return {outputBytes:output.length};
        }finally{await s.processes.close({process:processInfo.process});}
      });
      if(!owned.alive)throw Error('Test retired');owned.server=echoServer();await new Promise(resolve=>owned.server.listen(0,'127.0.0.1',resolve));
      const origin='http://127.0.0.1:'+owned.server.address().port;
      await check('network.direct-profile-fetch-and-credentials',async()=>{
        const profile=await s.network.createProfile({proxy:'direct'});let credential;
        try{const route=await s.network.resolve({url:origin+'/echo',profile:profile.profile});assert(route.source==='direct'&&!route.proxyUrl,'Direct profile unexpectedly uses a proxy');
          const response=await s.network.fetch({url:origin+'/echo',profile:profile.profile,method:'POST',data:Buffer.from('network fixture').toString('base64'),maxBytes:4096});assert(response.status===200&&Buffer.from(response.data,'base64').toString()==='network fixture','Core network response changed');
          const before=await s.credentials.list({origin});credential=await s.credentials.put({expectedRevision:before.revision,origin,label:'Temporary functional test',secret:'codlet-synthetic-secret'});
          const metadata=await s.credentials.metadata({reference:credential.credential.reference});assert(!JSON.stringify(metadata).includes('codlet-synthetic-secret'),'Credential metadata exposed the secret');
          const authenticated=await s.network.fetch({url:origin+'/auth',profile:profile.profile,credentialRef:credential.credential.reference,maxBytes:4096});assert(JSON.parse(Buffer.from(authenticated.data,'base64')).matched,'Credential dispatch failed');return {status:response.status,credentialBound:true};
        }finally{if(credential){const latest=await s.credentials.list({origin});await s.credentials.remove({reference:credential.credential.reference,expectedRevision:latest.revision});}await s.network.closeProfile({profile:profile.profile});}
      });
      await check('traffic.channel-http-sse-and-websocket',async()=>{
        const channel=await context.traffic.openChannel({}, {
          http:async(request,exchange)=>{const response=await exchange.forward({url:origin+request.path,method:request.method,body:request.method==='POST'?request.body:null});return {status:response.status,headers:response.headers,body:response.body};},
          webSocket:async(_request,exchange)=>{await exchange.forward({url:origin.replace('http:','ws:')+'/echo'});},
        });
        try{const httpResponse=await fetch(channel.endpoint+'/echo',{method:'POST',body:'channel fixture'});assert(await httpResponse.text()==='channel fixture','Channel HTTP changed');const stream=await fetch(channel.endpoint+'/sse');assert((await stream.text()).includes('data: second'),'SSE stream truncated');assert(await websocket(channel.endpoint.replace('http:','ws:')+'/echo','websocket fixture')==='websocket fixture','WebSocket bridge changed');return {http:true,sse:true,websocket:true};}
        finally{await channel.close();}
      });
      await check('traffic.interception-own-source',async()=>{
        const interceptor=await context.traffic.registerInterceptor({id:'fixture',origins:[origin]}, {
          request:()=>({respond:{status:200,headers:[['content-type','text/plain']],body:'synthetic interceptor response'}}),
          response:()=>({status:201,headers:[['content-type','text/plain']],body:'codlet-intercepted-response'}),
          webSocket:()=>({clientToServer:frame=>'intercepted '+String(frame.data),serverToClient:frame=>String(frame.data)+' transformed'}),
        });
        const source=await context.traffic.openSource({upstreamBaseUrl:origin});
        try{const response=await fetch(source.endpoint+'/echo'),body=await response.text();assert(response.status===201&&body==='codlet-intercepted-response',`HTTP interceptor did not execute (${response.status}, ${body.slice(0,80)})`);const text=await websocket(source.endpoint.replace('http:','ws:')+'/echo','frame');assert(text==='intercepted frame transformed','WebSocket transforms did not execute');return {http:true,websocket:true,nativeCoverage:'reported separately'};}
        finally{await source.close();await interceptor.close();}
      });
      await check('management.read-and-resources',async()=>{
        const snapshot=await context.rpc.request({name:'codlet.runtime.manage',api:1,scope:'runtime'},'list',null);assert(snapshot,'Management list missing');
        const resources=await s.resources.list(),diagnostics=await s.diagnostics.read();assert(Number.isSafeInteger(diagnostics.cursor),'Diagnostic cursor invalid');
        const traffic=await context.traffic.inspect();return {managed:true,resourceGroups:Object.keys(resources),traffic:{attached:traffic.attached,activatedSources:traffic.activatedSources?.map(item=>({id:item.id,protocols:item.protocols})),unsupportedSources:traffic.unsupportedSources}};
      });
      if(owned.server){owned.server.closeAllConnections();await new Promise(resolve=>owned.server.close(resolve));owned.server=null;}
      report.phase=report.checks.some(item=>item.status==='failed')?'failed':'complete';save();owned.running=null;
    })).catch(error=>{report.phase='failed';report.error=error.message;save();owned.running=null;});
    return report;
  });
  save();
};
exports.deactivate=async()=>{
  const owned=state;state=null;if(!owned)return;owned.alive=false;
  if(owned.topic)await owned.context.services.events.close({resource:owned.topic.topic}).catch(()=>{});
  if(owned.nativeInterceptor)await owned.nativeInterceptor.close().catch(()=>{});
  if(owned.server){owned.server.closeAllConnections();owned.server.close();}
  owned.detached.emitDestroy();
  fs.writeFileSync(path.join(owned.context.root,'cleanup.json'),JSON.stringify({generation:owned.context.plugin.generation,retired:true}));
};
