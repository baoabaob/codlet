import fs from 'node:fs';
import path from 'node:path';
import net from 'node:net';
import http from 'node:http';
import {createRequire} from 'node:module';
import {spawn,execFileSync} from 'node:child_process';
import {setTimeout as delay} from 'node:timers/promises';
// Run from an unpackaged creator; Core establishes the required package context.
// No package is installed or updated. Use reviewed binaries and a fresh directory.
const config=JSON.parse(fs.readFileSync(process.argv[2],'utf8'));
// A fresh CODEX_HOME isolates files, but elevated Windows sandbox setup also
// changes machine-wide accounts and firewall rules. Require a disposable host.
if(process.platform==='win32'&&config.disposableWindowsHost!==true) {
  throw Error('Native Windows acceptance requires a disposable VM/host (disposableWindowsHost:true). Separate profiles do not isolate Windows sandbox accounts or firewall rules.');
}
for(const key of ['root','clientApp','pluginsRoot','testBinary']) {
  if(typeof config[key]!=='string'||!path.isAbsolute(config[key])) throw Error(key+' must be absolute');
}
if(!/^\d+\.\d+\.\d+\.\d+$/.test(config.packageVersion)) throw Error('packageVersion must have four numeric components');
const root=path.resolve(config.root);
const allowed=/^(SYSTEMROOT|WINDIR|SYSTEMDRIVE|COMSPEC|PATH|PATHEXT|OS|PROCESSOR_ARCHITECTURE|PROCESSOR_ARCHITEW6432|PROCESSOR_IDENTIFIER|PROCESSOR_LEVEL|PROCESSOR_REVISION|NUMBER_OF_PROCESSORS|USERNAME|USERDOMAIN|USERDNSDOMAIN|PROGRAMFILES|PROGRAMFILES\(X86\)|PROGRAMW6432|COMMONPROGRAMFILES|COMMONPROGRAMFILES\(X86\)|COMMONPROGRAMW6432)$/i;
const env=Object.fromEntries(Object.entries(process.env).filter(([k])=>allowed.test(k)));
fs.mkdirSync(root);
fs.writeFileSync(path.join(root,'owner.txt'),'codlet-desktop-acceptance\n',{flag:'wx'});
for(const [key,rel] of Object.entries({CODLET_HOME:'codlet',CODEX_HOME:'codex-home',CODEX_SQLITE_HOME:'sqlite',CODEX_ELECTRON_USER_DATA_PATH:'user-data',USERPROFILE:'home',HOME:'home',APPDATA:'home/AppData/Roaming',LOCALAPPDATA:'home/AppData/Local',TEMP:'temp',TMP:'temp'})) {env[key]=path.join(root,rel);fs.mkdirSync(env[key],{recursive:true});}
env.BUILD_FLAVOR='dev';
env.CODEX_SPARKLE_ENABLED='false';
env.CODEX_ELECTRON_PRIMARY_RUNTIME_UPDATE_MODE='manual';
env.SHELL='C:/Windows/System32/WindowsPowerShell/v1.0/powershell.exe';
env.PSModulePath='C:/Windows/System32/WindowsPowerShell/v1.0/Modules';
env.CODLET_ACCEPTANCE_ROOT=root;
env.CODLET_ACCEPTANCE_SHELL_ENV='1';
if(config.stalePackageSelection===true)env.CODLET_ACCEPTANCE_STALE_PACKAGE='1';
if(config.manual===true) {
  if(config.probeScript!=null)throw Error('Manual acceptance must not drive the UI');
  env.CODLET_ACCEPTANCE_MANUAL='1';
}
if(config.startupHelper!=null)throw Error('The lab startup helper was retired; use the production launch Adapter');
if(config.fixtureState!=null){
  if(typeof config.fixtureState!=='object'||Array.isArray(config.fixtureState)||Buffer.byteLength(JSON.stringify(config.fixtureState))>65536)throw Error('fixtureState must be a bounded synthetic state object');
  fs.writeFileSync(path.join(env.CODEX_HOME,'.codex-global-state.json'),JSON.stringify(config.fixtureState));
}
if(config.probeScript!=null) {
  if(typeof config.probeScript!=='string'||!path.isAbsolute(config.probeScript)||!fs.statSync(config.probeScript).isFile()) throw Error('probeScript must be an absolute file');
  env.CODLET_ACCEPTANCE_PROBE=config.probeScript;
}
if(config.durationSeconds!=null) {
  if(!Number.isSafeInteger(config.durationSeconds)||config.durationSeconds<35||config.durationSeconds>180) throw Error('durationSeconds must be 35..180');
  env.CODLET_ACCEPTANCE_DURATION=String(config.durationSeconds);
}
if(config.fixtureResponseDelayMs!=null&&(!Number.isSafeInteger(config.fixtureResponseDelayMs)||config.fixtureResponseDelayMs<0||config.fixtureResponseDelayMs>5000))throw Error('fixtureResponseDelayMs must be 0..5000');
if(config.foreground===true)env.CODLET_ACCEPTANCE_FOREGROUND='1';
if(config.rawLaunch===true) env.CODLET_ACCEPTANCE_RAW='1';
env.CODLET_ACCEPTANCE_PACKAGE_VERSION=config.packageVersion;
env.CODLET_ACCEPTANCE_EXE=path.join(config.clientApp,'ChatGPT.exe');
const backendNames=['codex.exe','codex-command-runner.exe','codex-code-mode-host.exe',
  'codex-windows-sandbox-setup.exe','codex-windows-sandbox-service.exe'];
const backendFiles=backendNames.map(name=>path.join(config.clientApp,'resources',name));
for(const executable of [env.CODLET_ACCEPTANCE_EXE,...backendFiles]) {
  if(!fs.statSync(executable).isFile())throw Error('The selected backend installation is incomplete: '+path.basename(executable));
  execFileSync(env.SHELL,['-NoLogo','-NoProfile','-NonInteractive','-Command',"$s=Get-AuthenticodeSignature -LiteralPath $env:CODLET_SIGNATURE_FILE; if($s.Status -ne 'Valid' -or $s.SignerCertificate.Subject -notmatch 'OpenAI'){exit 1}"],{env:{...env,CODLET_SIGNATURE_FILE:executable},windowsHide:true,timeout:20000});
}
// Some WindowsApps CLI images cannot be executed directly by an unpackaged
// coordinator. Stage the already verified executable in this fresh test root.
// The official desktop still runs from the explicitly selected clientApp path.
const backendDirectory=path.join(root,'backend');fs.mkdirSync(backendDirectory);
const cli=path.join(backendDirectory,'codex.exe');
// The CLI resolves sandbox/setup and tool-host companions beside itself. A
// solitary copied codex.exe triggers an unrelated Windows missing-file dialog.
for(const executable of backendFiles)fs.copyFileSync(executable,path.join(backendDirectory,path.basename(executable)),fs.constants.COPYFILE_EXCL);
env.CODEX_CLI_PATH=cli;
env.PATH=backendDirectory+path.delimiter+(env.PATH??env.Path??'');
let fixtureServer,fixtureWebSockets;
let fixtureConfig='';
if(config.localApiKeyFixture===true) {
  let turns=0;
  function modelEvents(){
    turns++;const id='fixture-'+turns,text='codlet-original-response';
    const item={id:'msg-'+turns,type:'message',role:'assistant',status:'completed',content:[{type:'output_text',text,annotations:[]}]};
    return [{type:'response.created',response:{id,status:'in_progress',output:[]}},
      {type:'response.output_item.added',output_index:0,item:{...item,status:'in_progress',content:[]}},
      {type:'response.output_text.delta',item_id:item.id,output_index:0,content_index:0,delta:text},
      {type:'response.output_item.done',output_index:0,item},
      {type:'response.completed',response:{id,status:'completed',output:[item],usage:{input_tokens:1,output_tokens:1,total_tokens:2,input_tokens_details:{cached_tokens:0},output_tokens_details:{reasoning_tokens:0}}}}];
  }
  fixtureServer=http.createServer(async (request,response)=>{
    const chunks=[];let bytes=0;
    for await(const chunk of request){bytes+=chunk.length;if(bytes>4*1024*1024){response.writeHead(413).end();return;}chunks.push(chunk);}
    const body=Buffer.concat(chunks).toString('utf8');
    fs.appendFileSync(path.join(root,'fixture.jsonl'),JSON.stringify({path:request.url,method:request.method,
      requestModified:request.headers['x-codlet-acceptance']==='modified',bodyModified:body.includes('codlet-modified-request'),modelModified:body.includes('"model":"codlet-intercepted-model"'),contextAdded:body.includes('Synthetic functional test context'),submitPrefixRemoved:!body.includes('[FUNCTIONAL]')})+'\n');
    if(request.url?.endsWith('/responses')){
      response.writeHead(200,{'content-type':'text/event-stream'});
      if(config.fixtureResponseDelayMs){response.flushHeaders();await delay(config.fixtureResponseDelayMs);if(response.destroyed)return;}
      response.end(modelEvents().map(value=>`event: ${value.type}\ndata: ${JSON.stringify(value)}\n\n`).join(''));return;
    }
    if(request.url?.includes('/desktop/')){response.writeHead(200,{'content-type':'text/plain'}).end('codlet-original-response');return;}
    response.writeHead(request.url?.endsWith('/models')?200:404,{'content-type':'application/json'});
    response.end(JSON.stringify(request.url?.endsWith('/models')?{object:'list',data:[{id:'gpt-5.4',object:'model',owned_by:'codlet-acceptance'}]}:{error:{message:'Unsupported acceptance endpoint'}}));
  });
  if(config.fixtureWebSocket===true){
    const {WebSocketServer}=createRequire(new URL('../frontend/package.json',import.meta.url))('ws');
    fixtureWebSockets=new WebSocketServer({noServer:true,maxPayload:4*1024*1024});
    fixtureServer.on('upgrade',(request,socket,head)=>fixtureWebSockets.handleUpgrade(request,socket,head,connection=>{
      fs.appendFileSync(path.join(root,'fixture.jsonl'),JSON.stringify({protocol:'websocket',requestModified:request.headers['x-codlet-acceptance']==='modified'})+'\n');
      connection.on('error',()=>{});
      connection.on('message',async data=>{
        let body;try{body=JSON.parse(data.toString());}catch{connection.close(1003,'Invalid fixture request');return;}
        fs.appendFileSync(path.join(root,'fixture.jsonl'),JSON.stringify({protocol:'websocket-frame',modelModified:body.model==='codlet-intercepted-model',prewarm:body.generate===false,continuation:typeof body.previous_response_id==='string'})+'\n');
        if(config.fixtureResponseDelayMs)await delay(config.fixtureResponseDelayMs);
        if(connection.readyState===1)for(const event of modelEvents())connection.send(JSON.stringify(event));
      });
    }));
  }else fixtureServer.on('upgrade',(_request,socket)=>socket.end('HTTP/1.1 426 Upgrade Required\r\nConnection: close\r\nContent-Length: 0\r\n\r\n'));
  await new Promise(resolve=>fixtureServer.listen(0,'127.0.0.1',resolve));
  const url=`http://127.0.0.1:${fixtureServer.address().port}/v1`;
  env.OPENAI_BASE_URL=url;
  env.CODEX_APP_SERVER_OPENAI_BASE_URL=url;
  env.CODEX_APP_SERVER_CHATGPT_BASE_URL=url.replace(/\/v1$/,'/backend-api');
  fixtureConfig=`openai_base_url=${JSON.stringify(url)}\n`;
  fs.writeFileSync(path.join(env.CODEX_HOME,'auth.json'),JSON.stringify({OPENAI_API_KEY:'codlet-offline-acceptance'}));
}
fs.writeFileSync(path.join(env.CODEX_HOME,'config.toml'),fixtureConfig+'cli_auth_credentials_store="file"\nsandbox_mode="read-only"\napproval_policy="never"\nmodel="gpt-5.4"\n[features]\nplugins=false\nremote_models=false\nremote_plugin=false\ncode_mode_host=false\nresponses_websockets='+String(config.fixtureWebSocket===true)+'\nresponses_websockets_v2='+String(config.fixtureWebSocket===true)+'\n[analytics]\nenabled=false\n[mcp_servers.codex_app]\nenabled=false\ncommand=""\n');
const registry={schema:2,plugins:{},localPlugins:{}};
for(const plugin of ['codex-desktop-adapter','codex-ui-adapter','codlet']) {
  const dir=path.join(config.pluginsRoot,'bundled',plugin);
  const manifest=JSON.parse(fs.readFileSync(path.join(dir,'codlet.json'),'utf8'));
  registry.localPlugins[manifest.id]={path:dir,grants:manifest.permissions};
}
for(const source of config.extraPlugins??[]) {
  if(typeof source!=='string'||!path.isAbsolute(source))throw Error('extraPlugins requires absolute trusted fixture directories');
  const manifest=JSON.parse(fs.readFileSync(path.join(source,'codlet.json'),'utf8'));
  if(!/^[A-Za-z0-9][A-Za-z0-9._-]{0,127}$/.test(manifest.id)||registry.localPlugins[manifest.id])throw Error('invalid or duplicate fixture plugin id');
  const dir=path.join(root,'fixture-plugins',manifest.id);
  fs.cpSync(source,dir,{recursive:true,errorOnExist:true,force:false});
  fs.writeFileSync(path.join(dir,'fixture.json'),JSON.stringify({baseUrl:env.OPENAI_BASE_URL??null,autorun:config.functionalTestAuto===true}));
  const policy=config.extraPluginPolicies?.[manifest.id];
  if(policy&&(typeof policy!=='object'||Array.isArray(policy)||Object.keys(policy).some(key=>key!=='clientPermissions')||policy.clientPermissions!==true))throw Error('extraPluginPolicies accepts only explicit clientPermissions:true for a trusted isolated fixture');
  registry.localPlugins[manifest.id]={path:dir,grants:manifest.permissions,
    ...(policy?{brokerPolicy:policy}:env.OPENAI_BASE_URL&&manifest.permissions.includes('host.network')?{brokerPolicy:{networkOrigins:[new URL(env.OPENAI_BASE_URL).origin]}}:{})};
}
fs.writeFileSync(path.join(env.CODLET_HOME,'config.json'),JSON.stringify(registry,null,2));
if(config.lifecyclePlugin!=null&&(typeof config.lifecyclePlugin!=='string'||!registry.localPlugins[config.lifecyclePlugin]||!(config.extraPlugins??[]).some(source=>JSON.parse(fs.readFileSync(path.join(source,'codlet.json'),'utf8')).id===config.lifecyclePlugin)))throw Error('lifecyclePlugin must name a trusted copied fixture');
let backend,endpoint,port;
if(config.ownedBackend===true) {
  if(config.localApiKeyFixture!==true)throw Error('ownedBackend requires the local API key fixture');
  env.CODLET_ACCEPTANCE_OWNED_BACKEND='1';
  fs.writeFileSync(path.join(root,'backend.json'),JSON.stringify({mode:'client-owned',cli}));
} else {
const listener=net.createServer();
await new Promise(r=>listener.listen(0,'127.0.0.1',r));
port=listener.address().port;
await new Promise(r=>listener.close(r));
endpoint=`ws://127.0.0.1:${port}`;
env.CODEX_APP_SERVER_WS_URL=endpoint;
backend=spawn(cli,['app-server','--listen',endpoint,'-c','sandbox_mode="read-only"','-c','analytics.enabled=false','-c','mcp_servers.codex_app={command="",enabled=false}'],{env,cwd:root,windowsHide:true,stdio:['ignore',fs.openSync(path.join(root,'backend.out.log'),'w'),fs.openSync(path.join(root,'backend.err.log'),'w')]});
}
let child;
try {
  if(backend) {
  for(let i=0;i<100;i++) {
    if(backend.exitCode!==null) throw Error('backend exited '+backend.exitCode);
    const open=await new Promise(r=>{const c=net.connect(port,'127.0.0.1');c.once('connect',()=>{c.destroy();r(true)});c.once('error',()=>r(false));});
    if(open) break;
    await delay(100);
  }
  const owner=execFileSync(env.SHELL,['-NoLogo','-NoProfile','-NonInteractive','-Command',`(Get-NetTCPConnection -State Listen -LocalPort ${port} -ErrorAction Stop).OwningProcess`],{env,windowsHide:true,encoding:'utf8'}).trim();
  if(Number(owner)!==backend.pid) throw Error('listener ownership mismatch');
  fs.writeFileSync(path.join(root,'backend.json'),JSON.stringify({pid:backend.pid,endpoint,cli}));
  await new Promise((resolve,reject)=>{
    const ws=new WebSocket(endpoint);const timeout=setTimeout(()=>{ws.close();reject(Error('backend handshake timeout'));},10000);
    ws.onopen=()=>ws.send(JSON.stringify({id:1,method:'initialize',params:{clientInfo:{name:'codlet-acceptance',version:'1'},capabilities:{experimentalApi:true}}}));
    ws.onmessage=e=>{const m=JSON.parse(e.data);if(m.id===1){clearTimeout(timeout);ws.close();m.error?reject(Error(JSON.stringify(m.error))):resolve();}};
    ws.onerror=()=>{clearTimeout(timeout);reject(Error('backend websocket failure'));};
  });
  }
  // A real cmd invocation leaves =ExitCode metadata in the native environment.
  // Passing a curated JS object directly to Core previously hid this startup bug.
  // Profiles/backend remain isolated; only this owned child's environment changes.
  const entry=path.join(root,'start-core.cmd');
  if(/["\r\n]/.test(config.testBinary)) throw Error('invalid test binary path');
  fs.writeFileSync(entry,`@echo off\r\ncmd.exe /d /c exit 7\r\n"${config.testBinary.replaceAll('%','%%')}"\r\nexit /b %errorlevel%\r\n`);
  child=spawn(env.COMSPEC||env.ComSpec||'C:/Windows/System32/cmd.exe',['/d','/s','/c',`"${entry}"`],{env,cwd:root,windowsHide:true,windowsVerbatimArguments:true,stdio:['ignore',fs.openSync(path.join(root,'core.out.log'),'w'),fs.openSync(path.join(root,'core.err.log'),'w')]});
  let auditing=false;
  const lifecycle=config.lifecyclePlugin&&setInterval(()=>{
    if(auditing)return;
    let result;try{const probes=JSON.parse(fs.readFileSync(path.join(root,'probe.json'),'utf8'));result=probes.at(-1)?.result?.response?.result?.value;}catch{return;}
    if(result?.phase!=='complete')return;
    auditing=true;clearInterval(lifecycle);
    const audit={pluginId:config.lifecyclePlugin,commands:[],passed:false};
    try{
      fs.writeFileSync(path.join(root,'functional-report.json'),JSON.stringify(result,null,2));
      const pluginRoot=registry.localPlugins[config.lifecyclePlugin].path,fixturePath=path.join(pluginRoot,'fixture.json'),fixture=JSON.parse(fs.readFileSync(fixturePath,'utf8'));
      fixture.autorun=false;fs.writeFileSync(fixturePath,JSON.stringify(fixture));
      for(const action of ['reload','disable','enable']){
        const receipt=JSON.parse(execFileSync(config.testBinary,['plugin',action,config.lifecyclePlugin,'--json'],{env,cwd:root,windowsHide:true,encoding:'utf8',timeout:20000,maxBuffer:4*1024*1024}));
        if(receipt.outcome!=='completed'||receipt.control?.operation?.completion?.report?.outcome!=='applied'||receipt.control.operation.completion.report.target_failures.length)throw Error('Fixture lifecycle did not apply: '+action);
        const cleanup=JSON.parse(fs.readFileSync(path.join(pluginRoot,'cleanup.json'),'utf8'));
        if(!cleanup.retired)throw Error('Fixture did not record cleanup');
        audit.commands.push({action,receipt,cleanup});
      }
      audit.passed=true;
    }catch(error){audit.error=String(error);}
    fs.writeFileSync(path.join(root,'lifecycle.json'),JSON.stringify(audit,null,2));
  },500);
  const exit=await new Promise((resolve,reject)=>{child.once('exit',resolve);child.once('error',reject);});
  if(lifecycle)clearInterval(lifecycle);
  fs.writeFileSync(path.join(root,'completed.json'),JSON.stringify({exit,root}));
  process.exitCode=exit===0?0:1;
} catch(error) {
  fs.writeFileSync(path.join(root,'completed.json'),JSON.stringify({exit:1,root,error:String(error)}));
  process.exitCode=1;
} finally {
  if(backend&&backend.exitCode===null){backend.kill();await new Promise(r=>backend.once('exit',r));}
  if(fixtureWebSockets){for(const connection of fixtureWebSockets.clients)connection.terminate();await new Promise(resolve=>fixtureWebSockets.close(resolve));}
  if(fixtureServer){fixtureServer.closeAllConnections();await new Promise(resolve=>fixtureServer.close(resolve));}
}
