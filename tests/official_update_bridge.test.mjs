import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import test from 'node:test';
import vm from 'node:vm';

const source = readFileSync(new URL('../src/official_update_bridge.js', import.meta.url), 'utf8').replaceAll('import(', 'loadModule(');
const profile = JSON.parse(readFileSync(new URL('../compatibility/client-profiles.json', import.meta.url), 'utf8')).builds.at(-1);

test('current update bridge resolves AppScope from the shared module and acts on its reviewed state', async () => {
  const token = { id: 'AppScope' }, atom = {}, state = { downloadProgressPercent: null, installProgressPercent: null,
    isUpdateReady: true, lifecycleState: 'ready', relaunchNotice: null, supportsAutoInstallWhenIdle: false };
  const node = { token, store: new Map([[atom, state]]), familyBindings: new Map() };
  const chain = new Map([[token.id, node]]), root = { __reactContainer$test: { memoizedProps: { value: chain } } };
  let installed = 0;
  const selector = { scope: token, resolve() { return { read(callback) { callback(atom); } }; } };
  const appModule = { [profile.officialUpdates.stateSelector]: selector,
    [profile.exports.services]: { appUpdates: { installUpdate() { installed++; } } } };
  const shared = { [profile.exports.scope]: token }, imports = [];
  const window = {}; window.top = window;
  const context = vm.createContext({ Map, window, document: { scripts: [{ src: profile.entry }], getElementById: () => root },
    location: { origin: 'app://-', pathname: '/index.html' }, electronBridge: { getSentryInitOptions: () => profile },
    loadModule: async url => { imports.push(url); return url === profile.module ? appModule : url === profile.scopeModule ? shared : null; } });
  const run = async action => JSON.parse(JSON.stringify(await vm.runInContext(source.replace('__CODLET_PROFILES__', JSON.stringify({ builds: [profile] }))
    .replace('__CODLET_ACTION__', JSON.stringify(action)), context)));
  assert.deepEqual(await run({ kind: 'probe' }), { available: true, phase: 'ready', isUpdateReady: true });
  assert.deepEqual(imports, [profile.module, profile.scopeModule]);
  assert.deepEqual(await run({ kind: 'install', id: 'fixture-install' }), { available: true, phase: 'ready', isUpdateReady: true, accepted: true });
  assert.equal(installed, 1);
  assert.deepEqual(await run({ kind: 'install', id: 'fixture-install' }), { available: true, phase: 'ready', isUpdateReady: true, accepted: true });
  assert.equal(installed, 1);
});
