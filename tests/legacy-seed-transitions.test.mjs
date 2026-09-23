import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
const legacy = JSON.parse(fs.readFileSync(new URL('../scripts/distribution/legacy-official-seeds.json', import.meta.url)));
const transitions = JSON.parse(fs.readFileSync(new URL('../scripts/distribution/legacy-official-transitions.json', import.meta.url)));

test('only the two documented official runtime/README transitions are trusted', () => {
  assert.deepEqual(transitions.map(p => p.id).sort(), ['codex.ui.adapter', 'codlet-gui']);
  for (const transition of transitions) {
    const runtime = legacy.find(p => p.id === transition.id && p.sourceRevision === transition.sourceRevision && p.catalogSha256 === transition.runtimeCatalogSha256);
    const readme = legacy.find(p => p.id === transition.id && p.sourceRevision === transition.readmeSourceRevision && p.catalogSha256 === transition.readmeCatalogSha256);
    assert.ok(runtime && readme, 'Both independently verified official catalogs must remain available');
    assert.equal(transition.version, runtime.version);
    assert.deepEqual(transition.permissions, runtime.permissions);
    assert.deepEqual(transition.files, runtime.files.map(file => file.path === 'README.md' ? readme.files.find(f => f.path === 'README.md') : file));
    assert.notDeepEqual(transition.files, runtime.files, 'Transition must not masquerade as an original published package');
  }
});
