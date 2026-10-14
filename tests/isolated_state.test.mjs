import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import test from 'node:test';
import { atomicJson } from '../scripts/isolated-state.mjs';

function fixture(t) {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'codlet-state-test-'));
  t.after(() => {
    assert.equal(path.dirname(path.resolve(root)), path.resolve(os.tmpdir()));
    assert.ok(path.basename(root).startsWith('codlet-state-test-'));
    fs.rmSync(root, { recursive: true, maxRetries: 10, retryDelay: 20 });
  });
  return { root, file: path.join(root, 'state.json') };
}
const denied = code => Object.assign(new Error('injected ' + code), { code });

test('Windows sharing failures retry the same complete temp then atomically replace the old state', t => {
  const { file } = fixture(t); fs.writeFileSync(file, 'previous');
  const delays = [], temps = []; let attempts = 0;
  atomicJson(file, { state: 'ready' }, { platform: 'win32', sleep: ms => delays.push(ms), io: { ...fs, renameSync(from, to) {
    temps.push(from);
    assert.equal(fs.readFileSync(to, 'utf8'), 'previous');
    assert.deepEqual(JSON.parse(fs.readFileSync(from)), { state: 'ready' });
    if (attempts++ < 3) throw denied(['EPERM', 'EACCES', 'EBUSY'][attempts - 1]);
    fs.renameSync(from, to);
  } } });
  assert.deepEqual(delays, [10, 20, 40]); assert.equal(new Set(temps).size, 1);
  assert.deepEqual(JSON.parse(fs.readFileSync(file)), { state: 'ready' });
  assert.equal(fs.existsSync(temps[0]), false);
});

test('permanent denial is bounded, preserves the original and failed bytes, and does not poison a later publication', t => {
  const { root, file } = fixture(t); fs.writeFileSync(file, 'previous');
  const legacy = file + '.' + process.pid + '.tmp'; fs.writeFileSync(legacy, 'historical ready evidence');
  let attempts = 0, slept = 0, failure;
  try { atomicJson(file, { state: 'ready' }, { platform: 'win32', sleep: ms => { slept += ms; }, io: { ...fs, renameSync() { attempts++; throw denied('EPERM'); } } }); }
  catch (error) { failure = error; }
  assert.equal(failure.code, 'EPERM'); assert.equal(attempts, 8); assert.equal(slept, 810);
  assert.equal(fs.readFileSync(file, 'utf8'), 'previous');
  assert.equal(fs.readFileSync(legacy, 'utf8'), 'historical ready evidence');
  assert.deepEqual(JSON.parse(fs.readFileSync(failure.stateTemporary)), { state: 'ready' });
  atomicJson(file, { state: 'failed', error: failure.message });
  assert.equal(JSON.parse(fs.readFileSync(file)).state, 'failed');
  assert.equal(fs.existsSync(failure.stateTemporary), true);
  assert.equal(fs.readdirSync(root).length, 3);
});

test('non-sharing errors and non-Windows failures do not retry', t => {
  const { file } = fixture(t);
  for (const [platform, code] of [['win32', 'ENOSPC'], ['linux', 'EPERM']]) {
    let attempts = 0;
    assert.throws(() => atomicJson(file, {}, { platform, sleep() { assert.fail('unexpected retry'); }, io: { ...fs, renameSync() { attempts++; throw denied(code); } } }), { code });
    assert.equal(attempts, 1); assert.equal(fs.existsSync(file), false);
  }
});

test('exclusive temp collision uses a fresh name without altering the colliding file', t => {
  const { file } = fixture(t), collision = file + '.' + process.pid + '.collision.tmp';
  fs.writeFileSync(collision, 'unowned'); let sequence = 0;
  atomicJson(file, {}, { nonce: () => sequence++ ? 'fresh' : 'collision' });
  assert.equal(fs.readFileSync(collision, 'utf8'), 'unowned'); assert.equal(sequence, 2);
});

test('write failure closes its descriptor and leaves the original destination intact', t => {
  const { file } = fixture(t); fs.writeFileSync(file, 'previous'); let closed = false;
  assert.throws(() => atomicJson(file, {}, { io: { ...fs, writeFileSync() { throw denied('ENOSPC'); }, closeSync(fd) { closed = true; fs.closeSync(fd); }, renameSync() { assert.fail('rename after write failure'); } } }), { code: 'ENOSPC' });
  assert.equal(closed, true); assert.equal(fs.readFileSync(file, 'utf8'), 'previous');
});

test('existing hardlinked state and a redirected parent directory are rejected without writes', t => {
  const { root, file } = fixture(t); fs.writeFileSync(file, 'previous');
  fs.linkSync(file, path.join(root, 'other-link'));
  assert.throws(() => atomicJson(file, {}), /single-link/);
  assert.equal(fs.readFileSync(file, 'utf8'), 'previous');
  const real = path.join(root, 'real'), junction = path.join(root, 'redirect'); fs.mkdirSync(real);
  fs.symlinkSync(real, junction, process.platform === 'win32' ? 'junction' : 'dir');
  assert.throws(() => atomicJson(path.join(junction, 'state.json'), {}), /directory is not plain/);
  assert.deepEqual(fs.readdirSync(real), []);
});

test('directory identity is rechecked before rename retry', t => {
  const { root, file } = fixture(t); let changed = false, attempts = 0;
  assert.throws(() => atomicJson(file, {}, { platform: 'win32', sleep() { changed = true; }, io: { ...fs,
    lstatSync(p, options) { const stat = fs.lstatSync(p, options); if (changed && p === root) stat.ino += 1n; return stat; },
    renameSync() { attempts++; throw denied('EPERM'); },
  } }), /directory identity changed/);
  assert.equal(attempts, 1); assert.equal(fs.existsSync(file), false);
});

test('an exchanged temporary inode is never published', t => {
  const { file } = fixture(t);
  assert.throws(() => atomicJson(file, {}, { io: { ...fs, lstatSync(p, options) { const stat = fs.lstatSync(p, options); if (p.endsWith('.tmp')) stat.ino += 1n; return stat; }, renameSync() { assert.fail('published a replaced temp'); } } }), /temporary identity changed/);
  assert.equal(fs.existsSync(file), false);
});

test('distribution includes the new publisher dependency', () => {
  assert.match(fs.readFileSync(new URL('../scripts/Build-IsolatedClient.ps1', import.meta.url), 'utf8'), /Copy-Item[^\n]*'isolated-state\.mjs'/);
});
