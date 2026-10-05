// Runs only the reviewed independent CUA Node from a disposable official app.
// The official GUI executable and account data are never opened.
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { execFileSync, spawn } from 'node:child_process';

const core = path.resolve(process.argv[2] ?? '');
const plugins = process.argv[3] ? path.resolve(process.argv[3]) : null;
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

  const entry = plugins ? path.join(plugins, 'bundled/codex-desktop-adapter/host.cjs') : path.join(temporary, 'launch-fixture.cjs');
  const fixtureCode = 'module.exports = {fixture: true};';
  if (!plugins) fs.writeFileSync(entry, `exports.clientSource = ({signal}) => {
    if (!(signal instanceof AbortSignal) || signal.aborted) throw Error('source signal missing');
    return {code: ${JSON.stringify(fixtureCode)}};
  };`);
  const snapshot = path.join(temporary, 'desktop-snapshot.cjs');
  fs.copyFileSync(entry, snapshot);
  const bootstrap = path.join(core, 'runtime/client-launch.cjs');
  const launch = spawn(process.execPath, [
    '--no-addons', '--no-experimental-strip-types', '--no-global-search-paths',
    '--no-experimental-require-module', bootstrap, entry, snapshot,
  ], { cwd: temporary, env: clean, stdio: ['pipe', 'pipe', 'pipe'] });
  const reply = await new Promise((resolve, reject) => {
    let stdout = '', stderr = '';
    const timer = setTimeout(() => { launch.kill('SIGTERM'); reject(new Error('Client source timed out: ' + stderr)); }, 5000);
    launch.stdout.on('data', bytes => stdout += bytes);
    launch.stderr.on('data', bytes => stderr += bytes);
    launch.once('error', error => { clearTimeout(timer); reject(error); });
    launch.once('close', code => {
      clearTimeout(timer);
      try { assert.equal(code, 0, 'Client source exited: ' + stderr); resolve(JSON.parse(stdout)); }
      catch (error) { reject(error); }
    });
    launch.stdin.write(JSON.stringify({phase: 'source', context: {}}) + '\n');
  });
  assert.equal(reply.ok, true);
  assert.equal(typeof reply.result.code, 'string');
  assert.ok(reply.result.code.length > 0);
  if (!plugins) assert.deepEqual(reply.result, {code: fixtureCode});
  console.log('Reviewed Mac CUA Node modules and Core clientSource ABI passed.');
} finally {
  assert.equal(path.dirname(path.resolve(temporary)), path.resolve(os.tmpdir()));
  fs.rmSync(temporary, { recursive: true });
}
