import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import crypto from 'node:crypto';
import { spawnSync } from 'node:child_process';
import { fileURLToPath } from 'node:url';

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const artifacts = path.join(root, '.codlet-artifacts/installer-refresh-2026-09-22/macos/initialization-tests');
const sha = bytes => crypto.createHash('sha256').update(bytes).digest('hex');
function fixture() {
  fs.mkdirSync(artifacts, { recursive: true });
  const directory = fs.mkdtempSync(path.join(artifacts, 'case-'));
  const app = path.join(directory, 'Codlet 预览 Preview.app/Contents/Resources');
  const home = path.join(directory, 'User Data 用户目录');
  fs.mkdirSync(app, { recursive: true }); fs.mkdirSync(home);
  fs.copyFileSync(path.join(root, 'scripts/macos/initialize.mjs'), path.join(app, 'initialize.mjs'));
  const fake = `#!/usr/bin/env node
const fs = require('node:fs'), path = require('node:path');
const home = process.env.CODLET_HOME, args = process.argv.slice(2);
fs.appendFileSync(path.join(home, 'calls.jsonl'), JSON.stringify(args)+'\\n');
if(args[1] === 'list') console.log(fs.existsSync(path.join(home,'existing.json')) ? fs.readFileSync(path.join(home,'existing.json'),'utf8') : '{"plugins":[]}');
else { const marker = path.join(home,'added.jsonl'); fs.appendFileSync(marker,JSON.stringify(args)+'\\n'); console.log('{}'); }
`;
  fs.writeFileSync(path.join(app, 'codlet'), fake, { mode: 0o755 });
  const packages = ['codex.ui.adapter', 'codex.desktop.adapter', 'codlet-gui'].map(id => {
    const permissions = id === 'codlet-gui' ? ['ui.dom', 'runtime.manage'] : ['ui.mainWorld'];
    const bytes = Buffer.from(JSON.stringify({ id, version: '1.0.0', permissions, renderer: { entry: 'renderer.js' } }));
    const directory = path.join(app, 'optional-plugins/packages', id); fs.mkdirSync(directory, { recursive: true });
    fs.writeFileSync(path.join(directory, 'codlet.json'), bytes);
    return { id, version: '1.0.0', permissions, files: [{ path: 'codlet.json', sha256: sha(bytes), bytes: bytes.length }] };
  });
  const catalogPath = path.join(app, 'optional-plugins/catalog.json');
  const catalog = { schema: 1, kind: 'codlet-official-plugin-bundle', packages };
  fs.writeFileSync(catalogPath, JSON.stringify(catalog));
  const invoke = selected => spawnSync(process.execPath, [path.join(app, 'initialize.mjs'), ...selected], {
    env: { ...process.env, CODLET_HOME: home }, encoding: 'utf8', timeout: 10000,
  });
  return { app, home, directory, catalogPath, catalog, invoke };
}
const native = { skip: process.platform === 'win32' ? 'Requires a POSIX executable fixture; exercised on the macOS build runner' : false };

test('GUI includes UI Adapter; existing registrations and disabled preferences survive setup', native, () => {
  const f = fixture();
  const existingPath = path.join(f.home, 'packages/codex.ui.adapter');
  fs.mkdirSync(existingPath, { recursive: true });
  fs.copyFileSync(path.join(f.app, 'optional-plugins/packages/codex.ui.adapter/codlet.json'), path.join(existingPath, 'codlet.json'));
  fs.writeFileSync(path.join(f.home, 'existing.json'), JSON.stringify({ plugins: [{ id: 'codex.ui.adapter', enabled: false, source: 'local', path: existingPath }] }));
  fs.writeFileSync(path.join(f.home, 'config.json'), JSON.stringify({ plugins: { 'codlet-gui': { enabled: false } } }));
  const result = f.invoke(['codlet-gui']);
  assert.equal(result.status, 0, result.stderr);
  const added = fs.readFileSync(path.join(f.home, 'added.jsonl'), 'utf8').trim().split('\n').map(JSON.parse);
  assert.equal(added.length, 1); assert.equal(path.basename(added[0][2]), 'codlet-gui');
  assert.ok(!added[0].includes('--enable')); assert.ok(added[0].includes('runtime.manage'));
  const state = JSON.parse(fs.readFileSync(path.join(f.home, 'macos-setup.json')));
  assert.match(result.stdout, /payload already matches/);
  assert.equal(state.decided['codlet-gui'].source, 'official-installer');
  assert.deepEqual(state.decided['codlet-gui'].files, f.catalog.packages.find(pkg => pkg.id === 'codlet-gui').files);
  assert.equal(state.decided['codlet-gui'].catalogSha256, sha(fs.readFileSync(f.catalogPath)));
  assert.equal(state.decided['codex.desktop.adapter'].selected, false);
});

test('explicitly selected legacy and author registrations report migration instead of success', native, () => {
  for (const source of ['local', 'github']) {
    const f = fixture();
    const existingPath = path.join(f.home, 'packages/codex.ui.adapter');
    fs.mkdirSync(existingPath, { recursive: true });
    fs.writeFileSync(path.join(existingPath, 'codlet.json'), 'author changes');
    const config = JSON.stringify({ plugins: { 'codex.ui.adapter': { enabled: false } }, localPlugins: { 'codex.ui.adapter': { path: existingPath, grants: [] } } });
    fs.writeFileSync(path.join(f.home, 'config.json'), config);
    const previousState = JSON.stringify({ schema: 1, decided: { 'codex.ui.adapter': { selected: true, result: 'installed', version: '0.1.0' } } });
    fs.writeFileSync(path.join(f.home, 'macos-setup.json'), previousState);
    fs.writeFileSync(path.join(f.home, 'existing.json'), JSON.stringify({ plugins: [{ id: 'codex.ui.adapter', source, path: existingPath }] }));
    const result = f.invoke(['codex.ui.adapter']);
    assert.equal(result.status, 20);
    assert.match(result.stderr, /官方插件未更新.*手动迁移/);
    assert.equal(fs.readFileSync(path.join(existingPath, 'codlet.json'), 'utf8'), 'author changes');
    assert.equal(fs.readFileSync(path.join(f.home, 'config.json'), 'utf8'), config);
    assert.equal(fs.readFileSync(path.join(f.home, 'macos-setup.json'), 'utf8'), previousState);
    assert.equal(fs.existsSync(path.join(f.home, 'added.jsonl')), false);
  }
});

test('all optional plugins can be declined without registration', native, () => {
  const f = fixture(); const result = f.invoke([]);
  assert.equal(result.status, 0, result.stderr);
  assert.equal(fs.existsSync(path.join(f.home, 'added.jsonl')), false);
  assert.equal(fs.existsSync(path.join(f.home, 'macos-setup.json')), true);
});

test('modified offline plugin bytes are rejected before import', native, () => {
  const f = fixture();
  fs.appendFileSync(path.join(f.app, 'optional-plugins/packages/codex.ui.adapter/codlet.json'), ' ');
  const result = f.invoke(['codex.ui.adapter']);
  assert.notEqual(result.status, 0); assert.match(result.stderr, /payload changed/);
  assert.equal(fs.existsSync(path.join(f.home, 'added.jsonl')), false);
  assert.equal(fs.existsSync(path.join(f.home, 'macos-setup.json')), false);
  assert.equal(fs.existsSync(path.join(f.home, 'macos-setup.lock')), false);
});

test('existing unregistered plugin directories are never overwritten', native, () => {
  const f = fixture(); const directory = path.join(f.home, 'packages/codex.ui.adapter');
  fs.mkdirSync(directory, { recursive: true }); fs.writeFileSync(path.join(directory, 'codlet.json'), 'user content');
  const result = f.invoke(['codex.ui.adapter']);
  assert.notEqual(result.status, 0); assert.equal(fs.readFileSync(path.join(directory, 'codlet.json'), 'utf8'), 'user content');
  assert.equal(fs.existsSync(path.join(f.home, 'added.jsonl')), false);
});

test('a held setup lock is not stolen or deleted', () => {
  const f = fixture(); fs.writeFileSync(path.join(f.home, 'macos-setup.lock'), 'owned elsewhere');
  const result = f.invoke([]);
  assert.notEqual(result.status, 0); assert.match(result.stderr, /Another setup is active/);
  assert.equal(fs.readFileSync(path.join(f.home, 'macos-setup.lock'), 'utf8'), 'owned elsewhere');
});

test('unavailable plugin selection fails before invoking Core', () => {
  const f = fixture(); const result = f.invoke(['unrelated-plugin']);
  assert.notEqual(result.status, 0); assert.match(result.stderr, /unavailable/);
  assert.equal(fs.existsSync(path.join(f.home, 'calls.jsonl')), false);
});

test('symlinked plugin payloads cannot escape the offline package', native, () => {
  const f = fixture(); const file = path.join(f.app, 'optional-plugins/packages/codex.ui.adapter/codlet.json');
  const outside = path.join(f.directory, 'outside.json'); fs.renameSync(file, outside); fs.symlinkSync(outside, file);
  const result = f.invoke(['codex.ui.adapter']);
  assert.notEqual(result.status, 0); assert.match(result.stderr, /Linked setup path/);
  assert.equal(fs.existsSync(path.join(f.home, 'added.jsonl')), false);
});
