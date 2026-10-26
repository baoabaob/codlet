// Read-only ownership and empty-data check for one explicit Adapter run.
import fs from 'node:fs';
import path from 'node:path';
import { execFileSync } from 'node:child_process';
import { createHash } from 'node:crypto';
import { fileURLToPath } from 'node:url';
import { sameCreation } from '../../../scripts/process-identity.mjs';
import { writeFixtureReport } from '../../../scripts/owned-fixture.mjs';

const directory = path.resolve(process.argv[2] ?? ''), plan = JSON.parse(fs.readFileSync(path.join(directory, 'preflight.json'), 'utf8'));
const repo = fileURLToPath(new URL('../../../', import.meta.url));
const samePath = (left, right) => path.toNamespacedPath(path.resolve(left)).toLowerCase() === path.toNamespacedPath(path.resolve(right)).toLowerCase();
if (path.basename(directory) !== plan.runId || !/^adapter-[a-f0-9-]{36}$/.test(plan.runId) || plan.layer !== 'adapter' ||
    directory !== path.join(repo, '.artifacts/adapter-native', plan.runId)) throw Error('Explicit owned Adapter run required');
const root = path.join(directory, 'profile'), config = JSON.parse(fs.readFileSync(path.join(directory, 'client/lab-config.json'), 'utf8'));
const synthetic = process.argv[3] === '--synthetic' ? JSON.parse(fs.readFileSync(path.join(directory, 'synthetic-threads.json'), 'utf8')) : null;
if (process.argv[3] && !synthetic) throw Error('Unknown ownership verification mode');
if (!synthetic && fs.existsSync(path.join(directory, 'synthetic-threads.json'))) throw Error('An owned synthetic ledger requires explicit --synthetic verification');
if (synthetic && (synthetic.runId !== plan.runId || synthetic.state !== 'ready' || synthetic.sentTurns !== 0 || synthetic.threads.length !== 8 ||
    new Set(synthetic.threads.map(thread => thread.id)).size !== 8 || synthetic.threads.some(thread => thread.initialTurns !== 0 ||
      !path.resolve(thread.rolloutPath).startsWith(path.join(root, 'codex-home') + path.sep)))) throw Error('Invalid owned synthetic ledger');
const state = JSON.parse(fs.readFileSync(path.join(root, 'logs/manual-client.json'), 'utf8'));
if (path.resolve(config.labRoot) !== root || path.resolve(state.labRoot) !== root || !['ready', 'awaiting_authentication', 'awaiting_sandbox'].includes(state.state) ||
    !/^\d+-\d+$/.test(state.runId) || path.resolve(state.logs) !== path.join(root, 'logs/coordinator-' + state.runId)) throw Error('Coordinator ownership mismatch');
const powershell = path.join(process.env.SYSTEMROOT ?? 'C:/Windows', 'System32/WindowsPowerShell/v1.0/powershell.exe');
const pids = [state.managerPid, state.hostPid, state.backendPid, state.desktopPid];
if (pids.some(pid => !Number.isSafeInteger(pid) || pid <= 0)) throw Error('Missing process ownership');
const ps = source => JSON.parse(execFileSync(powershell, ['-NoProfile', '-NonInteractive', '-Command', source], { encoding: 'utf8', windowsHide: true }).trim());
const facts = ps(`@(${pids.join(',')}) | ForEach-Object { $adapterProcess=Get-Process -Id $_ -ErrorAction Stop; [pscustomobject]@{pid=$adapterProcess.Id;created=$adapterProcess.StartTime.ToUniversalTime().ToString('o');filetime=$adapterProcess.StartTime.ToUniversalTime().ToFileTimeUtc().ToString();image=$adapterProcess.Path} } | ConvertTo-Json -Compress`);
const byPid = new Map(facts.map(fact => [fact.pid, fact]));
if (!sameCreation(byPid.get(state.managerPid).created, state.managerCreated) || byPid.get(state.desktopPid).filetime !== state.desktopCreated ||
    !sameCreation(byPid.get(state.backendPid).created, state.backendIdentity.created)) throw Error('Process creation mismatch');
if (path.resolve(byPid.get(state.hostPid).image).toLowerCase() !== path.join(directory, 'client/codlet-lab.exe').toLowerCase() ||
    path.resolve(byPid.get(state.backendPid).image).toLowerCase() !== path.resolve(config.officialCli).toLowerCase() ||
    path.resolve(byPid.get(state.desktopPid).image).toLowerCase() !== path.join(path.dirname(path.dirname(config.officialCli)), 'ChatGPT.exe').toLowerCase()) throw Error('Owned executable mismatch');
const endpoint = new URL(state.endpoint);
if (endpoint.protocol !== 'ws:' || endpoint.hostname !== '127.0.0.1' || !/^\d+$/.test(endpoint.port) || endpoint.pathname !== '/' || endpoint.search) throw Error('Invalid loopback endpoint');
const listener = ps(`Get-NetTCPConnection -LocalPort ${Number(endpoint.port)} -State Listen | Select-Object OwningProcess,LocalAddress | ConvertTo-Json -Compress`);
if (Array.isArray(listener) || listener.OwningProcess !== state.backendPid || listener.LocalAddress !== '127.0.0.1') throw Error('Backend listener mismatch');
if (!path.resolve(state.report).startsWith(path.join(root, 'logs') + path.sep)) throw Error('Report escaped profile');
const rows = fs.readFileSync(state.report, 'utf8').trim().split(/\r?\n/).map(line => JSON.parse(line));
const prepared = rows.find(row => row.event === 'prepared')?.detail, attached = rows.find(row => row.event === 'renderer_attached');
const runtime = rows.find(row => row.event === 'plugin_runtime_ready'), startup = rows.find(row => row.event === 'startup_verified');
if (!prepared || !attached || !runtime || !startup || attached.child_pid !== state.desktopPid || attached.host_pid !== state.hostPid) throw Error('Missing startup/renderer ownership');
for (const key of ['root', 'codex_home', 'sqlite_home', 'user_data', 'project', 'plugin_registry']) {
  const value = path.resolve(prepared[key]); if (value !== root && !value.startsWith(root + path.sep)) throw Error('Data route escaped profile');
}
const targetId = attached.detail.target_id, snapshot = rows.filter(row => row.event === 'renderer_snapshot').at(-1)?.detail.renderer;
if (!snapshot?.targets.some(target => target.target_id === targetId && target.session_live)) throw Error('Owned Target is not live');
const ws = new WebSocket(state.endpoint), pending = new Map(); let id = 0;
ws.addEventListener('message', event => {
  const message = JSON.parse(String(event.data)), call = pending.get(message.id); if (!call) return;
  pending.delete(message.id); clearTimeout(call.timer); message.error ? call.reject(Error('Read-only backend request failed')) : call.resolve(message.result);
});
function request(method, params) {
  return new Promise((resolve, reject) => {
    const ticket = ++id, timer = setTimeout(() => { pending.delete(ticket); reject(Error('Read-only backend request timed out')); }, 10000);
    pending.set(ticket, { resolve, reject, timer }); ws.send(JSON.stringify({ id: ticket, method, params }));
  });
}
try {
  await new Promise((resolve, reject) => {
    const timer = setTimeout(() => reject(Error('Backend connection timed out')), 5000);
    ws.addEventListener('open', () => { clearTimeout(timer); resolve(); }, { once: true });
    ws.addEventListener('error', () => { clearTimeout(timer); reject(Error('Backend connection failed')); }, { once: true });
  });
  const initialized = await request('initialize', { clientInfo: { name: 'codlet-adapter-owned-data-check', version: '0.1.0' }, capabilities: { experimentalApi: true } });
  if (typeof initialized.codexHome !== 'string' || !samePath(initialized.codexHome, path.join(root, 'codex-home'))) throw Error('Backend effective home differs');
  ws.send(JSON.stringify({ method: 'initialized', params: {} }));
  const account = await request('account/read', { refreshToken: false });
  const { config: effective } = await request('config/read', { cwd: path.join(root, 'project'), includeLayers: false });
  const sandbox = await request('windowsSandbox/readiness', {});
  if (effective.cli_auth_credentials_store !== 'file' || effective.sandbox_mode !== 'read-only' ||
      effective.mcp_servers?.codex_app?.enabled !== false || effective.mcp_servers.codex_app.command !== '') throw Error('Backend effective isolation differs');
  let activeThreads = 0, archivedThreads = 0;
  const allowed = new Set(synthetic?.threads.map(thread => thread.id) ?? []);
  for (const archived of [false, true]) {
    const reply = await request('thread/list', { limit: synthetic ? 100 : 1, archived, useStateDbOnly: true });
    if (!Array.isArray(reply.data) || reply.nextCursor || reply.data.some(thread => !allowed.has(thread.id))) throw Error('Run contains unowned threads or an incomplete list');
    if (archived) archivedThreads = reply.data.length; else activeThreads = reply.data.length;
  }
  for (const fixture of synthetic?.threads ?? []) {
    const { thread } = await request('thread/read', { threadId: fixture.id, includeTurns: false });
    const mismatches = { id: thread?.id !== fixture.id,
      cwd: !samePath(thread.cwd, path.join(root, 'project')),
      // Native resume returns the Windows extended path spelling of this file.
      rollout: !samePath(thread.path, fixture.rolloutPath), name: thread.name !== fixture.name };
    if (Object.values(mismatches).some(Boolean)) throw Error('Owned synthetic metadata differs: ' + JSON.stringify({ index: fixture.index, mismatches }));
  }
  const hash = file => createHash('sha256').update(fs.readFileSync(file)).digest('hex'), labHash = hash(path.join(directory, 'client/codlet-lab.exe'));
  if (labHash !== config.labBinarySha256.toLowerCase() || labHash !== plan.hashes.expectedLabBinary) throw Error('Lab pin changed');
  if (!fs.existsSync(path.join(root, 'home/AppData/Roaming/Codex/web/Codex'))) throw Error('Owned Native web profile is missing');
  const evidence = { schema: 1, runId: plan.runId, coordinatorRunId: state.runId, phase: state.state, packageVersion: config.expectedPackageVersion,
    registry: prepared.plugin_registry, registryScope: runtime.detail.registry_scope,
    dataRoutes: { codexHome: prepared.codex_home, sqlite: prepared.sqlite_home, electronUserData: prepared.user_data,
      webProfileWithinOwnedRoaming: fs.existsSync(path.join(root, 'home/AppData/Roaming/Codex/web/Codex')) },
    processes: facts, targetId, targetEvidence: 'Owned pipe renderer snapshot', startup: startup.detail.evidence,
    originalProcessesUnchangedAtStartup: state.originalProcessesUnchanged, authenticated: account.account != null,
    sandboxReady: sandbox.status === 'ready', activeThreads, archivedThreads, syntheticThreadsVerified: synthetic?.threads.length ?? 0, labBinarySha256: labHash, performanceMeasured: false };
  await writeFixtureReport(directory, 'owned-runtime-evidence.json', evidence);
  process.stdout.write(JSON.stringify({ runId: plan.runId, phase: evidence.phase, authenticated: evidence.authenticated, sandboxReady: evidence.sandboxReady,
    activeThreads, archivedThreads, syntheticThreadsVerified: evidence.syntheticThreadsVerified, performanceMeasured: false }) + '\n');
} finally { for (const call of pending.values()) clearTimeout(call.timer); ws.close(); }
