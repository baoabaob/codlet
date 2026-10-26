// Real coordinator mailbox code, in-memory process identity, actual temporary files.
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import os from 'node:os';
import vm from 'node:vm';
import test from 'node:test';
import {promisify} from 'node:util';

const source = fs.readFileSync(new URL('../scripts/isolated-client.mjs', import.meta.url), 'utf8').replace(/\r\n/g, '\n');
const code = source.slice(0, source.indexOf('\nvalidateRoot();\n')).replace(/^import .*;\r?\n/gm, '') + '\nps=fixtures.ps;globalThis.stopFixture=stop;globalThis.rehearseFixture=rehearseUpdate;globalThis.probeFixture=probe;';
function fixture(t) {
  const directory = fs.mkdtempSync(path.join(os.tmpdir(), 'codlet-mailbox-'));
  t.after(() => fs.rmSync(directory, {recursive: true}));
  const root = path.join(directory, 'profile'), logs = path.join(root, 'logs/coordinator-123-42');
  fs.mkdirSync(logs, {recursive: true});
  const statePath = path.join(root, 'logs/manual-client.json'), config = path.join(directory, 'config.json');
  fs.writeFileSync(config, JSON.stringify({labRoot: root, labBinary: 'fake', officialCli: path.join(directory, 'fake-cli')}));
  const state = {schema: 1, labRoot: root, runId: '123-42', managerPid: 42, managerCreated: 'created', logs, quitFile: path.join(logs, 'quit.request'), state: 'ready'};
  const publish = () => fs.writeFileSync(statePath, JSON.stringify(state));
  publish();
  const facts = {created: 'created'};
  const context = vm.createContext({fs, path, promisify, execFile() {}, setTimeout, clearTimeout, process: {argv: ['node', 'fixture', 'stop', config], env: {}}, console: {log() {}}, fixtures: {ps: async () => facts}});
  vm.runInContext(code, context);
  return {directory, root, logs, state, statePath, publish, facts, context};
}
test('stop and rehearsal retain one exact mailbox without rewriting repeated requests', async t => {
  const f = fixture(t);
  await f.context.stopFixture();
  const first = fs.statSync(f.state.quitFile);
  await f.context.stopFixture();
  assert.equal(fs.readFileSync(f.state.quitFile, 'utf8'), 'quit\n');
  assert.equal(fs.statSync(f.state.quitFile).mtimeMs, first.mtimeMs);
  await f.context.rehearseFixture();
  assert.equal(fs.readFileSync(path.join(f.logs, 'update-rehearsal.request'), 'utf8'), f.state.runId);
});
test('retired PID generation and escaped run IDs cannot receive a mailbox', async t => {
  const f = fixture(t);
  f.facts.created = 'replacement';
  await assert.rejects(f.context.stopFixture(), /owner has retired/);
  assert.equal(fs.existsSync(f.state.quitFile), false);
  f.facts.created = 'created';
  f.state.runId = '../../../outside'; f.publish();
  await assert.rejects(f.context.stopFixture(), /Invalid coordinator owner/);
  assert.equal(fs.existsSync(path.join(f.directory, 'outside')), false);
});
test('a preexisting hard-linked mailbox is rejected without changing its target', async t => {
  const f = fixture(t), sentinel = path.join(f.directory, 'sentinel');
  fs.writeFileSync(sentinel, 'preserve'); fs.linkSync(sentinel, f.state.quitFile);
  await assert.rejects(f.context.stopFixture(), /plain local file/);
  assert.equal(fs.readFileSync(sentinel, 'utf8'), 'preserve');
});
test('a linked coordinator directory cannot redirect stop outside its owned logs', async t => {
  const f = fixture(t), outside = path.join(f.directory, 'outside'); fs.mkdirSync(outside);
  fs.rmdirSync(f.logs); fs.symlinkSync(outside, f.logs, process.platform === 'win32' ? 'junction' : 'dir');
  try {
    await assert.rejects(f.context.stopFixture(), /plain local file\/directory/);
    assert.deepEqual(fs.readdirSync(outside), []);
  } finally { fs.unlinkSync(f.logs); }
});
test('invalid backend JSON rejects its observing probe and closes the socket', async t => {
  const f = fixture(t);
  for (const response of ['{', 'null']) {
    let closed = false;
    f.context.WebSocket = class {
      listeners = new Map();
      constructor() { queueMicrotask(() => this.listeners.get('open')()); }
      addEventListener(type, callback) { this.listeners.set(type, callback); }
      send() { this.listeners.get('message')({data: response}); }
      close() { closed = true; }
    };
    await assert.rejects(f.context.probeFixture('ws://fixture', 123), /invalid JSON/);
    assert.equal(closed, true);
  }
});
