import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { spawn } from 'node:child_process';
import { createInterface } from 'node:readline';

// Exercise Core's generated production bootstrap, including all SDK factories.
test('Desktop source entry initializes and shuts down through the standard Core Host ABI', { skip: !process.env.CODLET_CORE_ROOT, timeout: 5000 }, async t => {
  const core = process.env.CODLET_CORE_ROOT;
  const directory = await fs.mkdtemp(path.join(os.tmpdir(), 'codlet-host-abi-'));
  let child,lines,closed;
  t.after(async()=>{
    lines?.close();
    if(child&&child.exitCode===null&&child.signalCode===null){child.kill();await closed;}
    assert.equal(path.dirname(path.resolve(directory)),path.resolve(os.tmpdir()));
    await fs.rm(directory,{recursive:true});
  });
  const entry = fileURLToPath(new URL('../host/desktop-launch.cjs', import.meta.url));
  const snapshot = path.join(directory, 'snapshot.cjs'), bootstrap = path.join(directory, 'bootstrap.cjs');
  const host = await fs.readFile(path.join(core, 'runtime/core-modules/host-bootstrap.cjs'), 'utf8');
  await fs.copyFile(entry, snapshot);
  await fs.writeFile(bootstrap, `process.argv.splice(1, 1);\n${host}`);
  child = spawn(process.execPath, ['--no-addons', '--no-experimental-strip-types', bootstrap, entry, snapshot], { windowsHide: true, stdio: ['pipe', 'pipe', 'pipe'] });
  closed = new Promise(resolve => child.once('close', (code, signal) => resolve({ code, signal })));
  lines = createInterface({ input: child.stdout });
  const pending = new Map(); let stderr = '';
  child.stderr.on('data', bytes => { stderr += bytes.toString(); });
  const identity = { v: 1, pluginId: 'codlet-desktop-adapter', generation: 1 };
  lines.on('line', line => {
    const message = JSON.parse(line);
    if (message.type === 'request') child.stdin.write(JSON.stringify({ ...identity, type: 'response', id: message.id, ok: true, result: {} }) + '\n');
    else if (message.type === 'response') { pending.get(message.id)?.(message); pending.delete(message.id); }
  });
  const call = (id, method, params) => new Promise(resolve => { pending.set(id, resolve); child.stdin.write(JSON.stringify({ ...identity, type: 'request', id, method, params }) + '\n'); });
  const initialized = await call(1, 'initialize', { protocolVersion: 1, pluginVersion: 'fixture', provides: [{ name: 'codlet.client.launch', api: 1, scope: 'runtime' }], requires: [] });
  assert.equal(initialized.ok, true, JSON.stringify(initialized.error));
  assert.equal(initialized.result.ready, true);
  const shutdown = await call(2, 'shutdown', { cleanupBudgetMs: 1000 });
  assert.equal(shutdown.ok, true, JSON.stringify(shutdown.error));
  assert.deepEqual(await closed, { code: 0, signal: null }, stderr);
});
