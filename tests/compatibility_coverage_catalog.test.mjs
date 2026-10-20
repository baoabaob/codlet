import test from 'node:test';
import assert from 'node:assert/strict';
import { fileURLToPath } from 'node:url';
import { createCoverageCatalog, interfaceEntries } from '../scripts/lib/compatibility-coverage.mjs';

test('public declaration inventory ignores comments and nested parameter/result fields', () => {
  const source = '// interface Methods { wrong(): void }\nexport interface Methods { "item.read": { params: { nested: string }; result: { field: boolean } }; open(value: { inner: string }): Promise<{ output: number }>; close?():void; }';
  assert.deepEqual(interfaceEntries(source, 'Methods').map(value => value.name), ['item.read', 'open', 'close']);
  assert.deepEqual(interfaceEntries(source, 'Methods', true).map(value => value.name), ['open', 'close']);
});

test('coverage catalog includes untested public operation families and explicit Native lifecycle gaps', () => {
  const root = fileURLToPath(new URL('../', import.meta.url)), catalog = createCoverageCatalog(root), ids = new Set(catalog.entries.map(value => value.id));
  for (const id of ['core.files.writeAtomic', 'core.desktop.clipboardWrite', 'codex.read.threads.list',
    'codex.write.permissions.update', 'management.checkPluginUpdates', 'workspace.prepare', 'workspace.createNavigation',
    'workspace.navigation.open', 'workspace.viewport.bind', 'native.workspace.full-lifecycle',
    'native.workspace.physical-ime', 'native.traffic.desktop-main-http', 'native.online-update-continuity']) assert.ok(ids.has(id), id);
  assert.equal(ids.size, catalog.entries.length); assert.equal(catalog.defaultStatus, 'not-verified');
  assert.ok(catalog.files.every(value => /^[a-f0-9]{64}$/.test(value.sha256)));
  assert.ok(catalog.entries.length > 150);
});
