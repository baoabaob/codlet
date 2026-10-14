import test from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import vm from 'node:vm';
import { createRequire } from 'node:module';
const require = createRequire(new URL('../frontend/package.json', import.meta.url)), { JSDOM } = require('jsdom');
const source = readFileSync(new URL('../bundled/runtime/codex.js', import.meta.url), 'utf8');
function fixture(world = 'main') {
  const scope = vm.createContext({});
  const create = vm.runInContext(source, scope), cleanups = new Set(), calls = [], replies = new Map();
  const context = { world, pluginId: 'dev.consumer', generation: 7, ui: { page: options => options },
    onDeactivate(callback) { cleanups.add(callback); return () => cleanups.delete(callback); },
    rpc: { async request(cap, method, params, options) { calls.push({ cap, method, params, options }); const reply = replies.get(method); if (reply instanceof Error) throw reply; return typeof reply === 'function' ? reply(cap, params) : reply; } } };
  return { scope, calls, replies, context, api: create(context), retire: () => { for (const callback of [...cleanups]) callback(); } };
}

test('semantic data groups retain capability descriptors, options and exact method arguments', async () => {
  const f = fixture('isolated'), controller = new AbortController(), options = { signal: controller.signal, timeoutMs: 500 };
  await f.api.threads.loaded({ limit: 100, cursor: 'next' }, options);
  await f.api.turns.interrupt({ threadId: 'task', turnId: 'turn' }, options);
  await f.api.compatibility.waitReady({ timeoutMs: 1000 }, options);
  await f.api.navigation.newTaskDraft({ prompt: 'editable draft' }, options);
  assert.deepEqual(f.calls.map(call => [call.cap.name, call.method]), [['codex.backend.read', 'threads.loaded'], ['codex.backend.write', 'turns.interrupt'], ['codex.desktop.compatibility', 'waitReady'], ['codex.ui.navigation.page', 'newTaskDraft']]);
  assert.equal(f.calls[0].options, options);
  assert.deepEqual(f.calls[0].params, { limit: 100, cursor: 'next' });
  f.retire(); assert.throws(() => f.api.threads.list(), { code: 'plugin_deactivated' });
});

test('workspace and Desktop callbacks claim the issued owner-bound ticket and retain local handles', async () => {
  const f = fixture(), workspaceHandle = Object.freeze({ getSurface() { return 'local DOM handle'; } });
  const seen = [];
  f.scope[Symbol.for('codlet.codex.ui.workspace.v1')] = { api: 1, connect(owner, ticket) { seen.push([owner, ticket]); return workspaceHandle; } };
  f.scope[Symbol.for('codlet.codex.desktop.v1')] = { api: 1, onEvent(owner, ticket, listener) { seen.push([owner, ticket, listener]); return () => {}; }, registerPermissions(owner, ticket) { seen.push([owner, ticket]); return () => {}; } };
  f.replies.set('getApi', cap => ({ api: 1, symbol: cap.name === 'codex.ui.workspace' ? 'codlet.codex.ui.workspace.v1' : 'codlet.codex.desktop.v1', ticket: 'one-use-ticket' }));
  assert.equal(await f.api.workspace.connect(), workspaceHandle);
  const callback = () => {}; assert.equal(typeof await f.api.events.onEvent(callback), 'function');
  await f.api.permissions.register();
  assert.equal(seen[0][0], f.context); assert.equal(seen[1][2], callback);
  assert.deepEqual(f.calls.map(call => call.cap.name), ['codex.ui.workspace', 'codex.backend.events', 'codex.backend.write']);
  assert.equal(seen.every(value => value[1] === 'one-use-ticket'), true);
});

test('callback access never bypasses RPC rejection and reports wrong worlds or ticket contracts', async () => {
  const isolated = fixture('isolated');
  await assert.rejects(isolated.api.workspace.connect(), { code: 'main_world_required' });
  assert.equal(isolated.calls.length, 0);
  const f = fixture(); let registrations = 0;
  f.scope[Symbol.for('codlet.codex.desktop.v1')] = { api: 1, registerPreSubmit() { registrations++; } };
  f.replies.set('getApi', Object.assign(new Error('not declared'), { code: 'capability_denied' }));
  await assert.rejects(f.api.submissions.register({ id: 'example' }, () => {}), { code: 'capability_denied' });
  assert.equal(registrations, 0);
  f.replies.set('getApi', { api: 1, symbol: 'unexpected-private-api', ticket: 'x' });
  await assert.rejects(f.api.submissions.register({ id: 'example' }, () => {}), { code: 'codex_api_invalid' });
  f.retire(); await assert.rejects(f.api.events.onEvent(() => {}), { code: 'plugin_deactivated' });
});
test('composer semantic registration owns its DOM lease, local anchor and callback lifetime in either world', async t => {
  const dom = new JSDOM('<!doctype html><body></body>', { url: 'app://-/index.html', runScripts: 'outside-only' });
  t.after(() => dom.window.close());
  const window = dom.window, document = window.document, cleanups = new Set(), calls = [], events = [];
  const context = { world: 'isolated', pluginId: 'dev.action', generation: 3,
    onDeactivate(callback) { cleanups.add(callback); return () => cleanups.delete(callback); },
    rpc: { async request(cap, method, params) { calls.push({ cap, method, params }); return method === 'register' ? { api: 1, token: params.token, available: true, mounted: 1 } : method === 'status' ? { registered: true, mounted: 1 } : { removed: true }; } } };
  const api = window.eval(source)(context), token = 'semantic-action-123456789';
  const handle = await api.composer.registerAction({ label: 'Action', token }, event => events.push(event));
  const lease = document.querySelector('[data-codlet-composer-action-lease]');
  assert.equal(lease.dataset.codletComposerActionOwner, 'dev.action');
  assert.equal(lease.dataset.codletGeneration, '3');
  const anchor = document.createElement('span');
  Object.assign(anchor.dataset, { codletComposerActionInstanceId: 'action-1', codletComposerActionOwner: 'dev.action', codletGeneration: '3' });
  document.body.appendChild(anchor);
  const clicked = () => lease.dispatchEvent(new window.CustomEvent('codlet:composer-action', { detail: JSON.stringify({ api: 1, token, placement: 'main', instance: 'action-1' }) }));
  clicked(); assert.equal(events[0].anchor, anchor);
  assert.equal(calls[0].cap.name, 'codex.ui.composer.action');
  assert.deepEqual(JSON.parse(JSON.stringify(await handle.status())), { registered: true, mounted: 1 });
  assert.deepEqual(JSON.parse(JSON.stringify(await handle.unregister())), { removed: true });
  assert.equal(lease.isConnected, false); clicked(); assert.equal(events.length, 1);
  assert.throws(() => handle.status(), { code: 'plugin_deactivated' });
});
