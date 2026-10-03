'use strict';
// Core bootstrap uses Electron's public fuse schema and Node inspector protocol.
// Application fingerprints and private bindings remain in ordinary plugins.
const fs=require('node:fs'),path=require('node:path'),net=require('node:net');
const {createHash,randomBytes}=require('node:crypto');
const fail=code=>Object.assign(new Error(code),{code});
const SENTINEL=Buffer.from('dL7pKGdnNz796PbbjQWNKmHXBZaB9tsX');
async function plan(executable) {
  if(process.platform!=='win32')return {moduleData:null};
  const root=path.dirname(fs.realpathSync(executable)),dll=path.join(root,'chrome.dll');
  const image=fs.existsSync(dll)?dll:executable,info=fs.statSync(image);
  if(!info.isFile()||info.size<64||info.size>512*1024*1024)throw fail('client_bridge_image_invalid');
  let tail=Buffer.alloc(0),consumed=0;const hash=createHash('sha256'),matches=[];
  for await(const chunk of fs.createReadStream(image,{highWaterMark:256*1024})) {
    hash.update(chunk);const bytes=Buffer.concat([tail,chunk]);
    for(let at=bytes.indexOf(SENTINEL);at!==-1;at=bytes.indexOf(SENTINEL,at+1)) {
      const count=bytes[at+SENTINEL.length+1],end=at+SENTINEL.length+2+count;
      if(end>bytes.length)continue;
      const offset=consumed-tail.length+at;
      if(matches.some(match=>match.offset===offset))continue;
      matches.push({offset,version:bytes[at+SENTINEL.length],wire:bytes.toString('ascii',at+SENTINEL.length+2,end)});
      if(matches.length>1)throw fail('client_bridge_fuse_ambiguous');
    }
    consumed+=chunk.length;tail=Buffer.from(bytes.subarray(-100));
  }
  if(consumed!==info.size)throw fail('client_bridge_image_changed');
  if(matches.length!==1)throw fail('client_bridge_fuse_unsupported');
  const fuse=matches[0];
  if(fuse.version!==1||fuse.wire.length<4||fuse.wire.length>64||!/^[01r]+$/.test(fuse.wire)||fuse.wire[3]==='r')throw fail('client_bridge_fuse_unsupported');
  return {moduleData:fuse.wire[3]==='1'?null:{module:path.basename(image),sha256:hash.digest('hex'),patches:[{fileOffset:fuse.offset+SENTINEL.length+5,expected:[48],replacement:[49]}]}};
}
function sameExecutable(expected,observed) {
  if(typeof observed!=='string'||!path.isAbsolute(observed))return false;
  try{const a=fs.statSync(expected,{bigint:true}),b=fs.statSync(observed,{bigint:true});return a.isFile()&&b.isFile()&&a.ino!==0n&&a.ino===b.ino&&a.dev===b.dev;}catch{return false;}
}
function consumeInspector(process,electron) {
  const flag='--inspect-brk=127.0.0.1:0',at=process.execArgv.indexOf(flag);
  if(at>=0)process.execArgv.splice(at,1);
  if(electron.app.commandLine?.getSwitchValue('inspect-brk')==='127.0.0.1:0')electron.app.commandLine.removeSwitch('inspect-brk');
  const threads=require('node:worker_threads'),Worker=threads.Worker;
  let wrapper;wrapper=new Proxy(Worker,{construct(target,args,newTarget){if(args[1]?.execArgv===undefined)args=[args[0],{...args[1],execArgv:[...process.execArgv]}];return Reflect.construct(target,args,newTarget===wrapper?target:newTarget);}});threads.Worker=wrapper;
  if(electron.utilityProcess?.fork){const fork=electron.utilityProcess.fork;electron.utilityProcess.fork=function(module,args,options){if(options?.execArgv===undefined)options={...options,execArgv:[...process.execArgv]};return fork.call(this,module,args,options);};}
}
async function attach(context,source) {
  const url=new URL(context.inspectorUrl);
  if(url.protocol!=='ws:'||url.hostname!=='127.0.0.1'||!url.port||url.username||url.password||url.search||url.hash||!/^\/[a-f0-9-]{36}$/.test(url.pathname))throw fail('client_bridge_inspector_invalid');
  const token=randomBytes(24).toString('hex'),key=JSON.stringify('codlet.client.bridge.'+token);
  const ws=new WebSocket(url),pending=new Map();let sequence=0,frame,pauseResolve,abort;
  const aborted=new Promise((_,reject)=>abort=reject);
  aborted.catch(()=>{});
  const wait=promise=>Promise.race([promise,aborted]);
  ws.addEventListener('close',()=>abort(fail('client_bridge_inspector_closed')));
  ws.addEventListener('error',()=>abort(fail('client_bridge_inspector_unavailable')));
  const paused=new Promise(resolve=>pauseResolve=resolve);
  ws.addEventListener('message',event=>{let msg;try{msg=JSON.parse(event.data);}catch{return;}
    if(msg.method==='Debugger.paused'){frame=msg.params?.callFrames?.[0];pauseResolve();}
    const call=pending.get(msg.id);if(!call)return;pending.delete(msg.id);clearTimeout(call.timer);msg.error?call.reject(fail('client_bridge_inspector_protocol')):call.resolve(msg.result);});
  function request(method,params={}){return wait(new Promise((resolve,reject)=>{
    if(ws.readyState!==WebSocket.OPEN){reject(fail('client_bridge_inspector_closed'));return;}
    const id=++sequence,timer=setTimeout(()=>{pending.delete(id);reject(fail('client_bridge_inspector_timeout'));},10000);
    pending.set(id,{resolve,reject,timer});
    try{ws.send(JSON.stringify({id,method,params}));}catch{clearTimeout(timer);pending.delete(id);reject(fail('client_bridge_inspector_closed'));}
  }));}
  const timeout=setTimeout(()=>{abort(fail('client_bridge_inspector_timeout'));ws.close();},14500);
  let activation;
  try {
    await wait(new Promise(resolve=>ws.addEventListener('open',resolve,{once:true})));
    await request('Debugger.enable');await request('Runtime.runIfWaitingForDebugger');await wait(paused);
    if(!frame)throw fail('client_bridge_inspector_not_paused');
    const identity=await request('Debugger.evaluateOnCallFrame',{callFrameId:frame.callFrameId,expression:"({pid:process.pid,executable:process.execPath,type:process.type,ready:require('electron').app.isReady()})",returnByValue:true});
    const value=identity.result?.value;
    if(identity.exceptionDetails||value?.pid!==context.expectedPid||!sameExecutable(context.executable,value.executable)||value.type!=='browser'||value.ready!==false)throw fail('client_bridge_identity_mismatch');
    const expression=`(() => { const electron=require('electron');(${consumeInspector.toString()})(process,electron);const module={exports:{}};((module,exports,require)=>{${source}\n})(module,module.exports,require);const bridge=module.exports.startClientBridge(electron,${JSON.stringify({token,source:context.traffic.source})});globalThis[Symbol.for(${key})]=bridge;${context.selection?`bridge.installInitial(${JSON.stringify(context.selection)}).catch(()=>{});`:''}return true;})()`;
    const installed=await request('Debugger.evaluateOnCallFrame',{callFrameId:frame.callFrameId,expression,returnByValue:true});
    if(installed.exceptionDetails||installed.result?.value!==true)throw fail('client_bridge_install_failed');
    await request('Debugger.resume');
    const resultKey=JSON.stringify('codlet.client.bridge.ready.'+token);
    await request('Runtime.evaluate',{expression:`globalThis[Symbol.for(${key})].ready().then(async status=>{globalThis[Symbol.for(${resultKey})]={status,bridge:await globalThis[Symbol.for(${key})].endpoint()};},()=>{globalThis[Symbol.for(${resultKey})]={error:true};});true`,returnByValue:true});
    let result;
    const until=Date.now()+11000;
    while(Date.now()<until){const reply=await request('Runtime.evaluate',{expression:`globalThis[Symbol.for(${resultKey})]`,returnByValue:true});result=reply.result?.value;if(result?.error)throw fail('client_bridge_ready_failed');if(result?.bridge)break;await new Promise(resolve=>setTimeout(resolve,25));}
    if(!result?.bridge)throw fail('client_bridge_ready_timeout');
    await request('Runtime.evaluate',{expression:`delete globalThis[Symbol.for(${resultKey})];globalThis[Symbol.for(${key})].closeInspector()`,returnByValue:true});
    activation={installed:true,exactChildVerified:true,bridge:result.bridge,epoch:result.status.epoch,activation:result.status.activation};
  } finally {clearTimeout(timeout);for(const call of pending.values()){clearTimeout(call.timer);call.reject(fail('client_bridge_inspector_closed'));}pending.clear();ws.close();}
  const until=Date.now()+1500;let closed=false;
  while(Date.now()<until){closed=await new Promise(resolve=>{const peer=net.createConnection({host:'127.0.0.1',port:Number(url.port)});const finish=value=>{peer.destroy();resolve(value);};peer.once('connect',()=>finish(false));peer.once('error',error=>finish(error.code==='ECONNREFUSED'));peer.setTimeout(100,()=>finish(false));});if(closed)break;await new Promise(resolve=>setTimeout(resolve,25));}
  if(!closed)throw fail('client_bridge_inspector_detach_failed');
  return activation;
}
if(require.main===module) {
  const source=fs.readFileSync(process.argv[2],'utf8');let pending=Buffer.alloc(0),busy=false,phase='prepare';
  process.stdin.on('data',chunk=>{if(busy||pending.length+chunk.length>2*1024*1024){process.exitCode=1;process.stdin.destroy();return;}pending=Buffer.concat([pending,chunk]);const end=pending.indexOf(10);if(end<0)return;
    let input;try{if(end!==pending.length-1)throw fail('client_bridge_protocol');input=JSON.parse(pending.subarray(0,end));if(input.phase!==phase)throw fail('client_bridge_protocol');}catch{process.exitCode=1;process.stdin.destroy();return;}pending=Buffer.alloc(0);busy=true;
    Promise.resolve().then(()=>{
      if(input.phase==='prepare'){phase=process.platform==='win32'?'beforeResume':'attach';return {arguments:['--inspect-brk=127.0.0.1:0'],beforeResume:process.platform==='win32'};}
      if(input.phase==='beforeResume'){phase='attach';return plan(input.context.executable);}
      return attach(input.context,source);
    })
      .then(result=>{process.stdout.write(JSON.stringify({ok:true,result})+'\n');busy=false;if(input.phase==='attach')process.stdout.write('',()=>process.exit(0));},error=>{process.stdout.write(JSON.stringify({ok:false,code:error.code??'client_bridge_bootstrap_failed'})+'\n',()=>process.exit(1));});
  });
}
module.exports={plan,sameExecutable,attach};
