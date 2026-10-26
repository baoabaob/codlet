// Opt-in Native capability gate. Creates one disposable thread, injects two
// synthetic model-context messages, reads canonical history, and deletes ONLY
// that newly acknowledged thread. Never starts a model turn or changes the UI.
import fs from 'node:fs';
import path from 'node:path';
import { execFileSync } from 'node:child_process';
import { randomUUID, createHash } from 'node:crypto';
import { fileURLToPath, pathToFileURL } from 'node:url';
import { sha256 } from './synthetic-history.mjs';

const canonical = value => path.toNamespacedPath(path.resolve(value)).toLowerCase();
const within = (value, parent) => canonical(value).startsWith(canonical(parent) + path.sep);
const code = error => Number.isInteger(error?.code) ? error.code : typeof error?.code === 'string' ? error.code : 'probe_failed';
const rawText = item => item.text ?? (Array.isArray(item.content) ? item.content.filter(value => value.type === 'text').map(value => value.text).join('\n') : '');

export async function probeCanonicalHistory(request, { project, codexHome, protectedIds = [], onCreated = () => {} }) {
  const { thread } = await request('thread/start', { cwd: project, ephemeral: false, approvalPolicy: 'never', sandbox: 'read-only' });
  const validate = value => {
    if (value?.id !== thread.id || !/^[a-f0-9]{8}-[a-f0-9]{4}-[a-f0-9]{4}-[a-f0-9]{4}-[a-f0-9]{12}$/i.test(value?.id ?? '') || protectedIds.includes(value.id) ||
        typeof value.cwd !== 'string' || canonical(value.cwd) !== canonical(project) || typeof value.path !== 'string' || !within(value.path, codexHome))
      throw Error('New synthetic thread ownership differs');
  };
  validate(thread);
  if (thread.turns?.length !== 0) throw Error('New synthetic thread is not empty');
  const markers = [`Synthetic history probe ${thread.id} user`, `Synthetic history probe ${thread.id} assistant\n\n\`\`\`javascript\nconst fixture = 1;\n\`\`\``];
  const report = { schema: 1, threadId: thread.id, sentTurns: 0, injectedItems: 0, nativeClientTested: false,
    nativeStreamingTested: false, nativePaintMeasured: false, canonicalTurnHistoryReadback: false, fullMixedHistoryCoverage: false,
    markerSha256: markers.map(sha256), reads: {}, state: 'probing', cleanup: { deleted: false } };
  try {
    await onCreated({ id: thread.id, cwd: thread.cwd, rolloutPath: thread.path });
    await request('thread/name/set', { threadId: thread.id, name: 'Disposable Adapter history probe ' + thread.id });
    await request('thread/inject_items', { threadId: thread.id, items: markers.map((text, index) => ({ type: 'message', role: index ? 'assistant' : 'user', content: [{ type: index ? 'output_text' : 'input_text', text }] })) });
    report.injectedItems = 2;
    const read = async (label, operation) => {
      try {
        const { turns, items } = await operation();
        const found = new Set(items.map(rawText).filter(text => markers.includes(text)));
        report.reads[label] = { ok: true, turns, items: items.length, matchingMarkers: found.size };
      } catch (error) { report.reads[label] = { ok: false, code: code(error) }; }
    };
    await read('threadRead', async () => {
      const { thread: value } = await request('thread/read', { threadId: thread.id, includeTurns: true });
      validate(value);
      const turns = value.turns ?? [];
      return { turns: turns.length, items: turns.flatMap(turn => turn.items ?? []) };
    });
    let turnCount = 0;
    await read('turnsList', async () => {
      const items = []; let cursor;
      for (let page = 0; page < 30; page++) {
        const reply = await request('thread/turns/list', { threadId: thread.id, limit: 100, ...(cursor ? { cursor } : {}) });
        if (!Array.isArray(reply.data)) throw Error('Invalid turns page');
        turnCount += reply.data.length; items.push(...reply.data.flatMap(turn => turn.items ?? []));
        cursor = reply.nextCursor;
        if (!cursor) return { turns: turnCount, items };
      }
      throw Error('Probe page limit exceeded');
    });
    await read('itemsList', async () => {
      const items = []; let cursor;
      for (let page = 0; page < 30; page++) {
        const reply = await request('thread/items/list', { threadId: thread.id, limit: 100, ...(cursor ? { cursor } : {}) });
        if (!Array.isArray(reply.data)) throw Error('Invalid items page');
        items.push(...reply.data.map(value => value.item)); cursor = reply.nextCursor;
        if (!cursor) return { turns: turnCount, items };
      }
      throw Error('Probe page limit exceeded');
    });
    report.canonicalTurnHistoryReadback = Object.values(report.reads).some(value => value.ok && value.turns > 0 && value.matchingMarkers === 2);
    report.result = report.canonicalTurnHistoryReadback ? 'canonical-message-history-candidate; Native rendering still unverified' : 'no-canonical-turn-readback-from-model-history-injection';
  } catch (error) { report.error = { code: code(error) }; report.result = 'probe-failed-or-uncertain'; }
  finally {
    try {
      // A fresh identity read guards cleanup even if injection's outcome is unknown.
      const { thread: current } = await request('thread/read', { threadId: thread.id, includeTurns: false });
      validate(current);
      if (current.id !== thread.id || canonical(current.path) !== canonical(thread.path)) throw Error('Synthetic cleanup identity changed');
      try { await request('thread/unsubscribe', { threadId: thread.id }); }
      catch (error) { report.cleanup.unsubscribeCode = code(error); }
      await request('thread/delete', { threadId: thread.id });
      report.cleanup.deleted = true;
    } catch (error) { report.cleanup.code = code(error); }
    report.state = report.cleanup.deleted ? 'closed' : 'cleanup_required';
  }
  return report;
}

async function main() {
  if (process.argv.length !== 5 || process.argv[4] !== '--probe') throw Error('Usage: node probe-native-history.mjs <owned-run-directory> <protocol-export-directory> --probe');
  const repo = fileURLToPath(new URL('../../../', import.meta.url)), directory = path.resolve(process.argv[2]), protocolDir = path.resolve(process.argv[3]);
  if (!within(directory, path.join(repo, '.artifacts/adapter-native')) || !/^adapter-[a-f0-9-]{36}$/.test(path.basename(directory)) ||
      !within(protocolDir, path.join(repo, '.artifacts/workspace-history')) || !/^protocol-[a-f0-9-]{36}$/.test(path.basename(protocolDir))) throw Error('Explicit owned run and protocol export required');
  const protocol = JSON.parse(fs.readFileSync(path.join(protocolDir, 'report.json'), 'utf8'));
  const config = JSON.parse(fs.readFileSync(path.join(directory, 'client/lab-config.json'), 'utf8'));
  const binaryHash = createHash('sha256').update(fs.readFileSync(config.officialCli)).digest('hex');
  if (!protocol.publicInjectItems || !protocol.publicDelete || protocol.injectionScope !== 'model-visible history' || protocol.backendLaunched !== false ||
      canonical(protocol.binary) !== canonical(config.officialCli) || binaryHash !== protocol.binarySha256) throw Error('Exact public protocol pin required');
  for (const [file, hash] of Object.entries(protocol.schemaSha256)) {
    if (!within(path.join(protocolDir, file), protocolDir) || sha256(fs.readFileSync(path.join(protocolDir, file), 'utf8')) !== hash) throw Error('Protocol export changed');
  }
  // Includes actual roots/creation identities, listener, registry/Target, backend
  // configuration/authentication and the eight protected synthetic thread IDs.
  execFileSync(process.execPath, [path.join(repo, 'tests/fixtures/workspace-acceptance/verify-native-run.mjs'), directory, '--synthetic'], { encoding: 'utf8', windowsHide: true, timeout: 60000 });
  const evidence = JSON.parse(fs.readFileSync(path.join(directory, 'owned-runtime-evidence.json'), 'utf8'));
  const stateFile = path.join(directory, 'profile/logs/manual-client.json'), state = JSON.parse(fs.readFileSync(stateFile, 'utf8'));
  if (evidence.phase !== 'ready' || state.state !== 'ready' || !evidence.authenticated || !evidence.sandboxReady || evidence.syntheticThreadsVerified !== 8 || evidence.coordinatorRunId !== state.runId) throw Error('Owned synthetic run is not ready');
  const synthetic = JSON.parse(fs.readFileSync(path.join(directory, 'synthetic-threads.json'), 'utf8'));
  const output = path.join(directory, 'history-probe-' + randomUUID()); fs.mkdirSync(output);
  const ledger = { schema: 1, runId: evidence.runId, coordinatorRunId: state.runId, state: 'connecting', sentTurns: 0, methods: {}, createdThread: null, protocolBinarySha256: binaryHash };
  const save = () => { const next = path.join(output, 'ledger.json.next'); fs.writeFileSync(next, JSON.stringify(ledger, null, 2) + '\n'); fs.renameSync(next, path.join(output, 'ledger.json')); };
  save();
  const ws = new WebSocket(state.endpoint), pending = new Map(); let id = 0;
  const permitted = new Set(['initialize', 'thread/start', 'thread/name/set', 'thread/inject_items', 'thread/read', 'thread/turns/list', 'thread/items/list', 'thread/unsubscribe', 'thread/delete']);
  ws.addEventListener('message', event => {
    const message = JSON.parse(String(event.data)), call = pending.get(message.id); if (!call) return;
    pending.delete(message.id); clearTimeout(call.timer);
    message.error ? call.reject(Object.assign(Error('Native probe request rejected'), { code: message.error.code })) : call.resolve(message.result);
  });
  ws.addEventListener('close', () => { for (const call of pending.values()) { clearTimeout(call.timer); call.reject(Object.assign(Error('Owned connection closed'), { code: 'connection_closed' })); } pending.clear(); });
  const request = (method, params) => {
    if (!permitted.has(method) || (method !== 'initialize' && method !== 'thread/start' && params.threadId !== ledger.createdThread?.id)) throw Error('Unpermitted Native probe request');
    const current = JSON.parse(fs.readFileSync(stateFile, 'utf8'));
    if (current.state !== 'ready' || current.runId !== state.runId || current.endpoint !== state.endpoint || current.backendPid !== state.backendPid || current.backendIdentity.created !== state.backendIdentity.created) throw Error('Owned coordinator changed');
    ledger.methods[method] = (ledger.methods[method] ?? 0) + 1; save();
    return new Promise((resolve, reject) => {
      const ticket = ++id, timer = setTimeout(() => { pending.delete(ticket); reject(Object.assign(Error('Uncertain Native probe request'), { code: 'outcome_unknown' })); }, 15000);
      pending.set(ticket, { resolve, reject, timer }); ws.send(JSON.stringify({ id: ticket, method, params }));
    });
  };
  try {
    await new Promise((resolve, reject) => {
      const timer = setTimeout(() => reject(Error('Owned backend unavailable')), 5000);
      ws.addEventListener('open', () => { clearTimeout(timer); resolve(); }, { once: true });
      ws.addEventListener('error', () => { clearTimeout(timer); reject(Error('Owned backend unavailable')); }, { once: true });
    });
    const initialized = await request('initialize', { clientInfo: { name: 'codlet-adapter-history-probe', version: '0.1.0' }, capabilities: { experimentalApi: false } });
    const codexHome = path.join(directory, 'profile/codex-home'), project = path.join(directory, 'profile/project');
    if (typeof initialized.codexHome !== 'string' || canonical(initialized.codexHome) !== canonical(codexHome)) throw Error('Backend effective home differs');
    ws.send(JSON.stringify({ method: 'initialized', params: {} }));
    ledger.state = 'probing'; save();
    const report = await probeCanonicalHistory(request, { project, codexHome, protectedIds: synthetic.threads.map(value => value.id),
      onCreated(value) { ledger.createdThread = value; save(); } });
    ledger.state = report.state; ledger.result = report.result; ledger.cleanup = report.cleanup; save();
    fs.writeFileSync(path.join(output, 'report.json'), JSON.stringify({ ...report, nativeBackendTested: true, runId: evidence.runId, coordinatorRunId: state.runId, protocolBinarySha256: binaryHash }, null, 2) + '\n', { flag: 'wx' });
    console.log(JSON.stringify({ output, state: report.state, canonicalTurnHistoryReadback: report.canonicalTurnHistoryReadback, nativeClientTested: false, sentTurns: 0 }));
    if (report.state !== 'closed' || report.error) process.exitCode = 1;
  } catch (error) { ledger.state = 'failed_or_uncertain'; ledger.error = { code: code(error) }; save(); throw error; }
  finally { for (const call of pending.values()) clearTimeout(call.timer); ws.close(); }
}

if (process.argv[1] && import.meta.url === pathToFileURL(path.resolve(process.argv[1])).href) await main();
