import assert from 'node:assert/strict';
import test from 'node:test';
import vm from 'node:vm';
import { readFileSync } from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { createThreadConfiguration } from '../frontend/src/desktop/thread-configuration.js';
import { createThreadReconfiguration } from '../frontend/src/desktop/thread-reconfiguration.js';
import { createThreadRestoration } from '../frontend/src/desktop/thread-restoration.js';

const core = process.env.CODLET_CORE_ROOT ?? fileURLToPath(new URL('../../codlet', import.meta.url));
const bootstrap = readFileSync(path.join(core, 'bundled/runtime/bootstrap.js'), 'utf8');
const tick = () => new Promise(resolve => setImmediate(resolve));
const target = { threadId: 'task', modelProvider: 'codlet_fixture', model: 'plugin-model' };
const original = { modelProvider: 'openai', model: 'original-model' };

async function fixture(t) {
  const scope = vm.createContext({ setTimeout, clearTimeout, AbortController, TextEncoder });
  vm.runInContext(`(${bootstrap})({world:'main'})`, scope);
  const runtime = scope.__codletRendererV1;
  const state = { ...original, selected: 'task', active: false, role: 'owner', pause: null, mismatch: false };
  const thread = { resumeState: 'resumed', cwd: 'X:/fixture', requests: [] };
  const listeners = new Set(), calls = [], closedRoutes = [];
  const client = {
    requestPromises: new Map(),
    addRequestLifecycleListener(fn) { listeners.add(fn); return () => listeners.delete(fn); },
    onError(id, error) { const entry = this.requestPromises.get(id); this.requestPromises.delete(id); entry?.reject(error); }
  };
  let next = 0, configurations;
  const manager = {
    getConversation: () => thread, getStreamRole: () => ({ role: state.role }),
    async unsubscribeInactiveConversation(id) {
      calls.push(['release', id]);
      if (state.pause) await state.pause;
      thread.resumeState = 'needs_resume'; state.role = null;
    },
    resumeConversation() {
      calls.push(['resume']);
      return new Promise((resolve, reject) => {
        const id = ++next;
        client.requestPromises.set(id, { conversationId: 'task', method: 'thread/resume', reject });
        configurations.intercept({ type: 'mcp-request', hostId: 'local', request: { id, method: 'thread/resume', params: { threadId: 'task', ...original, cwd: thread.cwd, config: { keep: 'native' } } } }, message => {
          calls.push(['sent', message.request.params]);
          state.modelProvider = state.mismatch ? 'unexpected' : message.request.params.modelProvider;
          state.model = message.request.params.model;
          thread.resumeState = 'resumed'; state.role = 'owner'; client.requestPromises.delete(id);
          for (const fn of listeners) fn({ type: 'completed', method: 'thread/resume', result: { thread: { id: 'task' }, modelProvider: state.modelProvider, model: state.model } });
          resolve({ status: 'ready' });
        });
      });
    }
  };
  const check = () => {};
  const reconfiguration = createThreadReconfiguration({ manager, client, check, supported: true,
    selection: () => ({ threadId: state.selected }), loadedThread: () => {
      if (thread.resumeState !== 'resumed' || state.role !== 'owner') throw Object.assign(new Error('not owned'), { code: 'desktop_thread_not_loaded' });
      return thread;
    }, activeTurnState: () => ({ activeTurnKnown: true, activeTurnId: state.active ? 'turn' : null }) });
  const restoration = createThreadRestoration({ reconfiguration, check, readConfiguration: async () => ({ modelProvider: state.modelProvider, model: state.model }) });
  configurations = createThreadConfiguration({ check, owner: ctx => ({ pluginId: ctx.pluginId, generation: ctx.generation }), capability: {}, client, build: { threadConfiguration: true }, restoration });
  const owners = [];
  async function register(id = 'test.owner') {
    let handle, ctx;
    const result = await runtime.activate({ id, generation: 1, binding: id }, {
      activate(context) {
        ctx = context;
        handle = configurations.register(context, { id: 'provider', appliesAt: ['thread.resume'], restoreOnDeactivate: true }, () => ({ provider: { id: 'codlet_fixture', baseUrl: 'http://127.0.0.1:32123/private/v1' }, model: 'plugin-model' }));
      }, deactivate() { closedRoutes.push({ id, provider: state.modelProvider }); }
    });
    assert.equal(result.ok, true, result.error); owners.push(id);
    return { handle, ctx, stop: () => runtime.deactivate(id, 1), force: () => runtime.__rpcClose(id) };
  }
  t.after(async () => {
    state.pause = null; state.active = false; state.selected = 'task'; state.role = 'owner'; thread.resumeState = 'resumed';
    for (const id of owners) await runtime.deactivate(id, 1);
    configurations.dispose();
  });
  return { runtime, state, calls, closedRoutes, configurations, restoration, register, thread };
}

test('owned loaded-thread change restores acknowledged values before Core closes the plugin route', async t => {
  const f = await fixture(t), owner = await f.register();
  assert.equal((await owner.handle.reconfigure(target)).status, 'applied');
  assert.equal(f.state.modelProvider, target.modelProvider);
  assert.deepEqual(owner.handle.inspect().restorations[0].original, original);
  assert.equal(JSON.stringify(owner.handle.inspect()).includes('private/v1'), false);
  let finish; f.state.pause = new Promise(resolve => { finish = resolve; });
  const stopped = owner.stop(); await tick();
  assert.equal(f.closedRoutes.length, 0, 'route teardown must wait for native restoration');
  finish(); assert.equal((await stopped).ok, true);
  assert.equal(f.state.modelProvider, original.modelProvider); assert.equal(f.state.model, original.model);
  assert.deepEqual(f.closedRoutes, [{ id: 'test.owner', provider: 'openai' }]);
  assert.equal(f.restoration.pending(), 0);
  const sent = f.calls.filter(call => call[0] === 'sent').map(call => call[1]);
  assert.equal(sent.length, 2); assert.equal(sent[1].modelProvider, 'openai'); assert.equal(sent[1].config.keep, 'native');
});

test('another registration cannot acquire or restore an existing provider lease', async t => {
  const f = await fixture(t), owner = await f.register();
  await owner.handle.reconfigure(target);
  const other = await f.register('test.other'), count = f.calls.length;
  await assert.rejects(other.handle.reconfigure(target), { code: 'configuration_owned' });
  assert.deepEqual(await other.handle.restore(), { threads: [] });
  assert.equal(f.calls.length, count); assert.equal(f.state.modelProvider, target.modelProvider);
  assert.equal((await owner.stop()).ok, true);
});

test('a later user provider choice is preserved, but an ambiguous same-provider model change is reported', async t => {
  const f = await fixture(t), owner = await f.register(); await owner.handle.reconfigure(target);
  f.state.modelProvider = 'user_provider'; f.state.model = 'user-model';
  const count = f.calls.length;
  assert.deepEqual(await owner.handle.restore(), { threads: [{ threadId: 'task', status: 'superseded' }] });
  assert.equal(f.calls.length, count); assert.equal(f.state.modelProvider, 'user_provider');
  owner.handle.setEnabled(true); await owner.handle.reconfigure(target);
  f.state.model = 'user-selected-model';
  const before = f.calls.length;
  const stopped = await owner.stop();
  assert.equal(stopped.ok, false); assert.match(stopped.error, /configuration_restore_conflict/);
  assert.equal(f.calls.length, before); assert.equal(f.state.model, 'user-selected-model');
  assert.equal(f.restoration.pending(), 1);
  assert.equal(f.configurations.list().restorations[0].status, 'restoreRequired');
});

test('unknown baselines, active turns and background selections never release native ownership', async t => {
  for (const [field, value, code] of [['model', null, 'configuration_restore_unavailable'], ['active', true, 'desktop_thread_busy'], ['selected', 'other', 'desktop_thread_not_selected']]) {
    const f = await fixture(t), owner = await f.register(); f.state[field] = value;
    await assert.rejects(owner.handle.reconfigure(target), { code });
    assert.equal(f.calls.length, 0); assert.equal(f.restoration.pending(), 0);
  }
});

test('a mismatched native receipt retains an unconfirmed restoration record', async t => {
  const f = await fixture(t), owner = await f.register(); f.state.mismatch = true;
  await assert.rejects(owner.handle.reconfigure(target), { code: 'configuration_not_applied' });
  assert.equal(owner.handle.inspect().restorations[0].status, 'unconfirmed');
  assert.equal(f.restoration.pending(), 1);
});

test('forced Core retirement cancels an unfinished release without dispatching a late resume', async t => {
  const f = await fixture(t), owner = await f.register();
  let finish; f.state.pause = new Promise(resolve => { finish = resolve; });
  const pending = owner.handle.reconfigure(target);
  const rejected = assert.rejects(pending, { code: 'outcome_unknown' });
  await tick(); assert.equal(owner.force().ok, false);
  await rejected; finish(); await tick();
  assert.equal(f.calls.filter(call => call[0] === 'resume').length, 0);
  assert.equal(f.restoration.pending(), 1);
});

test('restoration opt-in refuses a Core without awaitable cleanup instead of promising best-effort teardown', async () => {
  const api = createThreadConfiguration({ check() {}, owner: () => ({ pluginId: 'old', generation: 1 }), capability: {}, client: {}, build: { threadConfiguration: true }, restoration: { available: () => true } });
  assert.throws(() => api.register({ onDeactivate() {} }, { id: 'restore', restoreOnDeactivate: true }, () => {}), { code: 'configuration_restore_unsupported' });
  const olderCore = createThreadRestoration({ cleanupAvailable: false, reconfiguration: { available: () => true } });
  assert.equal(olderCore.available(), false, 'probe must include the Core cleanup capability');
});

test('caller argument mutation cannot retarget a pending leased operation', async t => {
  const f = await fixture(t), owner = await f.register(), args = { ...target };
  const result = owner.handle.reconfigure(args);
  args.threadId = 'another-task'; args.modelProvider = 'unowned'; args.model = 'changed';
  assert.deepEqual(await result, { ...target, status: 'applied' });
  assert.equal(owner.handle.inspect().restorations[0].threadId, 'task');
  f.state.modelProvider = original.modelProvider; f.state.model = original.model;
  const count = f.calls.length;
  assert.deepEqual(await owner.handle.restore(), { threads: [{ threadId: 'task', status: 'restored' }] });
  assert.equal(f.calls.length, count);
});

test('concurrent baseline reads reserve the bounded restoration slots before awaiting', async () => {
  const reads = [], engine = createThreadRestoration({ check() {}, readConfiguration: () => new Promise(resolve => reads.push(resolve)),
    reconfiguration: { available: () => true, async apply(args, signal, control) { control.beforeRelease(); return { ...args, status: 'applied' }; } } });
  const requests = Array.from({ length: 16 }, (_, id) => engine.reconfigure({ pluginId: `owner${id}` }, { ...target, threadId: `task_${id}` }));
  await assert.rejects(engine.reconfigure({ pluginId: 'extra' }, { ...target, threadId: 'extra' }), { code: 'configuration_restore_limit' });
  assert.equal(reads.length, 16);
  for (const resolve of reads) resolve(original);
  await Promise.all(requests); assert.equal(engine.pending(), 16);
  assert.equal(engine.dispose().reloadRequired, true);
});
