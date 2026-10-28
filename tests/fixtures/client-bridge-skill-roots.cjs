'use strict';
// Controlled transport fixture. This is not a Native application or VM receipt.
const {startClientBridge}=require(process.argv[2]==='bundle'?'../../runtime/client-bridge-bundle.cjs':'../../runtime/client-bridge.cjs');
const {spawn}=require('node:child_process');
const readline=require('node:readline');
const path=require('node:path');
const token='b'.repeat(48);
let context,child,owner,identityPid=process.pid,identityMissing=false,closing=false,officialCalls=0,finishUpdate;
const updateTarget={id:'c'.repeat(64),version:'0.0.0'};
const bridge=startClientBridge({app:{isReady:()=>false,getAppPath:()=>__dirname}},{token},{
  identity:()=>({...identityMissing?{}:{pid:identityPid},executable:process.execPath,type:'browser'}),
  load:()=>({installElectronTraffic(_electron,_configuration,value){context=value;return {
    ready:async()=>{if(process.argv[3]==='ready-reject')throw Object.assign(Error('private source payload'),{code:'backend_route_timeout'});return {installed:false,activatedSources:[],unsupportedSources:[]};},close(){},
    officialUpdateTarget(){return {target:updateTarget,reason:null,installation:null,fixtureCalls:officialCalls,pid:-1,executable:'domain-value',type:'domain-value'};},
    installOfficialUpdate(){officialCalls++;return new Promise(resolve=>{finishUpdate=()=>resolve({accepted:true,target:updateTarget,pid:-1});});}
  };}})
});
const emit=value=>process.stdout.write(JSON.stringify(value)+'\n');
async function stop(){if(closing)return;closing=true;finishUpdate?.();await bridge.close();if(child&&child.exitCode===null&&child.signalCode===null){const done=new Promise(resolve=>child.once('exit',resolve));child.kill();await done;}}
(async()=>{
  await bridge.installInitial({owner:'dev.transport.fixture',generation:1,code:'controlled',configuration:{}});
  child=spawn(process.execPath,[path.join(__dirname,'skill-roots-child.cjs')],{windowsHide:true,stdio:['pipe','pipe','pipe']});
  child.stderr.resume();
  owner={hostId:'local',isLocal:true,disposed:true,connection:{proc:child}};
  context.observeBackend(child,{fresh:true,owner});
  context.registerBackendOwners(()=>[owner]);
  const endpoint=await bridge.endpoint();emit({kind:'endpoint',...endpoint,token,pid:process.pid,childPid:child.pid});
  const lines=readline.createInterface({input:process.stdin});
  for await(const line of lines){
    const command=JSON.parse(line);
    switch(command.action){
      case 'owner':owner.disposed=command.disposed;break;
      case 'set':child.stdin.write(JSON.stringify({id:command.requestId,method:'skills/extraRoots/set',params:{extraRoots:command.roots}})+'\n');break;
      case 'reply':{
        const received=new Promise(resolve=>{const check=chunk=>{if(String(chunk).includes(JSON.stringify(command.requestId))){child.stdout.off('data',check);resolve();}};child.stdout.on('data',check);});
        child.stdin.write(JSON.stringify({method:'fixture/reply',params:{id:command.requestId}})+'\n');await received;break;
      }
      case 'retire':{const done=new Promise(resolve=>child.once('exit',resolve));child.kill();await done;break;}
      case 'wrongIdentity':identityPid=command.enabled?process.pid+1:process.pid;break;
      case 'missingIdentity':identityMissing=command.enabled;break;
      case 'finishUpdate':if(typeof finishUpdate!=='function')throw Error('No controlled update is pending');finishUpdate();break;
      case 'stop':await stop();emit({kind:'control',id:command.id,action:command.action});process.exit(0);return;
      default:throw Error('Unknown controlled fixture action');
    }
    emit({kind:'control',id:command.id,action:command.action});
  }
  await stop();
})().catch(async error=>{process.stderr.write(String(error.stack??error)+'\n');await stop();process.exitCode=1;});
