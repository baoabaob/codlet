// Runs only the reviewed independent CUA Node from a disposable official app.
// The official GUI executable and account data are never opened.
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { execFileSync, spawn } from 'node:child_process';

const core = path.resolve(process.argv[2] ?? '');
const plugins = path.resolve(process.argv[3] ?? '');
if (process.platform !== 'darwin' || process.arch !== 'arm64') throw new Error('Apple Silicon runner required');
const temporary = fs.mkdtempSync(path.join(os.tmpdir(), 'codlet-reviewed-cua-node-'));
const clean = Object.fromEntries(Object.entries(process.env).filter(([key]) => !/^(NODE_|OPENSSL_|DYLD_|ELECTRON_RUN_AS_NODE$)/iu.test(key)));
try {
  const probe = path.join(temporary, 'host-modules.cjs');
  fs.writeFileSync(probe, `
    'use strict';
    const assert=require('node:assert/strict');
    const fs=require('node:fs'), path=require('node:path');
    const {Module,createRequire}=require('node:module');
    const {AsyncLocalStorage}=require('node:async_hooks');
    const {Console}=require('node:console'), {TextDecoder}=require('node:util');
    const {performance}=require('node:perf_hooks');
    const http=require('node:http'),https=require('node:https');
    const tls=require('node:tls'),net=require('node:net');
    const crypto=require('node:crypto'),stream=require('node:stream');
    const {Worker}=require('node:worker_threads'),{spawnSync}=require('node:child_process');
    (async()=>{
      assert.equal(process.argv[1],'host-marker');
      assert.equal(typeof fs.readFileSync,'function');assert.equal(typeof path.resolve,'function');
      assert.equal(typeof Console,'function');assert.equal(new TextDecoder().decode(Buffer.from('ok')),'ok');
      assert.equal(typeof performance.now(),'number');
      assert.equal(crypto.createHash('sha256').update('x').digest('hex').length,64);
      assert.equal(typeof http.createServer,'function');assert.equal(typeof https.request,'function');
      assert.equal(typeof tls.createSecureContext,'function');assert.equal(typeof net.createServer,'function');
      assert.equal(typeof stream.Readable.from,'function');assert.equal(typeof WebSocket,'function');
      const entry=path.join(__dirname,'plugin.cjs'),plugin=new Module(entry,module);
      plugin.filename=entry;plugin.paths=Module._nodeModulePaths(path.dirname(entry));
      plugin._compile('module.exports=require("node:crypto").randomUUID()',entry);
      assert.equal(typeof plugin.exports,'string');assert.equal(typeof createRequire(entry).resolve('node:fs'),'string');
      const als=new AsyncLocalStorage();assert.equal(await als.run('owned',async()=>{await Promise.resolve();return als.getStore()}),'owned');
      const worker=new Worker('require("node:worker_threads").parentPort.postMessage(42)',{eval:true});
      assert.equal(await new Promise((resolve,reject)=>{worker.once('message',resolve);worker.once('error',reject)}),42);
      await worker.terminate();
      const env=Object.fromEntries(Object.entries(process.env).filter(([key])=>!/^NODE_|^OPENSSL_|^DYLD_|^ELECTRON_RUN_AS_NODE$/i.test(key)));
      const child=spawnSync(process.execPath,['--no-addons','--no-global-search-paths','--eval','process.stdout.write("child-ok")'],{cwd:__dirname,env,encoding:'utf8',timeout:4500});
      assert.equal(child.status,0,child.stderr);assert.equal(child.stdout,'child-ok');
      process.stdout.write('Host modules and exact flags passed');
    })().catch(error=>{console.error(error);process.exitCode=1});
  `);
  const flags = ['--no-addons', '--no-experimental-strip-types', '--no-global-search-paths',
    '--no-experimental-require-module', '--input-type=commonjs', '--eval',
    'require(process.argv.splice(1,1)[0])', '--', probe, 'host-marker'];
  assert.equal(execFileSync(process.execPath, flags, { cwd: temporary, env: clean, timeout: 10000, encoding: 'utf8' }), 'Host modules and exact flags passed');

  const entry = path.join(plugins, 'bundled/codex-desktop-adapter/host.cjs');
  const snapshot = path.join(temporary, 'desktop-snapshot.cjs');
  fs.copyFileSync(entry, snapshot);
  const bootstrap = path.join(core, 'runtime/client-launch.cjs');
  const launch = spawn(process.execPath, [
    '--no-addons', '--no-experimental-strip-types', '--no-global-search-paths',
    '--no-experimental-require-module', bootstrap, entry, snapshot,
  ], { cwd: temporary, env: clean, stdio: ['pipe', 'pipe', 'pipe'] });
  let stderr = '';
  launch.stderr.on('data', bytes => stderr += bytes);
  const closed = new Promise((resolve, reject) => {
    launch.once('error', reject);
    launch.once('close', resolve);
  });
  const reply = new Promise((resolve, reject) => {
    const timer = setTimeout(() => { launch.kill('SIGTERM'); reject(new Error('Client launch prepare timed out: ' + stderr)); }, 5000);
    let pending = '';
    const onData = bytes => {
      pending += bytes;
      const end = pending.indexOf('\n');
      if (end < 0) return;
      clearTimeout(timer);
      launch.stdout.off('data', onData);
      try { resolve(JSON.parse(pending.slice(0, end))); } catch (error) { reject(error); }
    };
    launch.stdout.on('data', onData);
  });
  launch.stdin.write(JSON.stringify({ phase: 'prepare', context: { traffic: { source: {
    version: 1, kind: 'plaintext', endpoint: { host: '127.0.0.1', port: 12345, token: 'fixture' },
    routeBaseUrl: 'http://127.0.0.1:12345/routes/',
  } } } }) + '\n');
  assert.deepEqual(await reply, { ok: true, result: { arguments: ['--inspect-brk=127.0.0.1:0'] } });
  launch.stdin.end();
  assert.equal(await closed, 1, stderr); // The one-phase fixture closes before attach.
  console.log('Reviewed Mac CUA Node modules and Desktop launch prepare passed.');
} finally {
  fs.rmSync(temporary, { recursive: true, force: true });
}
