import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { spawnSync } from 'node:child_process';
import { fileURLToPath } from 'node:url';
import { digest } from '../scripts/lib/native-source-snapshot.mjs';

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
function temporary(t) {
  const directory = fs.mkdtempSync(path.join(os.tmpdir(), 'codlet-source-output-'));
  t.after(() => fs.rmSync(directory, { recursive: true }));
  return directory;
}
function archive(filename, entries) {
  const payloads = [];
  let offset = 0;
  const files = Object.fromEntries(Object.entries(entries).map(([name, value]) => {
    const bytes = Buffer.from(value), entry = { size: bytes.length, offset: String(offset) };
    offset += bytes.length; payloads.push(bytes);
    return [name, entry];
  }));
  const json = Buffer.from(JSON.stringify({ files: { '.vite': { files: { build: { files } } } } }));
  const headerSize = 8 + Math.ceil(json.length / 4) * 4, prefix = Buffer.alloc(16);
  prefix.writeUInt32LE(4, 0); prefix.writeUInt32LE(headerSize, 4); prefix.writeUInt32LE(json.length, 12);
  fs.writeFileSync(filename, Buffer.concat([prefix, json, Buffer.alloc(8 + headerSize - 16 - json.length), ...payloads]));
}
function run(script, ...args) {
  return spawnSync(process.execPath, [path.join(root, 'scripts', script), ...args], { encoding: 'utf8' });
}

test('legacy isolation extraction rejects archive entry paths before creating output', t => {
  const directory = temporary(t);
  for (const [index, name] of ['../escaped.js', '..\\escaped.js', 'C:escaped.js', '/escaped.js'].entries()) {
    const input = path.join(directory, `input-${index}.asar`), output = path.join(directory, `output-${index}`);
    archive(input, { 'main-a.js': 'const BUILD_FLAVOR="dev";', [name]: 'const BUILD_FLAVOR="dev";' });
    const result = run('extract-isolation-source.mjs', input, output);
    assert.notEqual(result.status, 0);
    assert.match(result.stderr, /Invalid main-process entry name/);
    assert.equal(fs.existsSync(output), false);
  }
  assert.equal(fs.existsSync(path.join(directory, 'escaped.js')), false);
});

test('source excerpts keep role labels inside the chosen output directory', t => {
  const directory = temporary(t), snapshot = path.join(directory, 'snapshot'), output = path.join(directory, 'output');
  const source = 'function a(){return 1}', name = 'webview/assets/source.js';
  fs.mkdirSync(path.join(snapshot, 'sources/webview/assets'), { recursive: true });
  fs.writeFileSync(path.join(snapshot, 'sources', name), source);
  const analysis = path.join(directory, 'analysis.json');
  fs.writeFileSync(analysis, JSON.stringify({ snapshot, identity: {}, roles: { '../../escaped': { candidates: [{
    file: name, sha256: digest(source), local: 'a', type: 'FunctionDeclaration',
    start: { offset: 0 }, end: { offset: source.length }, dependencies: [],
  }] } } }));
  const result = run('native-source-extract.mjs', analysis, 'all', output);
  assert.equal(result.status, 0, result.stderr);
  const evidence = JSON.parse(fs.readFileSync(path.join(output, 'evidence.json')));
  assert.match(evidence.entries[0].excerpt, /^______escaped-0-a\.js$/);
  assert.equal(fs.existsSync(path.join(directory, 'escaped-0-a.js')), false);
  assert.equal(fs.existsSync(path.join(output, evidence.entries[0].excerpt)), true);
});

test('workspace source verification refuses changed snapshot metadata before producing evidence', t => {
  const directory = temporary(t), snapshot = path.join(directory, 'snapshot');
  fs.mkdirSync(snapshot);
  fs.writeFileSync(path.join(snapshot, 'snapshot.json'), JSON.stringify({ files: [] }));
  const analysis = path.join(directory, 'analysis.json'), output = path.join(directory, 'verification.json');
  fs.writeFileSync(analysis, JSON.stringify({ snapshot, snapshotSha256: 'stale', roles: {} }));
  const result = run('verify-native-workspace-source.mjs', analysis, output);
  assert.notEqual(result.status, 0);
  assert.match(result.stderr, /Snapshot metadata changed after analysis/);
  assert.equal(fs.existsSync(output), false);
});
