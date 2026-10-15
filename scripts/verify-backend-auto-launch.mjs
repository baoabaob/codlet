// Exercise the production spawn hook with a real backend and a fresh profile.
// The reserved local endpoints are observed through config/read; no turn starts.
import fs from 'node:fs';
import path from 'node:path';
import os from 'node:os';
import assert from 'node:assert/strict';
import {spawn} from 'node:child_process';
import {createRequire} from 'node:module';
const require=createRequire(import.meta.url),{installBackendSpawn}=require('../codex/host/backend-spawn.cjs');
const {verifyBackend}=require('../codex/host/backend-launch.cjs');
const [executable,output]=process.argv.slice(2);
if(!path.isAbsolute(executable??'')||!path.isAbsolute(output??'')||fs.existsSync(output))throw Error('Pass a backend executable and a new report path');
const identity=verifyBackend(executable),root=fs.mkdtempSync(path.join(os.tmpdir(),'codlet-auto-backend-'));
const state={owned:new WeakSet(),trust:new WeakMap(),accounts:new WeakMap(),providers:new WeakMap(),records:new Set(),pending:new Set(),prepared:0};
const routes=[];let hook,child;
async function stop(){
  if(!child||child.exitCode!==null||child.signalCode!==null)return;
  const ended=new Promise(resolve=>child.once('exit',resolve));child.stdin.end();
  let timer;await Promise.race([ended,new Promise(resolve=>timer=setTimeout(resolve,250))]);clearTimeout(timer);
  if(child.exitCode===null&&child.signalCode===null){child.kill();await ended;}
}
try{
  const codexRoot=path.join(root,'codex');fs.mkdirSync(codexRoot);
  fs.writeFileSync(path.join(codexRoot,'auth.json'),JSON.stringify({OPENAI_API_KEY:'codlet-contract-synthetic'}));
  fs.writeFileSync(path.join(codexRoot,'config.toml'),'cli_auth_credentials_store="file"\nsandbox_mode="read-only"\napproval_policy="never"\nopenai_base_url="http://127.0.0.1:9/fixture/"\n[model_providers.contract_fixture]\nname="Contract fixture"\nwire_api="responses"\nbase_url="http://127.0.0.1:9/custom/"\n[features]\nplugins=false\nremote_models=false\nremote_plugin=false\ncode_mode_host=false\n[analytics]\nenabled=false\n');
  const environment={...process.env,CODEX_HOME:codexRoot,CODEX_SQLITE_HOME:path.join(root,'sqlite'),OPENAI_API_KEY:'codlet-contract-synthetic'};
  for(const key of Object.keys(environment))if(/^(CODEX_APP_SERVER_WS_URL|CODEX_APP_SERVER_OPENAI_BASE_URL|CODEX_APP_SERVER_CHATGPT_BASE_URL|OPENAI_BASE_URL)$/iu.test(key))delete environment[key];
  const source={reserveRoute({upstreamBaseUrl}){const route={upstreamBaseUrl,baseUrl:`http://127.0.0.1:9/automatic-${routes.length}/`,ready:Promise.resolve(),closed:false,close(){route.closed=true;}};routes.push(route);return route;}};
  hook=installBackendSpawn({source,runtimeExecutable:process.execPath,deadlineUnixMs:Date.now()+8000},{state});
  const started=Date.now();child=spawn(executable,['app-server','--stdio'],{env:environment,cwd:root,windowsHide:true,stdio:['pipe','pipe','pipe']});
  const pid=child.pid;
  child.stderr.on('data',()=>{});
  const configuration=await new Promise((resolve,reject)=>{
    let pending='',bytes=0,expected=1;
    const timer=setTimeout(()=>reject(Error('automatic_backend_timeout')),5000);
    const finish=(error,value)=>{clearTimeout(timer);error?reject(error):resolve(value);};
    child.once('error',error=>finish(error));child.stdin.on('error',error=>finish(error));
    child.once('exit',()=>finish(Error('automatic_backend_exited')));
    child.stdout.on('data',chunk=>{
      bytes+=chunk.length;if(bytes>2*1024*1024){finish(Error('automatic_backend_output_limit'));return;}
      pending+=chunk.toString();let at;
      while((at=pending.indexOf('\n'))>=0){const line=pending.slice(0,at);pending=pending.slice(at+1);let message;try{message=JSON.parse(line);}catch{continue;}
        if(message.id!==expected)continue;if(message.error){finish(Error('automatic_backend_protocol'));return;}
        if(expected===1){expected=2;child.stdin.write(JSON.stringify({method:'initialized',params:{}})+'\n');child.stdin.write(JSON.stringify({id:2,method:'config/read',params:{cwd:root,includeLayers:false}})+'\n');}
        else finish(null,message.result?.config);
      }
    });
    child.stdin.write(JSON.stringify({id:1,method:'initialize',params:{clientInfo:{name:'codlet-auto-launch-check',version:'1'},capabilities:{experimentalApi:true}}})+'\n');
  });
  assert.equal((await hook.ready()).available,true);assert.equal(hook.ownsProcess(child),true);assert.equal(routes.length,2);
  assert.equal(configuration.openai_base_url,routes[0].baseUrl);assert.equal(configuration.model_providers.contract_fixture.base_url,routes[1].baseUrl);
  const observed=[...state.records][0].compatibility;assert.equal(observed.binarySha256,identity.binarySha256);assert.equal(observed.contract.routing,'runtime');
  await stop();assert.equal(state.records.size,0);assert(routes.every(route=>route.closed));
  const report={schema:1,kind:'production-backend-spawn-hook',identity,backendPid:pid,elapsedMs:Date.now()-started,
    automaticOwnership:true,providerOverrides:observed.contract.providerOverrides,contract:observed.contract,childExited:true,routesClosed:true};
  fs.mkdirSync(path.dirname(output),{recursive:true});fs.writeFileSync(output,JSON.stringify(report,null,2)+'\n',{flag:'wx'});console.log(JSON.stringify(report));
}finally{
  await stop();hook?.close();
  const resolved=fs.realpathSync(root);if(path.dirname(resolved)!==fs.realpathSync(os.tmpdir()))throw Error('Unexpected temporary profile location');
  fs.rmSync(resolved,{recursive:true,maxRetries:8,retryDelay:100});
}
