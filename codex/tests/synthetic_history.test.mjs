import assert from 'node:assert/strict';
import test from 'node:test';
import { HISTORY_SIZES, historyFixture, historyPage, streamNotifications, replayNotifications, sha256 } from './fixtures/workspace-acceptance/synthetic-history.mjs';
import { runDesktopHistoryReplay } from './fixtures/workspace-acceptance/replay-desktop-history.mjs';
import { probeCanonicalHistory } from './fixtures/workspace-acceptance/probe-native-history.mjs';
import { hasDeclaredField } from './fixtures/workspace-acceptance/inspect-history-protocol.mjs';

test('fixed history fixtures have exact distinct items, code/tool/file data and repeatable hashes', () => {
  const allIds = new Set();
  for (const size of HISTORY_SIZES) {
    const data = historyFixture(size);
    assert.equal(data.items.length, size); assert.equal(data.thread.turns.length, size / 5);
    assert.equal(sha256(data), sha256(historyFixture(size)));
    for (const { item } of data.items) { assert.ok(!allIds.has(item.id)); allIds.add(item.id); }
    assert.ok(data.items.some(({ item }) => item.text?.includes('```javascript')));
    assert.ok(data.items.some(({ item }) => item.type === 'fileChange' && item.changes[0].path.startsWith('/synthetic-workspace/')));
    assert.ok(data.items.some(({ item }) => item.type === 'commandExecution' && item.aggregatedOutput));
  }
});

test('2000-item paging retains identity at every boundary and does not hydrate turns implicitly', () => {
  const fixture = historyFixture(2000), seen = []; let cursor;
  do {
    const page = historyPage(fixture, 'thread/items/list', { threadId: fixture.thread.id, limit: 100, cursor });
    seen.push(...page.data.map(value => value.item.id)); cursor = page.nextCursor;
  } while (cursor);
  assert.deepEqual(seen, fixture.items.map(value => value.item.id));
  const turns = historyPage(fixture, 'thread/turns/list', { threadId: fixture.thread.id, limit: 100, itemsView: 'notLoaded' });
  assert.ok(turns.data.every(turn => turn.items.length === 0));
  assert.throws(() => historyPage(fixture, 'turn/start', { threadId: fixture.thread.id }), /Unpermitted/);
  assert.throws(() => historyPage(fixture, 'thread/read', { threadId: 'unowned-thread' }), /identity mismatch/);
});

test('controlled 1/4-thread schedules have 1200 ordered 64-character deltas each and pace to 60 seconds', async () => {
  for (const threads of [1, 4]) {
    const entries = [...streamNotifications(threads)], deltas = entries.filter(value => value.notification.method.endsWith('/delta'));
    assert.equal(deltas.length, threads * 1200);
    assert.ok(deltas.every(value => value.notification.params.delta.length === 64));
    assert.equal(new Set(deltas.map(value => value.notification.params.threadId)).size, threads);
    assert.ok(entries.every((value, index) => !index || entries[index - 1].atMs <= value.atMs));
    assert.equal(entries.at(-1).atMs, 60000);
    let now = 0, delivered = 0;
    const result = await replayNotifications(threads, () => delivered++, { realtime: true, now: () => now, wait: async ms => { now += ms; } });
    assert.equal(delivered, entries.length); assert.equal(result.elapsedMs, 60000); assert.equal(result.maxLatenessMs, 0);
  }
});

test('production Adapter consumes long-history pages and ordered streams without writes, extra reads or leaked callbacks', async () => {
  const report = await runDesktopHistoryReplay();
  assert.deepEqual(report.history.map(value => value.items), [20, 200, 2000]);
  assert.equal(report.history[2].requests['thread/items/list'], 20);
  assert.ok(report.history.every(value => value.fileCardMetadataPreserved === false));
  assert.deepEqual(report.streaming.map(value => value.acceptedDeltas), [1200, 4800]);
  assert.ok(report.streaming.every(value => value.backendRequests === 0 && value.updatesAfterRetirement === 0));
  assert.equal(report.streaming[1].callbackInvocations, report.streaming[1].notifications * 4);
  assert.ok(report.streaming.every(value => value.cleanup.managerCallbacks === 0 && value.cleanup.consumerCleanup === 0));
  assert.equal(report.nativeClientTested, false); assert.equal(report.nativeStreamingTested, false); assert.equal(report.sentTurns, 0);
});

test('Native capability probe distinguishes model-context injection from visible history and cleans only its new thread', async () => {
  const thread = { id: 'e46bf958-f497-4697-a671-636601963e09', cwd: '/synthetic-workspace', path: '/synthetic-home/sessions/rollout.jsonl', turns: [] }, calls = [];
  const request = async (method, params) => {
    calls.push({ method, params });
    if (method === 'thread/start' || method === 'thread/read') return { thread };
    if (method === 'thread/turns/list') return { data: [], nextCursor: null };
    if (method === 'thread/items/list') throw Object.assign(Error('Not supported'), { code: -32601 });
    return {};
  };
  const report = await probeCanonicalHistory(request, { project: thread.cwd, codexHome: '/synthetic-home' });
  assert.equal(report.injectedItems, 2); assert.equal(report.canonicalTurnHistoryReadback, false);
  assert.equal(report.reads.itemsList.code, -32601); assert.equal(report.cleanup.deleted, true); assert.equal(report.state, 'closed');
  assert.ok(!calls.some(value => value.method === 'turn/start'));
  assert.deepEqual(calls.filter(value => value.method === 'thread/delete').map(value => value.params.threadId), [thread.id]);
  calls.length = 0;
  await assert.rejects(probeCanonicalHistory(request, { project: thread.cwd, codexHome: '/synthetic-home', protectedIds: [thread.id] }), /ownership differs/);
  assert.deepEqual(calls.map(value => value.method), ['thread/start']);
});

test('uncertain thread creation is never retried or followed by unproven cleanup', async () => {
  const calls = [];
  await assert.rejects(probeCanonicalHistory(async method => {
    calls.push(method); throw Object.assign(Error('Lost response'), { code: 'outcome_unknown' });
  }, { project: '/synthetic-workspace', codexHome: '/synthetic-home' }), { code: 'outcome_unknown' });
  assert.deepEqual(calls, ['thread/start']);
});

test('Native read-back gate requires both canonical markers and never certifies Native rendering from them', async () => {
  for (const visibleMessages of [1, 2]) {
    const thread = { id: 'e46bf958-f497-4697-a671-636601963e09', cwd: '/synthetic-workspace', path: '/synthetic-home/sessions/rollout.jsonl', turns: [] };
    const request = async (method, params) => {
      if (method === 'thread/start') return { thread };
      if (method === 'thread/inject_items') thread.turns = [{ id: 'synthetic-turn', items: params.items.slice(0, visibleMessages).map((item, index) =>
        index ? { id: 'synthetic-assistant', type: 'agentMessage', text: item.content[0].text } : { id: 'synthetic-user', type: 'userMessage', content: [{ type: 'text', text: item.content[0].text }] }) }];
      if (method === 'thread/read') return { thread };
      if (method === 'thread/turns/list') return { data: thread.turns, nextCursor: null };
      if (method === 'thread/items/list') return { data: thread.turns.flatMap(turn => turn.items.map(item => ({ turnId: turn.id, item }))), nextCursor: null };
      return {};
    };
    const report = await probeCanonicalHistory(request, { project: thread.cwd, codexHome: '/synthetic-home' });
    assert.equal(report.canonicalTurnHistoryReadback, visibleMessages === 2);
    assert.equal(report.nativeClientTested, false); assert.equal(report.fullMixedHistoryCoverage, false);
    assert.equal(report.cleanup.deleted, true);
  }
});

test('protocol capability inspection ignores examples and precedence comments about experimental fields', () => {
  const source = '// By history: instantiate\n/** history: before thread_id; path: optional */\nexport type Resume = {threadId: string, excludeTurns?: boolean};';
  assert.equal(hasDeclaredField(source, 'history'), false); assert.equal(hasDeclaredField(source, 'path'), false);
  assert.equal(hasDeclaredField(source, 'threadId'), true);
  assert.equal(hasDeclaredField(source + '\nexport type Experimental = { history?: Array<ResponseItem> | null };', 'history'), true);
});
