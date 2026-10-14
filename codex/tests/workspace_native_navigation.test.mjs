import test from 'node:test';
import assert from 'node:assert/strict';
import { createNativeNavigation, navigationSignalExport } from '../frontend/src/adapter/workspace-native-navigation.js';

const source = 'function missing(){throw Error("AppNavigationSignalBridge is missing")}var defaults,signal;function init(){defaults={navigate:missing,navigateToLocalConversation:missing,prepareNavigation:missing};signal=makeSignal(appScope,defaults)}export{signal as bridgeKey};';

test('navigation signal discovery identifies the original initializer without executing or relying on minified names', () => {
  assert.equal(navigationSignalExport(source), 'bridgeKey');
  assert.throws(() => navigationSignalExport(source.replace('prepareNavigation:missing', 'other:missing')), { code: 'workspace_navigation_unsupported' });
  assert.throws(() => navigationSignalExport(source.replace('signal as bridgeKey', 'signal as bridgeKey,signal as duplicate')), { code: 'workspace_navigation_unsupported' });
  assert.throws(() => navigationSignalExport(source + '"AppNavigationSignalBridge is missing"'), { code: 'workspace_navigation_unsupported' });
});

function fixture() {
  const token = {}, key = {}, calls = [], signal = { scope: token, cache: 'signal', resolve(node, chain) { assert.equal(node, connection.node); assert.equal(chain, connection.chain); return key; } };
  let bridge = { pathname: '/local/a', search: '', navigate() { throw Error('generic route entry used'); }, prepareNavigation() {},
    navigateToLocalConversation(id) { calls.push(['initial', id]); return true; } };
  const connection = { node: { token, signalBindings: new WeakMap([[signal, key]]), store: { get(binding) { assert.equal(binding, key); return bridge; } } }, chain: new Map() };
  const facade = { get() {}, set() {} }, actions = [];
  function dispatch(scope, key, local, generic, host) { assert.equal(scope, facade); actions.push(key); local(key.slice(6), host, { state: { fixture: true } }); }
  return { signal, connection, calls, facade, actions, dispatch, get bridge() { return bridge; }, set bridge(value) { bridge = value; } };
}

test('local navigation calls the current mounted Native lifecycle instead of retaining a stale bridge or generic router', () => {
  const f = fixture(), entry = createNativeNavigation(f.signal, () => f.connection, f.dispatch, () => f.facade);
  entry.openLocalThread('b');
  f.bridge = { ...f.bridge, pathname: '/local/b', navigateToLocalConversation(id) { f.calls.push(['updated', id]); return true; } };
  entry.openLocalThread('a');
  assert.deepEqual(f.calls, [['initial', 'b'], ['updated', 'a']]);
  assert.deepEqual(f.actions, ['local:b', 'local:a']);
  f.bridge.navigateToLocalConversation = () => false;
  assert.throws(() => entry.openLocalThread('c'), { code: 'workspace_navigation_unavailable' });
});

test('navigation never resolves an unbound default and rejects wrong or retired ownership', () => {
  const f = fixture(); f.connection.node.signalBindings.delete(f.signal); f.signal.resolve = () => { throw Error('unbound signal resolved'); };
  assert.throws(() => createNativeNavigation(f.signal, () => f.connection, f.dispatch, () => f.facade), { code: 'workspace_host_pending' });
  f.signal.scope = {};
  assert.throws(() => createNativeNavigation(f.signal, () => f.connection, f.dispatch, () => f.facade), { code: 'workspace_navigation_unsupported' });
  const live = fixture(); let retired = false;
  const entry = createNativeNavigation(live.signal, () => { if (retired) throw Object.assign(Error('retired'), { code: 'workspace_retired' }); return live.connection; }, live.dispatch, () => live.facade);
  retired = true;
  assert.throws(() => entry.openLocalThread('b'), { code: 'workspace_retired' });
  assert.deepEqual(live.calls, []);
});

test('the Native action cannot silently change host, route kind or task identity', () => {
  const f = fixture(), make = dispatch => createNativeNavigation(f.signal, () => f.connection, dispatch, () => f.facade);
  assert.throws(() => make((scope, key, local) => local('other', 'local')).openLocalThread('b'), { code: 'workspace_navigation_unavailable' });
  assert.throws(() => make((scope, key, local) => local('b', 'remote')).openLocalThread('b'), { code: 'workspace_navigation_unavailable' });
  assert.throws(() => make((scope, key, local, generic) => generic('/remote/b')).openLocalThread('b'), { code: 'workspace_navigation_unsupported' });
  assert.throws(() => make(() => {}).openLocalThread('b'), { code: 'workspace_navigation_unavailable' });
  assert.deepEqual(f.calls, []);
});

test('opaque page restoration uses the current semantic bridge and retains Native state identity', () => {
  const f = fixture(), calls = [], entry = createNativeNavigation(f.signal, () => f.connection, f.dispatch, () => f.facade);
  const state = { draftScope: Symbol('private') }, location = { pathname: '/', search: '?new=1', hash: '#draft', key: 'captured', state };
  f.bridge = { ...f.bridge, navigate(to, options) { calls.push({ to, options }); return true; } };
  entry.restoreLocation(location);
  assert.deepEqual(calls[0].to, { pathname: '/', search: '?new=1', hash: '#draft', key: 'captured' });
  assert.equal(calls[0].options.state, state); assert.equal(calls[0].options.replace, true); assert.deepEqual(f.actions, []);
  f.bridge.navigate = () => false;
  assert.throws(() => entry.restoreLocation(location), { code: 'workspace_location_restore_unavailable' });
});
