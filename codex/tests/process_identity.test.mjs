import test from 'node:test';
import assert from 'node:assert/strict';
import { creationTime, sameCreation, childAfterParent, selectOwnedProcesses } from '../scripts/process-identity.mjs';
const at = suffix => '2026-10-11T17:29:45.' + suffix + 'Z';
const row = (pid, parentPid, created) => ({ pid, parentPid, created });

test('creation identity preserves Windows sub-millisecond precision and rejects missing dates', () => {
  assert.equal(sameCreation(at('6800698'), at('680069800')), true);
  assert.equal(sameCreation(at('6800698'), at('6800699')), false);
  assert.equal(childAfterParent(at('6800697'), at('6800698')), false);
  assert.equal(childAfterParent(at('6800698'), at('6800698')), true);
  for (const value of [null, '', 'invalid']) { assert.equal(creationTime(value), null); assert.equal(childAfterParent(value, at('6800698')), false); }
});

test('an old child pointing at a reused root PID cannot import its newer descendants', () => {
  const root = row(10, 1, at('6800698'));
  const rows = [root, row(20, 10, '2026-10-11T12:08:42.4257982Z'), row(21, 20, '2026-10-11T18:00:00Z'),
    row(30, 10, at('6940551')), row(31, 30, at('7000000')), row(0, 0, null)];
  const selected = selectOwnedProcesses(rows, [root]);
  assert.deepEqual(selected.processes.map(value => value.pid), [10, 30, 31]);
  assert.deepEqual(selected.rejectedEdges.map(value => [value.pid, value.reason]), [[20, 'created_before_parent']]);
  assert.equal(selected.processes[2].parentCreated, at('6940551'));
});

test('chronology is checked at every edge, independently of process names and traversal order', () => {
  const root = row(10, 1, at('6800698')), parent = row(30, 10, at('8000000'));
  const rows = [row(31, 30, at('7000000')), row(32, 30, null), { ...row(33, 30, at('9000000')), image: 'Steam.exe' }, parent, root];
  const selected = selectOwnedProcesses(rows, [root]);
  assert.deepEqual(selected.processes.map(value => value.pid), [10, 30, 33]);
  assert.deepEqual(selected.rejectedEdges.map(value => value.pid).sort(), [31, 32]);
});

test('a reused root and an ambiguous snapshot fail instead of selecting another process instance', () => {
  const root = row(10, 1, at('6800698'));
  assert.throws(() => selectOwnedProcesses([row(10, 1, at('6800699'))], [root]), /root identity changed/);
  assert.throws(() => selectOwnedProcesses([root, root], [root]), /Ambiguous/);
});
