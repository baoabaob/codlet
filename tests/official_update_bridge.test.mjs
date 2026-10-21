import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import test from 'node:test';
import vm from 'node:vm';

const source = readFileSync(new URL('../src/official_update_bridge.js', import.meta.url), 'utf8').replaceAll('import(', 'loadModule(');
const profiles = JSON.parse(readFileSync(new URL('../compatibility/official-update-profiles.json', import.meta.url), 'utf8')).builds;

for (const profile of profiles) test(`update bridge binds the observed entry and service for ${profile.appVersion}/${profile.buildNumber}/${profile.entry}`, async () => {
  const token = { id: 'AppScope' }, atom = {}, state = { downloadProgressPercent: null, installProgressPercent: null,
    isUpdateReady: true, lifecycleState: 'ready', relaunchNotice: null, supportsAutoInstallWhenIdle: false };
  const node = { token, store: new Map([[atom, state]]), familyBindings: new Map() };
  const chain = new Map([[token.id, node]]), root = { __reactContainer$test: { memoizedProps: { value: chain } } };
  let installed = 0;
  const selector = { scope: token, resolve() { return { read(callback) { callback(atom); } }; } };
  const modules = new Map(), imports = [];
  const provide = (url, name, value) => { if (!modules.has(url)) modules.set(url, {}); modules.get(url)[name] = value; };
  provide(profile.module, profile.officialUpdates.stateSelector, selector);
  provide(profile.scopeModule ?? profile.module, profile.exports.scope, token);
  provide(profile.servicesModule ?? profile.module, profile.exports.services, { appUpdates: { installUpdate() { installed++; } } });
  const window = {}; window.top = window;
  const document = { scripts: [{ src: profile.entry }], getElementById: () => root };
  const context = vm.createContext({ Map, window, document,
    location: { origin: 'app://-', pathname: '/index.html' }, electronBridge: { getSentryInitOptions: () => profile },
    loadModule: async url => { imports.push(url); return modules.get(url); } });
  const otherPlatform = { ...profile, entry: 'app://-/assets/other-platform-entry.js', module: 'app://-/assets/other-platform-module.js' };
  const run = async action => JSON.parse(JSON.stringify(await vm.runInContext(source.replace('__CODLET_PROFILES__', JSON.stringify({ builds: [otherPlatform, profile] }))
    .replace('__CODLET_ACTION__', JSON.stringify(action)), context)));
  assert.deepEqual(await run({ kind: 'probe' }), { available: true, phase: 'ready', isUpdateReady: true });
  assert.deepEqual(imports, [...new Set([profile.module, profile.scopeModule, profile.servicesModule].filter(Boolean))]);
  assert.deepEqual(await run({ kind: 'install', id: 'fixture-install' }), { available: true, phase: 'ready', isUpdateReady: true, accepted: true });
  assert.equal(installed, 1);
  assert.deepEqual(await run({ kind: 'install', id: 'fixture-install' }), { available: true, phase: 'ready', isUpdateReady: true, accepted: true });
  assert.equal(installed, 1);
  state.lifecycleState = 'idle'; state.isUpdateReady = false;
  await run({ kind: 'retire', id: 'fixture-install' });
  assert.equal((await run({ kind: 'install', id: 'not-ready' })).accepted, false);
  state.lifecycleState = 'ready'; state.isUpdateReady = true;
  const previousImports = imports.length;
  document.scripts = [{ src: 'app://-/assets/unreviewed-entry.js' }];
  assert.deepEqual(await run({ kind: 'install', id: 'unknown-entry' }), { available: false, reason: 'profile' });
  document.scripts = [{ src: profile.entry }, { src: otherPlatform.entry }];
  assert.deepEqual(await run({ kind: 'install', id: 'ambiguous-entry' }), { available: false, reason: 'profile' });
  assert.equal(imports.length, previousImports);
  assert.equal(installed, 1);
});
