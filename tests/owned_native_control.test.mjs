import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import os from 'node:os';
import vm from 'node:vm';
import test from 'node:test';

const source = fs.readFileSync(new URL('../scripts/owned-native-control.mjs', import.meta.url), 'utf8').replace(/^import .*;\r?\n/gm, '');
function fixture(t) {
  const directory = fs.mkdtempSync(path.join(os.tmpdir(), 'codlet-owned-command-'));
  t.after(() => fs.rmSync(directory, {recursive: true}));
  const run = path.join(directory, 'core-12345678-1234-1234-1234-123456789abc');
  const probe = path.join(run, 'profile/project/fixtures/unified-probe');
  fs.mkdirSync(probe, {recursive: true});
  fs.mkdirSync(path.join(run, 'profile/logs'));
  const created = '2026-10-26T00:00:00.0000000Z';
  const creationTime = ((BigInt(Date.parse(created)) + 11644473600000n) * 10000n).toString();
  fs.writeFileSync(path.join(run, 'profile/logs/manual-client.json'), JSON.stringify({state: 'ready', managerPid: 10, managerCreated: created, desktopPid: 20, desktopCreated: creationTime}));
  const report = value => fs.writeFileSync(path.join(probe, 'report.json'), JSON.stringify(value));
  report({lastSequence: 0, actions: []});
  const file = path.join(probe, 'control.json'), lock = path.join(probe, 'control-writer.lock');
  async function execute(action, pause = () => {}, advanceMs = 20001) {
    let now = 0; const outputs = [], errors = [], process = {argv: ['node', 'script', run, action], exitCode: 0, exit(code) { throw Object.assign(Error('fixture exit'), {fixtureExit: code}); }};
    const context = vm.createContext({fs, path, process, Date: {parse: Date.parse, now: () => now}, BigInt,
      captureProcessIdentity: async () => ({creationTime}), delay: async () => { now += advanceMs; await pause(); },
      console: {log: value => outputs.push(JSON.parse(value)), error: value => errors.push(JSON.parse(value))}});
    try { await vm.runInContext('(async()=>{' + source + '\n})()', context); }
    catch (error) { if (error.fixtureExit !== 0) throw error; }
    return {outputs, errors, code: process.exitCode};
  }
  return {run, probe, report, file, lock, execute};
}
test('an admitted original action remains queryable without changing or replaying its command', async t => {
  const f = fixture(t), command = {runId: path.basename(f.run), sequence: 1, action: 'install', params: {}};
  const bytes = JSON.stringify(command); fs.writeFileSync(f.file, bytes);
  f.report({lastSequence: 1, actions: [{sequence: 1, phase: 'admitted'}]});
  const result = await f.execute('query');
  assert.deepEqual(result.outputs[0].pendingCommand, command);
  assert.equal(fs.readFileSync(f.file, 'utf8'), bytes);
  assert.equal(fs.existsSync(f.lock), false);
});
test('a timed-out command not yet admitted blocks a new mutation while its original receipt remains observable', async t => {
  const f = fixture(t), result = await f.execute('install');
  assert.equal(result.code, 2); assert.equal(result.errors[0].outcome, 'unknown');
  const original = fs.readFileSync(f.file, 'utf8');
  await assert.rejects(f.execute('another-install'), /Previous action is unresolved/);
  assert.equal(fs.readFileSync(f.file, 'utf8'), original);
  assert.equal((await f.execute('query')).outputs[0].pendingCommand.sequence, 1);
  f.report({lastSequence: 1, actions: [{sequence: 1, phase: 'settled', result: 'original receipt'}]});
  const query = (await f.execute('query')).outputs[0];
  assert.equal(query.pendingCommand, null); assert.equal(query.actions[0].result, 'original receipt');
});
test('only one writer can submit while queries remain available and the owner releases its lock', async t => {
  const f = fixture(t); let release, entered;
  const paused = new Promise(resolve => {entered = resolve;});
  const first = f.execute('install', async () => {entered(); await new Promise(resolve => {release = resolve;});});
  await paused;
  await assert.rejects(f.execute('other'), {code: 'EEXIST'});
  assert.equal((await f.execute('query')).outputs[0].pendingCommand.action, 'install');
  release(); await first;
  assert.equal(fs.existsSync(f.lock), false);
});
test('a settled operation returns its exact receipt and releases the writer lock', async t => {
  const f = fixture(t);
  const result = await f.execute('install', () => {
    const command = JSON.parse(fs.readFileSync(f.file, 'utf8'));
    f.report({lastSequence: command.sequence, actions: [{sequence: command.sequence, phase: 'settled', result: 'installed once'}]});
  }, 100);
  assert.equal(result.outputs[0].result, 'installed once');
  assert.equal(fs.existsSync(f.lock), false);
});
