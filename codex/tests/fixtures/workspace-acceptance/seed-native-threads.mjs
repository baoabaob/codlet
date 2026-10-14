// Create eight metadata-only synthetic local threads in one verified own run.
// No turn/start, model inference, credential copying or real-thread selection.
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const repo = fileURLToPath(new URL('../../../', import.meta.url)), directory = path.resolve(process.argv[2] ?? '');
const evidence = JSON.parse(fs.readFileSync(path.join(directory, 'owned-runtime-evidence.json'), 'utf8'));
const state = JSON.parse(fs.readFileSync(path.join(directory, 'profile/logs/manual-client.json'), 'utf8'));
if (directory !== path.join(repo, '.artifacts/adapter-native', evidence.runId) || evidence.phase !== 'ready' || state.state !== 'ready' ||
    state.runId !== evidence.coordinatorRunId || !evidence.authenticated || !evidence.sandboxReady || evidence.activeThreads || evidence.archivedThreads)
  throw Error('Verified owned empty Native run required');
const endpoint = new URL(state.endpoint);
if (endpoint.protocol !== 'ws:' || endpoint.hostname !== '127.0.0.1') throw Error('Owned loopback backend required');
const filename = path.join(directory, 'synthetic-threads.json');
const ledger = { schema: 1, runId: evidence.runId, coordinatorRunId: state.runId, state: 'creating', sentTurns: 0,
  threadStarts: 0, namePrefix: 'Adapter synthetic ' + evidence.runId, threads: [] };
fs.writeFileSync(filename, JSON.stringify(ledger, null, 2) + '\n', { flag: 'wx' });
const save = () => { fs.writeFileSync(filename + '.next', JSON.stringify(ledger, null, 2) + '\n'); fs.renameSync(filename + '.next', filename); };
const ws = new WebSocket(state.endpoint), pending = new Map(); let id = 0;
ws.addEventListener('message', event => {
  const message = JSON.parse(String(event.data)), call = pending.get(message.id); if (!call) return;
  pending.delete(message.id); clearTimeout(call.timer);
  message.error ? call.reject(Error('Owned fixture metadata request failed: ' + call.method)) : call.resolve(message.result);
});
const request = (method, params) => new Promise((resolve, reject) => {
  const ticket = ++id, timer = setTimeout(() => { pending.delete(ticket); reject(Error('Uncertain fixture request: ' + method)); }, 15000);
  pending.set(ticket, { resolve, reject, timer, method }); ws.send(JSON.stringify({ id: ticket, method, params }));
});
try {
  await new Promise((resolve, reject) => { ws.addEventListener('open', resolve, { once: true }); ws.addEventListener('error', () => reject(Error('Owned backend unavailable')), { once: true }); });
  await request('initialize', { clientInfo: { name: 'codlet-adapter-synthetic-author', version: '0.1.0' }, capabilities: { experimentalApi: true } });
  ws.send(JSON.stringify({ method: 'initialized', params: {} }));
  for (const archived of [false, true]) {
    const reply = await request('thread/list', { limit: 100, archived, useStateDbOnly: true });
    if (!Array.isArray(reply.data) || reply.data.length || reply.nextCursor) throw Error('Fixture run is no longer empty');
  }
  const project = path.join(directory, 'profile/project');
  for (let index = 0; index < 8; index++) {
    ledger.threadStarts++; save(); // A lost response is retained as uncertain, never blindly retried.
    const { thread } = await request('thread/start', { cwd: project, ephemeral: false });
    if (!/^[\w-]{8,256}$/.test(thread?.id ?? '') || path.resolve(thread.cwd).toLowerCase() !== project.toLowerCase() ||
        ledger.threads.some(value => value.id === thread.id)) throw Error('Synthetic thread ownership differs');
    const entry = { id: thread.id, index, name: ledger.namePrefix + ' ' + index, rolloutPath: thread.path ?? null, initialTurns: thread.turns?.length ?? null };
    ledger.threads.push(entry); save();
    await request('thread/name/set', { threadId: entry.id, name: entry.name });
  }
  ledger.state = 'ready'; save();
  process.stdout.write(JSON.stringify({ runId: ledger.runId, state: ledger.state, threads: ledger.threads.length, sentTurns: 0 }) + '\n');
} catch (error) { ledger.state = 'failed_or_uncertain'; ledger.error = error.message; save(); throw error; }
finally { for (const call of pending.values()) clearTimeout(call.timer); ws.close(); }
