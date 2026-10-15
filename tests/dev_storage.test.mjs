import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import test from 'node:test';
import {
  assertDevelopmentStorage,
  availableBytes,
  directoryBytes,
  inspectDevelopmentStorage,
} from '../scripts/check-dev-storage.mjs';

function fixture(t) {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'codlet-storage-budget-'));
  t.after(() => fs.rmSync(root, {recursive: true}));
  fs.mkdirSync(path.join(root, 'target'));
  fs.mkdirSync(path.join(root, '.codlet-artifacts'));
  return root;
}

test('storage checks use actual files and preserve outputs when refusing another build', t => {
  const root = fixture(t);
  const binary = path.join(root, 'target', 'test.exe');
  const report = path.join(root, '.codlet-artifacts', 'evidence.json');
  fs.writeFileSync(binary, Buffer.alloc(120));
  fs.writeFileSync(report, 'retained evidence');
  const options = {repoRoot: root, targetDirectory: 'target', limits: {targetBytes: 100, artifactBytes: 100, minimumFreeBytes: 50}, freeBytes: () => 200};
  assert.throws(() => assertDevelopmentStorage(options), error => {
    assert.equal(error.code, 'DEV_STORAGE_BUDGET');
    assert.deepEqual(error.storage.issues, ['target_budget_exceeded']);
    return true;
  });
  assert.equal(fs.statSync(binary).size, 120);
  assert.equal(fs.readFileSync(report, 'utf8'), 'retained evidence');
});

test('shared binaries are counted once and junctions cannot inflate the budget', t => {
  const root = fixture(t);
  const target = path.join(root, 'target');
  const binary = path.join(target, 'one.exe');
  fs.writeFileSync(binary, Buffer.alloc(120));
  fs.linkSync(binary, path.join(target, 'two.exe'));
  const outside = path.join(root, 'outside');
  fs.mkdirSync(outside);
  fs.writeFileSync(path.join(outside, 'unrelated.bin'), Buffer.alloc(240));
  fs.symlinkSync(outside, path.join(target, 'external-cache'), process.platform === 'win32' ? 'junction' : 'dir');
  assert.equal(directoryBytes(target), 120);
});

test('artifact growth and low space on a separate target volume are independent blockers', t => {
  const root = fixture(t);
  const external = path.join(root, 'another-volume', 'new-target');
  fs.writeFileSync(path.join(root, '.codlet-artifacts', 'old-run.zip'), Buffer.alloc(101));
  const result = inspectDevelopmentStorage({repoRoot: root, targetDirectory: external,
    limits: {targetBytes: 100, artifactBytes: 100, minimumFreeBytes: 50},
    freeBytes: directory => directory === external ? 49 : 50});
  assert.equal(result.measured.target.bytes, 0);
  assert.deepEqual(result.issues, ['artifact_budget_exceeded', 'target_volume_low_space']);
  assert.equal(fs.existsSync(external), false);
  assert.ok(availableBytes(external) > 0);
});

test('usage exactly at the budget and free-space boundary is allowed', t => {
  const root = fixture(t);
  fs.writeFileSync(path.join(root, 'target', 'cached.o'), Buffer.alloc(100));
  fs.writeFileSync(path.join(root, '.codlet-artifacts', 'report.json'), Buffer.alloc(100));
  assert.equal(assertDevelopmentStorage({repoRoot: root, targetDirectory: 'target',
    limits: {targetBytes: 100, artifactBytes: 100, minimumFreeBytes: 50},
    freeBytes: () => 50}).ok, true);
});
