import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { spawnSync } from 'node:child_process';
import { acceptanceGuiPath, prepareAcceptancePlugins } from '../scripts/desktop-acceptance-plugins.mjs';

function fixture(t) {
  const directory = fs.mkdtempSync(path.join(os.tmpdir(), 'codlet-acceptance-registry-'));
  t.after(() => fs.rmSync(directory, { recursive: true }));
  const plugin = (name, id, permissions = []) => {
    const source = path.join(directory, name); fs.mkdirSync(source);
    fs.writeFileSync(path.join(source, 'codlet.json'), JSON.stringify({ id, permissions }));
    return source;
  };
  return { directory, plugin };
}

test('acceptance registers the GUI and explicit copied consumers with scoped grants, without external Core providers', t => {
  const { directory, plugin } = fixture(t), guiPlugin = plugin('gui', 'codlet-gui', ['ui.dom']);
  const source = plugin('consumer', 'owned.consumer', ['host.network']);
  const root = path.join(directory, 'run'); fs.mkdirSync(root);
  const registry = prepareAcceptancePlugins({ guiPlugin, extraPlugins: [source] }, { root, baseUrl: 'http://127.0.0.1:32100/v1' });
  assert.deepEqual(Object.keys(registry.localPlugins), ['codlet-gui', 'owned.consumer']);
  assert.equal(registry.localPlugins['codlet-gui'].path, guiPlugin);
  assert.deepEqual(registry.localPlugins['owned.consumer'].brokerPolicy, { networkOrigins: ['http://127.0.0.1:32100'] });
  const copy = registry.localPlugins['owned.consumer'].path;
  assert.notEqual(copy, source);
  assert.deepEqual(JSON.parse(fs.readFileSync(path.join(copy, 'fixture.json'))), { baseUrl: 'http://127.0.0.1:32100/v1', autorun: false });
  assert.equal(fs.existsSync(path.join(source, 'fixture.json')), false);
});

test('legacy GUI source selection never requests retired adapter directories and internal IDs cannot be registered as extras', t => {
  const { directory, plugin } = fixture(t), pluginsRoot = path.join(directory, 'legacy');
  assert.equal(acceptanceGuiPath({ pluginsRoot }), path.join(pluginsRoot, 'bundled/codlet'));
  assert.throws(() => acceptanceGuiPath({ guiPlugin: 'relative' }), /absolute GUI/);
  const guiPlugin = plugin('gui', 'codlet-gui');
  for (const id of ['codex.desktop.adapter', 'codex.ui.adapter']) {
    const source = plugin(id, id);
    assert.throws(() => prepareAcceptancePlugins({ guiPlugin, extraPlugins: [source] }, { root: directory }), /internal/);
  }
  assert.equal(fs.existsSync(path.join(directory, 'fixture-plugins')), false);
});

test('fixture policy preserves explicit process selections and clientPermissions-only compatibility without ambient defaults', t => {
  const { directory, plugin } = fixture(t), guiPlugin = plugin('gui', 'codlet-gui');
  const source = plugin('consumer', 'owned.consumer', ['host.process.spawn']);
  const policies = [
    { clientPermissions: true },
    { clientPermissions: true, executables: [process.execPath], cwdRoots: [directory], envKeys: ['OWNED_FIXTURE_VALUE'] },
    { clientPermissions: true, executables: [], cwdRoots: [], envKeys: [] },
  ];
  for (const [index, policy] of policies.entries()) {
    const registry = prepareAcceptancePlugins({ guiPlugin, extraPlugins: [source], extraPluginPolicies: { 'owned.consumer': policy } },
      { root: path.join(directory, 'run-' + index), baseUrl: 'http://127.0.0.1:32100/v1' });
    assert.deepEqual(registry.localPlugins['owned.consumer'].brokerPolicy, policy);
    assert.deepEqual(registry.localPlugins['owned.consumer'].grants, ['host.process.spawn']);
  }
});

test('invalid broker selections fail before any fixture copy or fixture settings write', t => {
  const { directory, plugin } = fixture(t), guiPlugin = plugin('gui', 'codlet-gui');
  const source = plugin('consumer', 'owned.consumer', ['host.process.spawn']);
  const policies = [
    null, false, [], {}, { clientPermissions: false }, { executables: [process.execPath] },
    { clientPermissions: true, executables: 'node' }, { clientPermissions: true, executables: ['node'] },
    { clientPermissions: true, executables: [process.execPath, process.execPath] },
    { clientPermissions: true, cwdRoots: [path.join(directory, 'child') + path.sep + '..'] },
    { clientPermissions: true, cwdRoots: ['relative'] }, { clientPermissions: true, cwdRoots: [1] },
    { clientPermissions: true, cwdRoots: [directory + '\0'] }, { clientPermissions: true, cwdRoots: [directory + '\ud800'] },
    { clientPermissions: true, envKeys: null }, { clientPermissions: true, envKeys: [''] },
    { clientPermissions: true, envKeys: ['WITH=VALUE'] }, { clientPermissions: true, envKeys: ['1BAD'] },
    { clientPermissions: true, envKeys: ['bad\nkey'] }, { clientPermissions: true, envKeys: ['x'.repeat(129)] },
    { clientPermissions: true, envKeys: ['SAME', 'SAME'] },
    { clientPermissions: true, envKeys: Array.from({ length: 33 }, (_, index) => 'KEY_' + index) },
    ...(process.platform === 'win32' ? [
      { clientPermissions: true, executables: [path.join(directory, 'node.cmd')] },
      { clientPermissions: true, cwdRoots: ['\\\\server\\share\\directory'] },
      { clientPermissions: true, cwdRoots: [directory + '\\CON'] },
      { clientPermissions: true, cwdRoots: [directory + '\\alternate:stream'] },
    ] : []),
  ];
  for (const [index, policy] of policies.entries()) {
    const root = path.join(directory, 'rejected-' + index);
    assert.throws(() => prepareAcceptancePlugins({ guiPlugin, extraPlugins: [source], extraPluginPolicies: { 'owned.consumer': policy } },
      { root }), /extraPluginPolicies|invalid explicit/, 'invalid policy #' + index);
    assert.equal(fs.existsSync(root), false, 'policy rejected before copy #' + index);
  }
  assert.equal(fs.existsSync(path.join(source, 'fixture.json')), false);
});

test('unknown broker policy keys cannot grant unrelated scope or create a copied fixture', t => {
  const { directory, plugin } = fixture(t), guiPlugin = plugin('gui', 'codlet-gui');
  const source = plugin('consumer', 'owned.consumer');
  for (const key of ['readRoots', 'networkOrigins', 'shortcuts', 'executable', 'environment']) {
    const root = path.join(directory, key);
    assert.throws(() => prepareAcceptancePlugins({ guiPlugin, extraPlugins: [source],
      extraPluginPolicies: { 'owned.consumer': { clientPermissions: true, [key]: [] } } }, { root }), /extraPluginPolicies/);
    assert.equal(fs.existsSync(root), false);
  }
});

test('startup fixture preparation copies only GUI and consumer inputs and cannot override the embedded Core launch source', t => {
  const { directory, plugin } = fixture(t), guiPlugin = plugin('gui', 'codlet-gui');
  const output = path.join(directory, 'prepared');
  const script = new URL('../codex/tests/fixtures/traffic/windows-startup-bootstrap/prepare.mjs', import.meta.url);
  const result = spawnSync(process.execPath, [fileURLToPath(script), output, guiPlugin], { encoding: 'utf8', windowsHide: true });
  assert.equal(result.status, 0, result.stderr);
  assert.deepEqual(fs.readdirSync(output).sort(), ['config.example.json', 'consumer', 'gui', 'probe.js']);
  const config = JSON.parse(fs.readFileSync(path.join(output, 'config.example.json')));
  assert.equal(config.guiPlugin, path.join(output, 'gui'));
  assert.equal(config.pluginsRoot, undefined);
  assert.equal(config.disposableWindowsHost, false);
  assert.deepEqual(config.extraPlugins, [path.join(output, 'consumer')]);
});
