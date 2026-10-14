import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import cp from 'node:child_process';
import { EventEmitter } from 'node:events';
import { createRequire } from 'node:module';
const require = createRequire(import.meta.url), Module = require('node:module');
test('acceptance guard blocks fragmented sandbox setup RPC and preserves UTF-8 model requests', async () => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'codlet-bootstrap-guard-'));
  fs.writeFileSync(path.join(root, 'owner.txt'), 'codlet-desktop-acceptance\n');
  const original = cp.spawn, previous = process.env.CODLET_ACCEPTANCE_ROOT;
  const forwarded = [], responses = [];
  const peer = { stdin: { write(value, callback) { forwarded.push(value); callback?.(); return true; } }, stdout: new EventEmitter() };
  peer.stdout.on('data', bytes => responses.push(JSON.parse(bytes.toString())));
  try {
    process.env.CODLET_ACCEPTANCE_ROOT = root;
    cp.spawn = () => peer;
    const entry = new URL('./fixtures/traffic/windows-startup-bootstrap/guarded-main.cjs', import.meta.url);
    const plugin = new Module(entry.pathname);
    plugin.require = name => name.endsWith('/host/electron-main.cjs') ? {} : require(name);
    plugin._compile(fs.readFileSync(entry, 'utf8'), entry.pathname);
    const child = cp.spawn('codex.exe', ['app-server']);
    const body = Buffer.from(JSON.stringify({ id: 1, method: 'turn/start', params: { text: '测试' } }) + '\n'
      + JSON.stringify({ id: 2, method: 'windowsSandbox/setupStart', params: { mode: 'elevated' } }) + '\n');
    for (const byte of body) child.stdin.write(Buffer.from([byte]));
    await new Promise(resolve => setImmediate(resolve));
    assert.deepEqual(forwarded.map(line => JSON.parse(line)), [{ id: 1, method: 'turn/start', params: { text: '测试' } }]);
    assert.equal(responses.length, 1); assert.equal(responses[0].id, 2); assert.equal(responses[0].error.code, -32000);
    assert.equal(fs.readFileSync(path.join(root, 'blocked-sandbox-setup.jsonl'), 'utf8'), '{"blocked":true}\n');
  } finally {
    cp.spawn = original;
    if (previous === undefined) delete process.env.CODLET_ACCEPTANCE_ROOT; else process.env.CODLET_ACCEPTANCE_ROOT = previous;
    fs.unlinkSync(path.join(root, 'owner.txt'));
    const report = path.join(root, 'blocked-sandbox-setup.jsonl'); if (fs.existsSync(report)) fs.unlinkSync(report);
    fs.rmdirSync(root);
  }
});
