import fs from 'node:fs';
import path from 'node:path';
import net from 'node:net';
import http from 'node:http';
import {spawn,execFileSync} from 'node:child_process';
import {setTimeout as delay} from 'node:timers/promises';
// Run from an unpackaged creator; Core establishes the required package context.
// No package is installed or updated. Use reviewed binaries and a fresh directory.
const config=JSON.parse(fs.readFileSync(process.argv[2],'utf8'));
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
if(config.rawLaunch===true) env.CODLET_ACCEPTANCE_RAW='1';
env.CODLET_ACCEPTANCE_PACKAGE_VERSION=config.packageVersion;
env.CODLET_ACCEPTANCE_EXE=path.join(config.clientApp,'ChatGPT.exe');
const officialCli=path.join(config.clientApp,'resources/codex.exe');
for(const executable of [env.CODLET_ACCEPTANCE_EXE,officialCli]) {
  execFileSync(env.SHELL,['-NoLogo','-NoProfile','-NonInteractive','-Command',"$s=Get-AuthenticodeSignature -LiteralPath $env:CODLET_SIGNATURE_FILE; if($s.Status -ne 'Valid' -or $s.SignerCertificate.Subject -notmatch 'OpenAI'){exit 1}"],{env:{...env,CODLET_SIGNATURE_FILE:executable},windowsHide:true,timeout:20000});
}
// Some WindowsApps CLI images cannot be executed directly by an unpackaged
// coordinator. Stage the already verified executable in this fresh test root.
// The official desktop still runs from the explicitly selected clientApp path.
const backendDirectory=path.join(root,'backend');fs.mkdirSync(backendDirectory);
const cli=path.join(backendDirectory,'codex.exe');
fs.copyFileSync(officialCli,cli,fs.constants.COPYFILE_EXCL);
env.CODEX_CLI_PATH=cli;
let fixtureServer;
let fixtureConfig='';
if(config.localApiKeyFixture===true) {
  let turns=0;
  fixtureServer=http.createServer(async (request,response)=>{
    const chunks=[];let bytes=0;
    for await(const chunk of request){bytes+=chunk.length;if(bytes>4*1024*1024){response.writeHead(413).end();return;}chunks.push(chunk);}
    const body=Buffer.concat(chunks).toString('utf8');
    fs.appendFileSync(path.join(root,'fixture.jsonl'),JSON.stringify({path:request.url,method:request.method,
      requestModified:request.headers['x-codlet-acceptance']==='modified',bodyModified:body.includes('codlet-modified-request')})+'\n');
    if(request.url?.endsWith('/responses')){
      turns++;const id='fixture-'+turns,text='codlet-original-response';
      const item={id:'msg-'+turns,type:'message',role:'assistant',status:'completed',content:[{type:'output_text',text,annotations:[]}]};
      const events=[{type:'response.created',response:{id,status:'in_progress',output:[]}},
        {type:'response.output_item.added',output_index:0,item:{...item,status:'in_progress',content:[]}},
        {type:'response.output_text.delta',item_id:item.id,output_index:0,content_index:0,delta:text},
        {type:'response.output_item.done',output_index:0,item},
        {type:'response.completed',response:{id,status:'completed',output:[item],usage:{input_tokens:1,output_tokens:1,total_tokens:2,input_tokens_details:{cached_tokens:0},output_tokens_details:{reasoning_tokens:0}}}}];
      response.writeHead(200,{'content-type':'text/event-stream'});
      response.end(events.map(value=>`event: ${value.type}\ndata: ${JSON.stringify(value)}\n\n`).join(''));return;
    }
    if(request.url?.includes('/desktop/')){response.writeHead(200,{'content-type':'text/plain'}).end('codlet-original-response');return;}
    response.writeHead(request.url?.endsWith('/models')?200:404,{'content-type':'application/json'});
    response.end(JSON.stringify(request.url?.endsWith('/models')?{object:'list',data:[{id:'gpt-5.4',object:'model',owned_by:'codlet-acceptance'}]}:{error:{message:'Unsupported acceptance endpoint'}}));
  });
  fixtureServer.on('upgrade',(_request,socket)=>socket.end('HTTP/1.1 426 Upgrade Required\r\nConnection: close\r\nContent-Length: 0\r\n\r\n'));
  await new Promise(resolve=>fixtureServer.listen(0,'127.0.0.1',resolve));
  const url=`http://127.0.0.1:${fixtureServer.address().port}/v1`;
  env.OPENAI_BASE_URL=url;
  env.CODEX_APP_SERVER_OPENAI_BASE_URL=url;
  env.CODEX_APP_SERVER_CHATGPT_BASE_URL=url.replace(/\/v1$/,'/backend-api');
  fixtureConfig=`openai_base_url=${JSON.stringify(url)}\n`;
  fs.writeFileSync(path.join(env.CODEX_HOME,'auth.json'),JSON.stringify({OPENAI_API_KEY:'codlet-offline-acceptance'}));
}
fs.writeFileSync(path.join(env.CODEX_HOME,'config.toml'),fixtureConfig+'cli_auth_credentials_store="file"\nsandbox_mode="read-only"\napproval_policy="never"\nmodel="gpt-5.4"\n[features]\nplugins=false\nremote_models=false\nremote_plugin=false\ncode_mode_host=false\n[analytics]\nenabled=false\n[mcp_servers.codex_app]\nenabled=false\ncommand=""\n');
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
  fs.writeFileSync(path.join(dir,'fixture.json'),JSON.stringify({baseUrl:env.OPENAI_BASE_URL??null}));
  registry.localPlugins[manifest.id]={path:dir,grants:manifest.permissions,
    ...(env.OPENAI_BASE_URL&&manifest.permissions.includes('host.network')?{brokerPolicy:{networkOrigins:[new URL(env.OPENAI_BASE_URL).origin]}}:{})};
}
fs.writeFileSync(path.join(env.CODLET_HOME,'config.json'),JSON.stringify(registry,null,2));
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
  const exit=await new Promise((resolve,reject)=>{child.once('exit',resolve);child.once('error',reject);});
  fs.writeFileSync(path.join(root,'completed.json'),JSON.stringify({exit,root}));
  process.exitCode=exit===0?0:1;
} catch(error) {
  fs.writeFileSync(path.join(root,'completed.json'),JSON.stringify({exit:1,root,error:String(error)}));
  process.exitCode=1;
} finally {
  if(backend&&backend.exitCode===null){backend.kill();await new Promise(r=>backend.once('exit',r));}
  if(fixtureServer){fixtureServer.closeAllConnections();await new Promise(resolve=>fixtureServer.close(resolve));}
}
