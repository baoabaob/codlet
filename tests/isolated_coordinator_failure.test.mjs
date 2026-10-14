// Runs the real coordinator's start/publish/pump/cleanup code in a VM. The OS
// boundaries are in-memory children and probes; no executable or client starts.
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import os from 'node:os';
import vm from 'node:vm';
import { EventEmitter } from 'node:events';
import { PassThrough, Writable } from 'node:stream';
import { createHash, randomBytes } from 'node:crypto';
import { promisify } from 'node:util';
import test from 'node:test';
import { atomicJson } from '../scripts/isolated-state.mjs';
import { backendReadiness, onboardingRestartRequired } from '../scripts/isolated-readiness.mjs';

const source = fs.readFileSync(new URL('../scripts/isolated-client.mjs', import.meta.url), 'utf8').replace(/\r\n/g, '\n');
assert.ok(source.includes('\nvalidateRoot();\n'));
const code = "'use strict';\n" + source.slice(0, source.indexOf('\nvalidateRoot();\n')).replace(/^import .*;\r?\n/gm, '') + `
snapshot = fixtures.snapshot; ps = fixtures.ps; freePort = fixtures.freePort;
verifyListener = fixtures.verifyListener; probe = fixtures.probe;
globalThis.startFixture = start;
`;

async function run(t, mode, { stale = false, recover = false } = {}) {
  const base = fs.mkdtempSync(path.join(os.tmpdir(), 'codlet-coordinator-test-'));
  t.after(() => {
    assert.equal(path.dirname(path.resolve(base)), path.resolve(os.tmpdir()));
    assert.ok(path.basename(base).startsWith('codlet-coordinator-test-'));
    fs.rmSync(base, { recursive: true, maxRetries: 10, retryDelay: 20 });
  });
  const root = path.join(base, 'profile'), logs = path.join(root, 'logs'), runLogs = path.join(logs, 'run-fixture');
  fs.mkdirSync(runLogs, { recursive: true }); fs.mkdirSync(path.join(root, 'project'));
  const previousReport = path.join(logs, 'report.jsonl'); fs.writeFileSync(previousReport, 'historical report evidence');
  const manifest = path.join(runLogs, 'environment.json'); fs.writeFileSync(manifest, JSON.stringify({ CODEX_HOME: path.join(root, 'codex-home') }));
  const official = path.join(base, 'fake-cli'); fs.writeFileSync(official, 'not an executable');
  const configFile = path.join(base, 'config.json');
  fs.writeFileSync(configFile, JSON.stringify({ labRoot: root, labBinary: 'fake-lab', officialCli: official, officialCliSha256: createHash('sha256').update('not an executable').digest('hex'), expectedPackageVersion: 'fixture' }));
  const manual = path.join(logs, 'manual-client.json');
  if (stale) fs.writeFileSync(manual, JSON.stringify({ state: 'starting', managerPid: 99999, managerCreated: 'old' }));
  const actions = [], stdout = [], stderr = [], delays = [], children = [], attempts = [];
  let lab, backend, readyFailed = false;
  const failure = (message, code = 'EPERM') => Object.assign(new Error(message), { code });
  const finish = child => {
    if (child.exitCode !== null) return;
    child.exitCode = 0; child.stdout.end(); child.stderr.end(); child.emit('exit', 0, null); actions.push(child.label + ':exit');
  };
  const io = { ...fs,
    createWriteStream() { const log = new PassThrough(); log.resume(); return log; },
    renameSync(from, to) {
      const value = JSON.parse(fs.readFileSync(from)); const shared = to === manual;
      attempts.push({ state: value.state, shared, error: value.error });
      const failReady = value.state === 'ready' && ((!shared && ['ready', 'ready-final', 'waiting', 'quit-error'].includes(mode)) || (shared && mode === 'manual-ready'));
      if (failReady) { readyFailed = true; throw failure('injected original ready EPERM'); }
      if (mode === 'event' && value.state === 'starting' && value.desktopPid && !shared) throw failure('injected stdout publication EPERM');
      if ((mode === 'ready-final' && value.state === 'failed') || (mode === 'waiting' && value.state === 'needs_attention')) throw failure('injected secondary publication EACCES', 'EACCES');
      if (mode === 'final-run' && !shared && value.state === 'closed') throw failure('injected final run publication EPERM');
      fs.renameSync(from, to); actions.push('publish:' + value.state + (shared ? ':manual' : ':run'));
      if (shared && value.state === 'ready') queueMicrotask(() => finish(lab));
    },
  };
  function spawn(file, args) {
    const child = new EventEmitter(); child.label = children.length ? 'backend' : 'lab';
    child.pid = children.length ? 7002 : 7001; child.exitCode = null; child.signalCode = null;
    child.stdout = new PassThrough(); child.stderr = new PassThrough();
    child.stdin = new Writable({ write(bytes, encoding, done) {
      const command = String(bytes).trim(); actions.push(child.label + ':' + command);
      if (command === 'start') queueMicrotask(() => {
        child.stdout.write(JSON.stringify({ event: 'child_created', child_pid: 7003, detail: { creation_time_windows_100ns: '134362925734919075' } }) + '\n');
        child.stdout.write(JSON.stringify({ event: 'startup_verified' }) + '\n');
        child.stdout.write(JSON.stringify({ event: 'plugin_runtime_ready' }) + '\n');
        if (mode === 'stream') child.stderr.emit('error', failure('injected stream error', 'EIO'));
      });
      if (command === 'quit' && mode !== 'waiting') queueMicrotask(() => finish(child));
      done();
    } });
    if (mode === 'quit-error') {
      const write = child.stdin.write.bind(child.stdin);
      child.stdin.write = data => {
        if (String(data) === 'quit\n') { queueMicrotask(() => finish(child)); throw failure('injected quit write error', 'EPIPE'); }
        return write(data);
      };
    }
    child.kill = signal => {
      assert.equal(child, backend); assert.equal(signal, 'SIGTERM');
      assert.equal(lab.exitCode, 0, 'never stop backend before retained lab exits');
      actions.push('backend:kill'); queueMicrotask(() => finish(child)); return true;
    };
    children.push({ file, args, child });
    if (child.label === 'lab') {
      lab = child;
      queueMicrotask(() => child.stdout.write(JSON.stringify({ event: 'prepared', detail: { root, requested_app_server_url: 'ws://127.0.0.1:42000', resumed_profile: true, environment_manifest: manifest, run_logs: runLogs } }) + '\n'));
    } else backend = child;
    return child;
  }
  const processStub = { argv: ['node', 'fixture', 'start', configFile], pid: 4242, env: {}, exitCode: 0 };
  const context = vm.createContext({ fs: io, path, net: {}, createHash, randomBytes, spawn, execFile() { assert.fail('Real OS probe attempted'); }, promisify,
    atomicJson: (file, value) => atomicJson(file, value, { io, platform: 'win32', sleep: ms => delays.push(ms) }),
    backendReadiness, onboardingRestartRequired, process: processStub, console: {
      log: text => stdout.push(text), error: text => {
        stderr.push(text);
        if (text.includes('Owned test Desktop still running.')) {
          actions.push('waiting-for-lab'); assert.equal(backend.exitCode, null); queueMicrotask(() => finish(lab));
        }
      },
    }, Buffer, setTimeout, clearTimeout, fixtures: {
      snapshot: async () => [], ps: async text => text.includes('$codletStarted=') ? { created: 'fixture-created', filetime: '1234' } : null,
      freePort: async () => 42000, verifyListener: async () => ({ pid: 7002 }),
      probe: async () => ({ initialized: true, authenticated: true, fileCredentialStore: true, readOnlyBackend: true, desktopAppToolsDisabled: true, windowsReadiness: 'ready', windowsMode: 'elevated', originRejected: true }),
    },
    // Yield to mocked pipe/end events, but never sleep for the production timeout.
    delay: async () => new Promise(resolve => setImmediate(resolve)),
  });
  vm.runInContext(code, context, { filename: 'isolated-client.mjs' });
  const restart = await context.startFixture(recover);
  assert.equal(restart, false); assert.equal(children.length, 2);
  assert.equal(lab.exitCode, 0); assert.equal(backend.exitCode, 0);
  assert.ok(actions.indexOf('backend:kill') > actions.indexOf('lab:exit'));
  assert.equal(fs.readFileSync(previousReport, 'utf8'), 'historical report evidence');
  const coordinator = fs.readdirSync(logs).find(name => name.startsWith('coordinator-'));
  return { root, logs: path.join(logs, coordinator), manual, processStub, actions, stdout, stderr, delays, attempts, readyFailed, children };
}

test('ready publish EPERM reaches owned cleanup and remains the recorded first error', async t => {
  const r = await run(t, 'ready'); const state = JSON.parse(fs.readFileSync(r.manual));
  assert.equal(r.processStub.exitCode, 1); assert.equal(state.state, 'failed');
  assert.equal(state.error, 'injected original ready EPERM'); assert.equal(state.hostExit.code, 0);
  assert.match(state.backendStop, /stopped/); assert.ok(fs.existsSync(state.unpublishedTemporary));
  assert.ok(r.actions.includes('lab:quit'));
});

test('permanent catch/final publication failures neither skip cleanup nor mask the ready failure', async t => {
  const r = await run(t, 'ready-final');
  assert.equal(r.processStub.exitCode, 1);
  assert.equal(JSON.parse(fs.readFileSync(r.manual)).state, 'starting');
  assert.equal(JSON.parse(fs.readFileSync(path.join(r.logs, 'state.json'))).state, 'starting');
  assert.equal(JSON.parse(r.stdout.at(-1)).error, 'injected original ready EPERM');
  assert.ok(r.stderr.some(line => line.includes('state files may be stale')));
  assert.ok(r.attempts.some(a => a.state === 'failed' && a.shared));
  assert.equal(r.delays.reduce((a, b) => a + b, 0), 810 * 3);
  assert.doesNotMatch(r.stderr.join('\n'), /EEXIST/);
});

test('manual pointer failure after run-state success still cleans up and publishes failed status', async t => {
  const r = await run(t, 'manual-ready');
  assert.ok(r.actions.includes('publish:ready:run'));
  assert.equal(JSON.parse(fs.readFileSync(r.manual)).state, 'failed');
  assert.equal(JSON.parse(fs.readFileSync(path.join(r.logs, 'state.json'))).state, 'failed');
  assert.equal(JSON.parse(r.stdout.at(-1)).error, 'injected original ready EPERM');
});

test('stdout callback publication failure is handled by start, without an uncaught event exception', async t => {
  const r = await run(t, 'event'); const state = JSON.parse(fs.readFileSync(r.manual));
  assert.equal(state.state, 'failed'); assert.equal(state.error, 'injected stdout publication EPERM');
  assert.equal(state.desktopCreated, '134362925734919075'); assert.equal(r.processStub.exitCode, 1);
});

test('needs-attention publication can fail while the manager still retains backend until Desktop exits', async t => {
  const r = await run(t, 'waiting');
  assert.ok(r.actions.includes('waiting-for-lab'));
  assert.ok(r.actions.indexOf('backend:kill') > r.actions.indexOf('waiting-for-lab'));
  assert.equal(JSON.parse(r.stdout.at(-1)).error, 'injected original ready EPERM');
});

test('quit write failure is secondary and does not prevent waiting or backend cleanup', async t => {
  const r = await run(t, 'quit-error'); const state = JSON.parse(fs.readFileSync(r.manual));
  assert.equal(state.error, 'injected original ready EPERM');
  assert.ok(state.cleanupErrors.some(error => error.code === 'EPIPE'));
  assert.equal(state.hostExit.code, 0); assert.match(state.backendStop, /stopped/);
});

test('stream failures enter the same cleanup path', async t => {
  const r = await run(t, 'stream'); const state = JSON.parse(fs.readFileSync(r.manual));
  assert.equal(state.state, 'failed'); assert.equal(state.error, 'injected stream error');
});

test('a final run-state failure still attempts the manual pointer and reports publication failure', async t => {
  const r = await run(t, 'final-run'); const state = JSON.parse(fs.readFileSync(r.manual));
  assert.equal(state.state, 'failed'); assert.match(state.error, /final run publication/);
  assert.equal(state.hostExit.code, 0); assert.equal(r.processStub.exitCode, 1);
});

test('normal close still records confirmed exits and explicit recovery forwards only to the new mocked owner', async t => {
  const r = await run(t, 'normal', { stale: true, recover: true }); const state = JSON.parse(fs.readFileSync(r.manual));
  assert.equal(state.state, 'closed'); assert.equal(state.hostExit.code, 0); assert.equal(r.processStub.exitCode, 0);
  assert.ok(r.children[0].args.includes('--recover-interrupted')); assert.equal(state.managerPid, 4242);
});
