// Real production DTO/event/lifecycle code with a synthetic manager in a VM.
// Does not create a browser, Native component, backend connection or DOM.
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import vm from 'node:vm';
import { randomUUID, createHash } from 'node:crypto';
import { fileURLToPath, pathToFileURL } from 'node:url';
import { HISTORY_SEED, HISTORY_SIZES, STREAM_MATRIX, historyFixture, historyPage, replayNotifications, sha256 } from './synthetic-history.mjs';

const repo = fileURLToPath(new URL('../../../', import.meta.url));
const source = fs.readFileSync(path.join(repo, 'bundled/codex-desktop-adapter/renderer.js'), 'utf8');
const plain = value => JSON.parse(JSON.stringify(value));

function fixture(data = null) {
  const scope = vm.createContext({ module: { exports: {} }, setTimeout, clearTimeout, AbortController, URL, crypto: { randomUUID } });
  const { createAdapter, build } = vm.runInContext(source + '\n;({createAdapter, build:BUILDS[0]})', scope);
  const callbacks = new Set(), cleanup = new Set(), ownerCleanup = new Set(), requests = {}, diagnostics = [];
  const originalPost = () => assert.fail('Replay attempted to dispatch a Native write');
  const postbox = { postMessage: originalPost }, client = { requestPromises: new Map(), onError() {} };
  const manager = {
    getConversation: () => null, getStreamRole: () => null,
    async sendRequest(method, params) { requests[method] = (requests[method] ?? 0) + 1; if (!data) throw Error('Stream must not read backend history'); return historyPage(data, method, plain(params)); },
    addNotificationCallback(_methods, handler) { callbacks.add(handler); return () => callbacks.delete(handler); },
    addConversationStateCallback(handler) { callbacks.add(handler); return () => callbacks.delete(handler); }
  };
  const context = { world: 'main', pluginId: 'offline-adapter', generation: 1,
    reportDiagnostic(value) { diagnostics.push(value.code); },
    onDeactivate(fn) { cleanup.add(fn); return () => cleanup.delete(fn); },
    rpc: { provide() {}, unavailable() {} } };
  const adapter = createAdapter({ manager, client, postbox, build, check() {} }, context);
  const owner = { world: 'main', pluginId: 'offline-consumer', generation: 1, onDeactivate(fn) { ownerCleanup.add(fn); return () => ownerCleanup.delete(fn); } };
  const notify = [...callbacks][0]; // createAdapter registers its native notification callback first.
  assert.equal(typeof notify, 'function');
  return { adapter, owner, requests, diagnostics, notify,
    retire() {
      for (const dispose of [...ownerCleanup]) dispose();
      adapter.dispose();
      assert.equal(callbacks.size, 0); assert.equal(cleanup.size, 0); assert.equal(ownerCleanup.size, 0);
      assert.equal(postbox.postMessage, originalPost);
      assert.equal(scope[Symbol.for('codlet.codex.desktop.v1')], undefined);
      return { managerCallbacks: callbacks.size, adapterCleanup: cleanup.size, consumerCleanup: ownerCleanup.size, transportRestored: true, publicApiRemoved: true };
    } };
}

async function historyCase(size) {
  const data = historyFixture(size), f = fixture(data), started = performance.now();
  const pages = async (method, key) => {
    const all = []; let cursor;
    do {
      const page = plain(await f.adapter.api.read(method, { threadId: data.thread.id, limit: 100, ...(cursor ? { cursor } : {}) }));
      all.push(...page[key]); cursor = page.cursor;
    } while (cursor);
    return all;
  };
  const turns = await pages('turns.list', 'turns'), items = await pages('items.list', 'items');
  assert.equal(turns.length, size / 5); assert.equal(items.length, size);
  assert.deepEqual(items.map(value => value.item.id), data.items.map(value => value.item.id));
  const kinds = [...new Set(items.map(value => value.item.kind))];
  for (const kind of ['user', 'assistant', 'command', 'fileChange']) assert.ok(kinds.includes(kind));
  const projectedFiles = items.filter(value => value.item.kind === 'fileChange');
  const fileCardMetadataPreserved = projectedFiles.every(value => Array.isArray(value.item.changes));
  assert.equal(f.diagnostics.length, 0);
  const elapsedMs = performance.now() - started, cleanup = f.retire();
  return { items: size, turns: turns.length, fixtureSha256: sha256(data), requests: f.requests, elapsedMs, itemKinds: kinds,
    fileCardMetadataPreserved, cleanup };
}

const quantiles = values => {
  const sorted = [...values].sort((a, b) => a - b), at = p => sorted[Math.min(sorted.length - 1, Math.ceil(sorted.length * p) - 1)];
  return { samples: values.length, p50: at(.5), p95: at(.95), p99: at(.99), max: sorted.at(-1) };
};

async function streamCase(threads, realtime) {
  const f = fixture(), selected = new Map(), durationSamples = [], sampleCapacity = 1024;
  let callbackInvocations = 0, acceptedDeltas = 0, completedItems = 0, updatesAfterRetirement = 0, dispatchSamples = 0, dispatchMaxMs = 0;
  const listenerFailures = [];
  const first = plain(await f.adapter.api.readEvents({ limit: 100 }));
  const activeIds = new Set();
  // The public event subscription is global. Count that fan-out explicitly.
  for (let index = 0; index < threads; index++) f.adapter.api.onEvent(f.owner, event => {
    try {
    callbackInvocations++;
    const ids = [...activeIds];
    if (event.threadId !== ids[index]) return;
    if (event.type === 'item.completed') {
      const value = selected.get(event.threadId);
      assert.equal(event.item.id, value.itemId);
      assert.equal(sha256(event.item.text), value.hash.digest('hex'));
      completedItems++;
      return;
    }
    if (event.type !== 'item.text.delta') return;
    let value = selected.get(event.threadId);
    if (!value) { value = { deltas: 0, chars: 0, itemId: event.itemId, turnId: event.turnId, hash: createHash('sha256') }; selected.set(event.threadId, value); }
    assert.equal(event.itemId, value.itemId); assert.equal(event.turnId, value.turnId);
    assert.equal(event.delta.length, STREAM_MATRIX.deltaChars);
    value.hash.update(event.delta); value.deltas++; value.chars += event.delta.length; acceptedDeltas++;
    } catch (error) { listenerFailures.push(error); }
  });
  const cpuBefore = process.cpuUsage();
  const timing = await replayNotifications(threads, notification => {
    if (notification.method === 'turn/started') activeIds.add(notification.params.threadId);
    const started = performance.now(); f.notify(notification);
    // Keep the latest 1,024 durations; count/max cover every dispatch.
    const duration = performance.now() - started;
    durationSamples[dispatchSamples++ % sampleCapacity] = duration;
    dispatchMaxMs = Math.max(dispatchMaxMs, duration);
  }, { realtime });
  const cpu = process.cpuUsage(cpuBefore), tail = plain(await f.adapter.api.readEvents({ cursor: first.cursor, limit: 100 }));
  assert.equal(selected.size, threads); assert.equal(acceptedDeltas, 1200 * threads);
  assert.equal(completedItems, threads); assert.equal(listenerFailures.length, 0);
  for (const value of selected.values()) { assert.equal(value.deltas, 1200); assert.equal(value.chars, 76800); }
  assert.equal(tail.gap, true); assert.ok(tail.events.length <= 100);
  assert.equal(f.diagnostics.length, 0); assert.deepEqual(f.requests, {});
  const cleanup = f.retire(), before = callbackInvocations;
  f.notify({ method: 'item/agentMessage/delta', params: { threadId: [...activeIds][0], turnId: 'retired-turn', itemId: 'retired-item', delta: 'retired' } });
  updatesAfterRetirement = callbackInvocations - before; assert.equal(updatesAfterRetirement, 0);
  return { threads, ratePerThread: 20, deltaChars: 64, scheduledDurationMs: 60000, acceptedDeltas, perThread: [...selected.values()].map(({ deltas, chars }) => ({ deltas, chars })), callbackInvocations,
    ...timing, dispatchDurationMs: quantiles(durationSamples), timingSampleCapacity: sampleCapacity, timingSampleWindow: 'latest dispatches', dispatchSamples, dispatchMaxMs,
    processCpuMs: { user: cpu.user / 1000, system: cpu.system / 1000 }, backendRequests: 0, staleCursorGap: tail.gap,
    updatesAfterRetirement, cleanup };
}

export async function runDesktopHistoryReplay({ realtime = false } = {}) {
  const report = { schema: 1, runId: randomUUID(), createdAt: new Date().toISOString(), seed: HISTORY_SEED, node: process.version,
    scope: 'Production Desktop Adapter DTO/event/lifecycle code; synthetic manager in Node VM',
    nativeClientTested: false, nativeHistoryRestorationTested: false, nativeStreamingTested: false, paintMeasured: false,
    realtimeSource: realtime ? 'synthetic scheduled notifications in Node' : 'virtual schedule without waiting',
    sentTurns: 0, bundleSha256: sha256(source), history: [], streaming: [] };
  for (const size of HISTORY_SIZES) report.history.push(await historyCase(size));
  for (const threads of STREAM_MATRIX.threads) {
    console.log(JSON.stringify({ phase: 'streaming', threads, realtime, nativeClientTested: false }));
    report.streaming.push(await streamCase(threads, realtime));
  }
  return report;
}

if (process.argv[1] && import.meta.url === pathToFileURL(path.resolve(process.argv[1])).href) {
  const args = process.argv.slice(2);
  if (args.some(value => value !== '--realtime')) throw Error('Only --realtime is supported; outputs always use a new owned artifact directory');
  const directory = path.join(repo, '.artifacts/workspace-history', 'replay-' + randomUUID());
  fs.mkdirSync(directory, { recursive: true });
  const report = await runDesktopHistoryReplay({ realtime: args.includes('--realtime') });
  const output = path.join(directory, 'report.json'); fs.writeFileSync(output, JSON.stringify(report, null, 2) + '\n', { flag: 'wx' });
  console.log(JSON.stringify({ output, nativeClientTested: false, historyItems: report.history.map(value => value.items), streams: report.streaming.map(({ threads, acceptedDeltas, elapsedMs, realtime }) => ({ threads, acceptedDeltas, elapsedMs, realtime })) }));
}
