import assert from 'node:assert/strict';
import test from 'node:test';
import { createComposerBinding } from '../frontend/src/adapter/workspace-composer-binding.js';

const tick = () => new Promise(resolve => setTimeout(resolve, 0));
function fixture(options = {}) {
  let current, enabled = false, composing = false, closed = 0, closeResolve, closeReject;
  const binds = [], activations = [], events = [], errors = [], pending = new Map();
  const driver = {
    block() { enabled = false; },
    isComposing: () => composing,
    readBinding: () => current && { ...current, inputConfirmed: true, submitDisabled: !enabled },
    async bind(value, { signal }) {
      binds.push(value);
      if (value.threadId.startsWith('pending-')) await new Promise(resolve => pending.set(value.threadId, resolve));
      if (!signal.aborted) current = { ...value };
    },
    async activate({ bindingRevision, signal }) {
      activations.push(bindingRevision);
      if (options.pendingActivation) await new Promise(resolve => pending.set('activate', resolve));
      if (!signal.aborted) enabled = true;
    },
    focus: () => enabled,
    close() {
      closed++;
      if (options.pendingClose) return new Promise((resolve, reject) => { closeResolve = resolve; closeReject = reject; });
    },
  };
  let retired = false;
  const handle = createComposerBinding({ driver, initialIdentity: { threadId: 'initial-thread' },
    check() { if (retired) throw Object.assign(Error('retired'), { code: 'workspace_retired' }); },
    report: error => errors.push(error), onState: state => { events.push(state); options.onState?.(state); }, timeoutMs: options.timeoutMs ?? 1000 });
  return { handle, driver, binds, activations, events, errors, pending,
    stats: () => ({ current, enabled, closed }),
    compose: value => composing = value,
    retire: () => retired = true,
    resolveClose: () => closeResolve(), rejectClose: error => closeReject(error),
  };
}

test('a shared handle rebinds with monotonic revisions and activates/focuses only the expected confirmed target', async () => {
  const f = fixture(), first = await f.handle.ready;
  assert.deepEqual(first, { threadId: 'initial-thread', hostId: 'local', bindingRevision: 1, inputConfirmed: true, submitDisabled: true });
  await f.handle.activate({ bindingRevision: first.bindingRevision }); assert.equal(f.handle.focus({ bindingRevision: 1 }), true);
  const next = await f.handle.bind({ threadId: 'second-thread' });
  assert.equal(f.handle.threadId, 'second-thread'); assert.equal(next.bindingRevision, 2); assert.equal(f.stats().enabled, false);
  assert.throws(() => f.handle.activate({ bindingRevision: 1 }), { code: 'workspace_composer_superseded' });
  assert.throws(() => f.handle.focus({ bindingRevision: 1 }), { code: 'workspace_composer_superseded' });
  await f.handle.activate({ bindingRevision: 2 }); assert.equal(f.handle.focus({ bindingRevision: 2 }), true);
  f.handle.deactivate(); assert.equal(f.stats().enabled, false);
  assert.ok(f.events.every(event => event.bindingRevision === 1 || event.bindingRevision === 2));
  await f.handle.close();
});

test('late superseded binding callbacks cannot confirm or enable an old identity', async () => {
  const f = fixture(); await f.handle.ready;
  const old = f.handle.bind({ threadId: 'pending-old' }); await tick();
  const latest = await f.handle.bind({ threadId: 'latest-thread' });
  await assert.rejects(old, { code: 'workspace_composer_superseded' });
  await f.handle.activate({ bindingRevision: latest.bindingRevision });
  f.pending.get('pending-old')(); await tick();
  assert.equal(f.stats().current.threadId, 'latest-thread'); assert.equal(f.stats().enabled, true);
  assert.equal(f.events.filter(event => event.threadId === 'pending-old' && event.phase === 'ready').length, 0);
  await f.handle.close();
});

test('invalid, pre-aborted and IME-busy requests preserve the active binding', async () => {
  const f = fixture(); await f.handle.ready; await f.handle.activate({ bindingRevision: 1 });
  const signal = new AbortController(); signal.abort();
  await assert.rejects(f.handle.bind({ threadId: 'unused-thread' }, { signal: signal.signal }), { code: 'invocation_cancelled' });
  assert.throws(() => f.handle.bind({ threadId: 'invalid-host', hostId: 'remote' }), { code: 'invalid_argument' });
  assert.throws(() => f.handle.bind({ threadId: 'unused-thread' }, { signal: {} }), { code: 'invalid_argument' });
  f.compose(true); assert.throws(() => f.handle.bind({ threadId: 'busy-thread' }), { code: 'workspace_composer_busy' });
  assert.equal(f.stats().enabled, true); assert.equal(f.handle.threadId, 'initial-thread'); assert.equal(f.binds.length, 1);
  await f.handle.close();
});

test('deactivation and signal cancellation block late activations without affecting another handle', async () => {
  const a = fixture({ pendingActivation: true }), b = fixture(); await Promise.all([a.handle.ready, b.handle.ready]);
  await b.handle.activate();
  const old = a.handle.activate(); await tick(); a.handle.deactivate();
  await assert.rejects(old, { code: 'workspace_composer_deactivated' }); a.pending.get('activate')(); await tick();
  assert.equal(a.stats().enabled, false); assert.equal(b.stats().enabled, true);
  const signal = new AbortController(), next = a.handle.activate({ signal: signal.signal }); await tick(); signal.abort();
  await assert.rejects(next, { code: 'invocation_cancelled' }); a.pending.get('activate')(); await tick();
  assert.equal(a.stats().enabled, false);
  await Promise.all([a.handle.close(), b.handle.close()]);
});

test('binding timeout cannot become a late success and releases its activation waiter', async () => {
  const f = fixture({ timeoutMs: 20 }); await f.handle.ready;
  const binding = f.handle.bind({ threadId: 'pending-timeout' }), activation = f.handle.activate({ bindingRevision: 2 });
  await assert.rejects(binding, { code: 'workspace_composer_bind_timeout' });
  await assert.rejects(activation, { code: 'workspace_composer_bind_timeout' });
  f.pending.get('pending-timeout')(); await tick();
  assert.equal(f.stats().enabled, false); assert.equal(f.events.filter(event => event.bindingRevision === 2 && event.phase === 'ready').length, 0);
  await f.handle.close();
});

test('close retires synchronously but only resolves after the Native checkpoint/release and remains awaitable after disposal', async () => {
  const f = fixture({ pendingClose: true }); await f.handle.ready; await f.handle.activate();
  f.handle.dispose(); assert.equal(f.stats().enabled, false);
  assert.throws(() => f.handle.bind({ threadId: 'after-close' }), { code: 'workspace_retired' });
  const close = f.handle.close(); assert.equal(close, f.handle.close());
  await tick(); assert.equal(f.stats().closed, 1); let completed = false; close.then(() => completed = true); await tick();
  assert.equal(completed, false); assert.equal(f.events.at(-1).phase, 'closing');
  f.retire(); f.resolveClose(); await close;
  assert.equal(f.events.at(-1).phase, 'disposed'); assert.equal(f.stats().closed, 1);
});

test('failed Native checkpoint is reported and never masquerades as successful persistent cleanup', async () => {
  const f = fixture({ pendingClose: true }); await f.handle.ready;
  const close = f.handle.close(); await tick();
  f.rejectClose(Object.assign(Error('no save confirmation'), { code: 'workspace_composer_cleanup_incomplete' }));
  await assert.rejects(close, { code: 'workspace_composer_cleanup_incomplete' }); await tick();
  assert.equal(f.errors.at(-1).code, 'workspace_composer_cleanup_incomplete'); assert.equal(f.events.at(-1).phase, 'error');
});

test('close before the first microtask creates no Native binding and handles reentrant closing callbacks once', async () => {
  let handle;
  const f = fixture({ onState: state => { if (state.phase === 'closing') void handle.close(); } }); handle = f.handle;
  handle.dispose(); await assert.rejects(handle.ready, { code: 'workspace_retired' }); await handle.close();
  assert.equal(f.binds.length, 0); assert.equal(f.stats().closed, 1);
});

test('binding confirmation rejects a mismatched Native submit/model target', async () => {
  const f = fixture(); f.driver.readBinding = () => ({ threadId: 'wrong-thread', hostId: 'local', bindingRevision: 1, inputConfirmed: true, submitDisabled: false });
  await assert.rejects(f.handle.ready, { code: 'workspace_composer_binding_drift' }); assert.equal(f.stats().enabled, false);
  await f.handle.close();
});

test('an explicit bind before automatic initialization is not replaced by the initial microtask', async () => {
  const f = fixture(); const next = await f.handle.bind({ threadId: 'explicit-first' });
  assert.deepEqual(await f.handle.ready, next); assert.equal(f.binds.length, 1); assert.equal(f.binds[0].threadId, 'explicit-first');
  await f.handle.close();
});

test('Core cleanup abort can attach after disposal and cannot report a delayed checkpoint as successful', async () => {
  const f=fixture({pendingClose:true});await f.handle.ready;f.handle.dispose();await tick();
  const signal=new AbortController(),close=f.handle.close({signal:signal.signal});signal.abort();
  await assert.rejects(close,{code:'invocation_cancelled'});f.resolveClose();await tick();
  assert.equal(f.events.at(-1).phase,'error');assert.equal(f.stats().closed,1);
});
