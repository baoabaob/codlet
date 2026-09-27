import fs from 'node:fs';
import path from 'node:path';
import net from 'node:net';
import {spawn,execFileSync} from 'node:child_process';
import {setTimeout as delay} from 'node:timers/promises';
// Run inside an existing Windows desktop package context. No package is installed
// or updated. The config selects reviewed binaries and a fresh output directory.
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
env.CODLET_ACCEPTANCE_PACKAGE_VERSION=config.packageVersion;
env.CODLET_ACCEPTANCE_EXE=path.join(config.clientApp,'ChatGPT.exe');
const cli=path.join(config.clientApp,'resources/codex.exe');
for(const executable of [env.CODLET_ACCEPTANCE_EXE,cli]) {
  execFileSync(env.SHELL,['-NoLogo','-NoProfile','-NonInteractive','-Command',"$s=Get-AuthenticodeSignature -LiteralPath $env:CODLET_SIGNATURE_FILE; if($s.Status -ne 'Valid' -or $s.SignerCertificate.Subject -notmatch 'OpenAI'){exit 1}"],{env:{...env,CODLET_SIGNATURE_FILE:executable},windowsHide:true,timeout:20000});
}
fs.writeFileSync(path.join(env.CODEX_HOME,'config.toml'),'cli_auth_credentials_store="file"\nsandbox_mode="read-only"\napproval_policy="never"\n[analytics]\nenabled=false\n[mcp_servers.codex_app]\nenabled=false\ncommand=""\n');
const registry={schema:2,plugins:{},localPlugins:{}};
for(const plugin of ['codex-desktop-adapter','codex-ui-adapter','codlet']) {
  const dir=path.join(config.pluginsRoot,'bundled',plugin);
  const manifest=JSON.parse(fs.readFileSync(path.join(dir,'codlet.json'),'utf8'));
  registry.localPlugins[manifest.id]={path:dir,grants:manifest.permissions};
}
fs.writeFileSync(path.join(env.CODLET_HOME,'config.json'),JSON.stringify(registry,null,2));
const listener=net.createServer();
await new Promise(r=>listener.listen(0,'127.0.0.1',r));
const port=listener.address().port;
await new Promise(r=>listener.close(r));
const endpoint=`ws://127.0.0.1:${port}`;
env.CODEX_APP_SERVER_WS_URL=endpoint;
const backend=spawn(cli,['app-server','--listen',endpoint,'-c','sandbox_mode="read-only"','-c','analytics.enabled=false','-c','mcp_servers.codex_app={command="",enabled=false}'],{env,cwd:root,windowsHide:true,stdio:['ignore',fs.openSync(path.join(root,'backend.out.log'),'w'),fs.openSync(path.join(root,'backend.err.log'),'w')]});
let child;
try {
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
  child=spawn(config.testBinary,[],{env,cwd:root,windowsHide:true,stdio:['ignore',fs.openSync(path.join(root,'core.out.log'),'w'),fs.openSync(path.join(root,'core.err.log'),'w')]});
  const exit=await new Promise((resolve,reject)=>{child.once('exit',resolve);child.once('error',reject);});
  fs.writeFileSync(path.join(root,'completed.json'),JSON.stringify({exit,root}));
  process.exitCode=exit===0?0:1;
} catch(error) {
  fs.writeFileSync(path.join(root,'completed.json'),JSON.stringify({exit:1,root,error:String(error)}));
  process.exitCode=1;
} finally {if(backend.exitCode===null){backend.kill();await new Promise(r=>backend.once('exit',r));}}
