// Actual runner control flow with synthetic files and fake process boundaries.
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import os from 'node:os';
import http from 'node:http';
import net from 'node:net';
import vm from 'node:vm';
import {EventEmitter} from 'node:events';
import test from 'node:test';
import {prepareAcceptancePlugins, acceptanceGuiPath} from '../scripts/desktop-acceptance-plugins.mjs';

const source=fs.readFileSync(new URL('../scripts/desktop-acceptance.mjs',import.meta.url),'utf8').replace(/^import .*;\r?\n/gm,'').replaceAll('import.meta.url',JSON.stringify(new URL('../scripts/desktop-acceptance.mjs',import.meta.url).href));
async function run(t,mode){
  const directory=fs.mkdtempSync(path.join(os.tmpdir(),'codlet-desktop-cleanup-'));
  t.after(()=>fs.rmSync(directory,{recursive:true}));
  const app=path.join(directory,'app'),gui=path.join(directory,'gui'),root=path.join(directory,'run');
  fs.mkdirSync(path.join(app,'resources'),{recursive:true});fs.mkdirSync(gui);
  for(const name of ['ChatGPT.exe','resources/codex.exe','resources/codex-command-runner.exe','resources/codex-code-mode-host.exe','resources/codex-windows-sandbox-setup.exe','resources/codex-windows-sandbox-service.exe'])fs.writeFileSync(path.join(app,name),'non-executable fixture');
  fs.writeFileSync(path.join(gui,'codlet.json'),JSON.stringify({id:'codlet-gui',permissions:[]}));
  const config=path.join(directory,'config.json');fs.writeFileSync(config,JSON.stringify({root,clientApp:app,testBinary:path.join(directory,'test.exe'),packageVersion:'1.2.3.4',guiPlugin:gui,disposableWindowsHost:true,localApiKeyFixture:true,...(mode==='plugins'?{extraPlugins:['relative']}:{})}));
  const descriptors=new Set(),servers=[];let spawns=0;
  const io={...fs,openSync(...args){const fd=fs.openSync(...args);descriptors.add(fd);return fd;},closeSync(fd){descriptors.delete(fd);return fs.closeSync(fd);}};
  const process={argv:['node','script',config],platform:'win32',env:{},exitCode:0};
  const context=vm.createContext({fs:io,path,net,http:{...http,createServer(...args){const server=http.createServer(...args);servers.push(server);return server;}},Buffer,URL,process,
    spawn(){spawns++;const child=new EventEmitter();child.exitCode=null;queueMicrotask(()=>child.emit('error',Object.assign(Error('injected spawn failure'),{code:'ENOENT'})));return child;},
    execFileSync(){return Buffer.alloc(0);},prepareAcceptancePlugins,acceptanceGuiPath,
    delay:()=>new Promise(resolve=>setImmediate(resolve)),setTimeout,clearTimeout,setInterval,clearInterval});
  await vm.runInContext('(async()=>{'+source+'\n})()',context);
  assert.equal(process.exitCode,1);assert.equal(servers.length,1);assert.equal(servers[0].listening,false);
  assert.equal(descriptors.size,0);
  const completed=JSON.parse(fs.readFileSync(path.join(root,'completed.json')));
  return{spawns,completed};
}
test('invalid fixture preparation closes the already listening owned model server',async t=>{
  const result=await run(t,'plugins');assert.equal(result.spawns,0);assert.match(result.completed.error,/absolute trusted fixture/);
});
test('backend spawn error is recorded and retires model server and parent log descriptors',async t=>{
  const result=await run(t,'backend');assert.equal(result.spawns,1);assert.match(result.completed.error,/injected spawn failure/);
});
