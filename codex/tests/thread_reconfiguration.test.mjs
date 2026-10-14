import assert from 'node:assert/strict';
import test from 'node:test';
import { createThreadReconfiguration } from '../frontend/src/desktop/thread-reconfiguration.js';

function fixture({ active = false, selected = true, releaseFails = false, early = false, mismatched = false } = {}) {
  const listeners = new Set(), calls = [], thread = { resumeState: 'resumed', cwd: 'X:/fixture', requests: [] };
  let role = 'owner';
  function receipt() { for (const fn of listeners) fn({ type: 'completed', method: 'thread/resume', result: { thread: { id: 'fixture' }, modelProvider: mismatched ? 'old' : 'new', model: 'test-model' } }); }
  const manager = {
    getConversation: () => thread, getStreamRole: () => ({ role }),
    async unsubscribeInactiveConversation(id) { calls.push(['release', id]); if (!releaseFails) { thread.resumeState = 'needs_resume'; role = null; if (early) { receipt(); thread.resumeState = 'resumed'; role = 'owner'; } } },
    async resumeConversation(args) { calls.push(['resume', args]); receipt(); thread.resumeState = 'resumed'; role = 'owner'; return { status: 'ready' }; }
  };
  const api = createThreadReconfiguration({ manager, client: { requestPromises: new Map(), addRequestLifecycleListener(fn) { listeners.add(fn); return () => listeners.delete(fn); } },
    check() {}, supported: true, selection: () => ({ threadId: selected ? 'fixture' : 'another' }), loadedThread: () => thread,
    activeTurnState: () => ({ activeTurnKnown: true, activeTurnId: active ? 'turn' : null }) });
  return { api, calls, listeners };
}
const args = { threadId: 'fixture', modelProvider: 'new', model: 'test-model' };
test('native manager owns cold resume; result must acknowledge the selected provider and model', async () => {
  const f = fixture();
  assert.deepEqual(await f.api.apply(args), { ...args, status: 'applied' });
  assert.deepEqual(f.calls, [['release', 'fixture'], ['resume', { conversationId: 'fixture', workspaceRoots: ['X:/fixture'] }]]);
  assert.equal(f.listeners.size, 0); assert.equal(f.api.busy('fixture'), false);
});
test('active or background tasks are untouched; failed release and mismatched provider are never reported applied', async () => {
  for (const [options, code, count] of [[{ active: true }, 'desktop_thread_busy', 0], [{ selected: false }, 'desktop_thread_not_selected', 0], [{ releaseFails: true }, 'configuration_release_failed', 1], [{ mismatched: true }, 'configuration_not_applied', 2]]) {
    const f = fixture(options); await assert.rejects(f.api.apply(args), { code });
    assert.equal(f.calls.length, count); assert.equal(f.listeners.size, 0); assert.equal(f.api.busy('fixture'), false);
  }
});
test('joins an automatic native resume without releasing or resuming twice', async () => {
  const f = fixture({ early: true }); assert.equal((await f.api.apply(args)).status, 'applied'); assert.equal(f.calls.length, 1);
});
