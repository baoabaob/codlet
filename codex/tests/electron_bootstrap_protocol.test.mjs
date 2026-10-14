import test from 'node:test';
import assert from 'node:assert/strict';
import { spawn } from 'node:child_process';
import { fileURLToPath } from 'node:url';
import { createRequire } from 'node:module';
const { attachElectronTrafficBeforeEntry } = createRequire(import.meta.url)('../host/electron-bootstrap.cjs');
test('real Node inspector pauses before entry, binds identity, installs main hook, resumes and detaches', { timeout: 12000 }, async t => {
  const controller = new AbortController();
  const child = spawn(process.execPath, ['--require', fileURLToPath(new URL('./fixtures/traffic/main-preload.cjs', import.meta.url)), '--inspect-brk=127.0.0.1:0', fileURLToPath(new URL('./fixtures/traffic/main-entry.cjs', import.meta.url))], { windowsHide: true, stdio: ['ignore', 'ignore', 'pipe'] });
  t.after(async () => { controller.abort(); if (child.exitCode === null && child.signalCode === null) { const ended = new Promise(resolve => child.once('exit', resolve)); child.kill(); await ended; } });
  const inspectorUrl = await new Promise((resolve, reject) => {
    let buffer = ''; const timer = setTimeout(() => reject(new Error('inspector_not_listening')), 5000);
    child.once('error', reject);
    child.stderr.on('data', bytes => {
      if (buffer.length > 8192) { clearTimeout(timer); reject(new Error('inspector_output_limit')); return; }
      buffer += bytes.toString(); const found = /Debugger listening on (ws:\/\/127\.0\.0\.1:\d+\/[a-f0-9-]{36})/u.exec(buffer);
      if (found) { clearTimeout(timer); resolve(found[1]); }
    });
  });
  const forkPath=fileURLToPath(new URL('./fixtures/traffic/startup-fork.cjs',import.meta.url));
  const mainSource = `module.exports.installElectronTraffic=()=>({ready:async()=>{
    const electron=require('electron');
    if(electron.app.commandLine.getSwitchValue('inspect-brk')!==''||electron.app.commandLine.getSwitchValue('native-test')!=='preserved')throw Error('Native switch preservation failed');
    const inherited=electron.utilityProcess.fork('native',['argument']).args[2];
    const explicit={execArgv:['--inspect=127.0.0.1:42'],env:{marker:'native'}};
    if(inherited.execArgv.includes('--inspect-brk=127.0.0.1:0')||electron.utilityProcess.fork('native',[],explicit).args[2]!==explicit)throw Error('Native utility options changed');
    const child=require('node:child_process').fork(${JSON.stringify(forkPath)},[],{stdio:['ignore','ignore','ignore','ipc']});
    await new Promise((resolve,reject)=>{const timer=setTimeout(()=>{child.kill();reject(Error('Native fork inherited the paused startup inspector'));},2000);child.once('error',reject);child.once('message',value=>{clearTimeout(timer);if(value.execArgv.includes('--inspect-brk=127.0.0.1:0'))reject(Error('Startup argument escaped'));else resolve();});});
    const Worker=require('node:worker_threads').Worker,worker=new Worker(${JSON.stringify(forkPath)});
    await new Promise((resolve,reject)=>{const timer=setTimeout(()=>{worker.terminate();reject(Error('Native worker inherited the paused startup inspector'));},2000);worker.once('error',reject);worker.once('message',value=>{clearTimeout(timer);if(value.execArgv.includes('--inspect-brk=127.0.0.1:0'))reject(Error('Startup argument escaped'));else resolve();});});
    return {installed:true,activatedSources:[{id:'desktop-main-http',operations:['http.intercept'],protocols:['http'],coverage:['desktop-main-wEe-fetch']}],unsupportedSources:[]};
  },inspect:()=>({installed:true}),close:()=>{}});`;
  const result = await attachElectronTrafficBeforeEntry({ inspectorUrl, expectedPid: child.pid, executable: process.execPath,
    configuration: { source: { endpoint: { token: 'fixture' } } }, mainSource, signal: controller.signal });
  assert.equal(result.installed, true); assert.equal(result.exactChildVerified, true); assert.equal(result.activatedSources[0].id,'desktop-main-http');
});
