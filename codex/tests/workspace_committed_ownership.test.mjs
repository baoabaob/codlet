import test from 'node:test';
import assert from 'node:assert/strict';
import { ancestry, providersFor } from '../frontend/src/adapter/workspace-dom.js';

function fixture() {
  const context = {}, value = {}, current = {}, oldRoot = {};
  const root = { __reactContainer$test: { stateNode: { current } } };
  const element = { ownerDocument: { getElementById: () => root } };
  const provider = { tag: 10, type: context, memoizedProps: { value }, return: current };
  const host = { stateNode: element, return: provider };
  current.child = provider; provider.child = host; element.__reactFiber$test = host;
  return { context, value, current, oldRoot, element, provider, host };
}

test('Native provider capture uses the proven current branch and refuses detached return links', () => {
  const f = fixture();
  assert.deepEqual(providersFor(f.element), [[f.context, f.value]]);
  f.current.child = null;
  assert.deepEqual(ancestry(f.element), []);
  assert.throws(() => providersFor(f.element), { code: 'workspace_host_drift' });
});

test('an element attached to the previous alternate captures current providers rather than stale scopes', () => {
  const f = fixture(), stale = { stateNode: f.element, return: f.oldRoot };
  stale.alternate = f.host; f.host.alternate = stale; f.element.__reactFiber$test = stale;
  f.oldRoot.child = stale;
  assert.deepEqual(providersFor(f.element), [[f.context, f.value]]);
  f.current.child = null;
  assert.throws(() => providersFor(f.element), { code: 'workspace_host_drift' });
});
