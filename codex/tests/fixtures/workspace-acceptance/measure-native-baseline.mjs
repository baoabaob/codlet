// One owned run, fixed 30-second empty-home baseline. No UI automation, input,
// messages or profiling observers; this is not a pane/bind performance test.
import fs from 'node:fs';
import path from 'node:path';
import os from 'node:os';
import { fileURLToPath } from 'node:url';
import { ownedProcessSnapshot } from './owned-process-snapshot.mjs';

const directory = path.resolve(process.argv[2] ?? ''), repo = fileURLToPath(new URL('../../../', import.meta.url));
const evidence = JSON.parse(fs.readFileSync(path.join(directory, 'owned-runtime-evidence.json'), 'utf8'));
if (directory !== path.join(repo, '.artifacts/adapter-native', evidence.runId) || evidence.phase !== 'ready' || evidence.syntheticThreadsVerified || !evidence.authenticated ||
    !evidence.sandboxReady || evidence.activeThreads !== 0 || evidence.archivedThreads !== 0) throw Error('Verified owned empty Native run required');
const stateFile = path.join(directory, 'profile/logs/manual-client.json');
const initial = JSON.parse(fs.readFileSync(stateFile, 'utf8'));
const pids = [initial.managerPid, initial.hostPid, initial.backendPid, initial.desktopPid];
if (pids.some(pid => !Number.isSafeInteger(pid) || pid <= 0) || initial.runId !== evidence.coordinatorRunId) throw Error('Invalid owned process group');
const output = path.join(directory, 'empty-home-baseline.json');
if (fs.existsSync(output)) throw Error('A completed/uncertain baseline must not be overwritten');
function snapshot() {
  const state = JSON.parse(fs.readFileSync(stateFile, 'utf8'));
  if (state.runId !== initial.runId || state.state !== 'ready' || pids.some((pid, index) => pid !== [state.managerPid, state.hostPid, state.backendPid, state.desktopPid][index])) throw Error('Owned run restarted during baseline');
  const roots = pids.map(pid => evidence.processes.find(value => value.pid === pid));
  if (roots.some(value => !value)) throw Error('Owned root evidence missing');
  const result = ownedProcessSnapshot(roots, true);
  return { ...result, at: performance.now() };
}
const samples = [], first = snapshot(), snapshots = [first]; let previous = first;
for (let count = 0; count < 5; count++) {
  await new Promise(resolve => setTimeout(resolve, 6000));
  const next = snapshot(), before = new Map(previous.processes.map(process => [process.pid + ':' + process.created, process]));
  snapshots.push(next);
  let cpuMs = 0; const newProcesses = [];
  for (const process of next.processes) {
    const old = before.get(process.pid + ':' + process.created);
    if (old) cpuMs += Math.max(0, process.cpuMs - old.cpuMs);
    else { cpuMs += process.cpuMs; newProcesses.push(process.pid); }
  }
  const live = new Set(next.processes.map(process => process.pid + ':' + process.created));
  const exitedProcesses = previous.processes.filter(process => !live.has(process.pid + ':' + process.created)).map(process => process.pid);
  samples.push({ wallMs: next.at - previous.at, cpuMs, oneCorePercent: cpuMs / (next.at - previous.at) * 100,
    privateBytes: next.processes.reduce((sum, process) => sum + process.privateBytes, 0), processCount: next.processes.length, newProcesses, exitedProcesses });
  previous = next;
}
const wallMs = samples.reduce((sum, sample) => sum + sample.wallMs, 0), cpuMs = samples.reduce((sum, sample) => sum + sample.cpuMs, 0);
const report = { schema: 2, ownershipMethod: first.ownershipMethod, runId: evidence.runId, coordinatorRunId: initial.runId, scene: 'empty-native-home-after-discovery',
  visibility: 'hidden-at-last-owned-probe', threadCount: 0, adapterRoots: 0, nativePaneMatrixTested: false, nativeDraftHandoffTested: false,
  wallMs, cpuMs, logicalProcessors: os.availableParallelism(), oneCorePercent: cpuMs / wallMs * 100,
  systemPercent: cpuMs / wallMs * 100 / os.availableParallelism(), samples, snapshots,
  processes: previous.processes.map(({ cpuMs, privateBytes, ...identity }) => identity),
  limitations: ['No foreground input/paint latency measured', 'Exited-child final CPU is unavailable; any process churn invalidates a steady baseline', 'Contains Core and Native background services; no Adapter increment inferred'] };
report.stableProcessGroup = samples.every(sample => !sample.newProcesses.length && !sample.exitedProcesses.length) && snapshots.every(value => !value.raced.length);
fs.writeFileSync(output, JSON.stringify(report, null, 2) + '\n', { flag: 'wx' });
process.stdout.write(JSON.stringify({ runId: evidence.runId, wallMs, oneCorePercent: report.oneCorePercent,
  systemPercent: report.systemPercent, stableProcessGroup: report.stableProcessGroup, nativePaneMatrixTested: false }) + '\n');
