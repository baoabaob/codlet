// Fixed, generated data only. No client, filesystem, credentials or model calls.
import { createHash } from 'node:crypto';

export const HISTORY_SEED = 'codlet-adapter-history-v1';
export const HISTORY_SIZES = Object.freeze([20, 200, 2000]);
export const STREAM_MATRIX = Object.freeze({ threads: [1, 4], ratePerThread: 20, deltaChars: 64, durationMs: 60000 });
export const sha256 = value => createHash('sha256').update(typeof value === 'string' ? value : JSON.stringify(value)).digest('hex');
const clone = value => JSON.parse(JSON.stringify(value));
const fixedId = label => {
  const hex = sha256(HISTORY_SEED + ':' + label);
  return `${hex.slice(0, 8)}-${hex.slice(8, 12)}-4${hex.slice(13, 16)}-a${hex.slice(17, 20)}-${hex.slice(20, 32)}`;
};

export function historyFixture(size, index = 0) {
  if (!HISTORY_SIZES.includes(size) || !Number.isSafeInteger(index) || index < 0 || index > 7) throw Error('Unknown synthetic history case');
  const threadId = fixedId(`history:${size}:${index}`), turns = [], items = [];
  for (let n = 0; n < size / 5; n++) {
    const turnId = fixedId(`${threadId}:turn:${n}`), id = suffix => fixedId(`${turnId}:${suffix}`);
    const group = [
      { type: 'userMessage', id: id('user'), clientId: null, content: [{ type: 'text', text: `Synthetic request ${n}: inspect the generated example.`, text_elements: [] }] },
      { type: 'agentMessage', id: id('markdown'), text: `### Synthetic answer ${n}\n\nA fixed paragraph with **bold**, a list, and a table.\n\n- Alpha\n- Beta\n\n| Key | Value |\n| --- | --- |\n| Case | ${n} |`, phase: 'final_answer', memoryCitation: null, delivery: null, questions: null },
      { type: 'agentMessage', id: id('code'), text: `Example code:\n\n\`\`\`javascript\nconst syntheticCase = ${n};\nconsole.log(syntheticCase);\n\`\`\``, phase: 'final_answer', memoryCitation: null, delivery: null, questions: null },
      { type: 'commandExecution', id: id('command'), pluginId: null, scriptPath: null, command: 'synthetic-tool (recorded output only)', cwd: '/synthetic-workspace', processId: null, source: 'agent', status: 'completed', commandActions: [], aggregatedOutput: `synthetic output ${n}\n` + 'line: alpha beta gamma\n'.repeat(16), exitCode: 0, durationMs: 12 },
      { type: 'fileChange', id: id('file'), changes: [{ path: `/synthetic-workspace/fixture-${n}.txt`, kind: { type: 'add' }, diff: `+synthetic fixture ${n}\n` }], status: 'completed' }
    ];
    turns.push({ id: turnId, status: 'completed', items: group, error: null });
    items.push(...group.map(item => ({ turnId, item })));
  }
  return { schema: 1, seed: HISTORY_SEED, size, thread: { id: threadId, name: `Synthetic history ${size}/${index}`, preview: 'Generated history fixture', cwd: '/synthetic-workspace', modelProvider: 'synthetic-offline', turns }, items };
}

export function* streamNotifications(threadCount) {
  if (!STREAM_MATRIX.threads.includes(threadCount)) throw Error('Unknown synthetic stream case');
  const ticks = STREAM_MATRIX.ratePerThread * STREAM_MATRIX.durationMs / 1000;
  const identities = Array.from({ length: threadCount }, (_, index) => ({
    threadId: fixedId(`stream:${threadCount}:${index}`), turnId: fixedId(`stream:${threadCount}:${index}:turn`), itemId: fixedId(`stream:${threadCount}:${index}:item`)
  }));
  for (const identity of identities) {
    const { threadId, turnId, itemId } = identity;
    yield { atMs: 0, notification: { method: 'turn/started', params: { threadId, turn: { id: turnId, status: 'inProgress', items: [], error: null } } } };
    yield { atMs: 0, notification: { method: 'item/started', params: { threadId, turnId, item: { type: 'agentMessage', id: itemId, text: '', phase: 'final_answer', memoryCitation: null, delivery: null, questions: null } } } };
  }
  for (let tick = 0; tick < ticks; tick++) {
    for (const identity of identities) {
      // One SHA-256 hex digest is exactly 64 ASCII characters.
      const delta = sha256(`${HISTORY_SEED}:${threadCount}:${identity.threadId}:${tick}`);
      yield { atMs: tick * 1000 / STREAM_MATRIX.ratePerThread, notification: { method: 'item/agentMessage/delta', params: { ...identity, delta } } };
    }
  }
  for (const identity of identities) {
    const { threadId, turnId, itemId } = identity;
    const text = Array.from({ length: ticks }, (_, tick) => sha256(`${HISTORY_SEED}:${threadCount}:${threadId}:${tick}`)).join('');
    yield { atMs: STREAM_MATRIX.durationMs, notification: { method: 'item/completed', params: { threadId, turnId, item: { type: 'agentMessage', id: itemId, text, phase: 'final_answer', memoryCitation: null, delivery: null, questions: null } } } };
    yield { atMs: STREAM_MATRIX.durationMs, notification: { method: 'turn/completed', params: { threadId, turn: { id: turnId, status: 'completed', items: [], error: null } } } };
  }
}

export function historyPage(fixture, method, params) {
  if (params.threadId !== fixture.thread.id) throw Error('Synthetic thread identity mismatch');
  if (method === 'thread/read') return { thread: { ...clone(fixture.thread), turns: params.includeTurns ? clone(fixture.thread.turns) : [] } };
  const values = method === 'thread/turns/list' ? fixture.thread.turns : method === 'thread/items/list' ? fixture.items : null;
  if (!values) throw Error('Unpermitted synthetic backend method: ' + method);
  const filtered = params.turnId ? values.filter(value => value.turnId === params.turnId) : values;
  const offset = params.cursor == null ? 0 : Number(params.cursor);
  if (!Number.isSafeInteger(offset) || offset < 0 || offset > filtered.length) throw Error('Invalid synthetic cursor');
  const data = clone(filtered.slice(offset, offset + params.limit));
  // Match paginated Native turns: itemsView:notLoaded does not hydrate items.
  if (method === 'thread/turns/list' && params.itemsView === 'notLoaded') for (const turn of data) turn.items = [];
  return { data, nextCursor: offset + data.length < filtered.length ? String(offset + data.length) : null };
}

export async function replayNotifications(threadCount, deliver, { realtime = false, now = () => performance.now(), wait = ms => new Promise(resolve => setTimeout(resolve, ms)) } = {}) {
  const started = now();
  let count = 0, maxLatenessMs = 0;
  for (const entry of streamNotifications(threadCount)) {
    if (realtime) {
      const remaining = started + entry.atMs - now();
      if (remaining > 0) await wait(remaining);
      maxLatenessMs = Math.max(maxLatenessMs, now() - started - entry.atMs);
    }
    deliver(entry.notification);
    count++;
  }
  return { notifications: count, elapsedMs: now() - started, realtime, maxLatenessMs: realtime ? maxLatenessMs : null };
}
