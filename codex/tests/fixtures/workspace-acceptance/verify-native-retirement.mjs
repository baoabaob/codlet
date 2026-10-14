// Capture one verified process group, then verify normal shutdown identities.
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { sameCreation } from '../../../scripts/process-identity.mjs';
import { ownedProcessSnapshot, processFacts } from './owned-process-snapshot.mjs';

const directory = path.resolve(process.argv[2] ?? ''), mode = process.argv[3];
const repo = fileURLToPath(new URL('../../../', import.meta.url));
const evidence = JSON.parse(fs.readFileSync(path.join(directory, 'owned-runtime-evidence.json'), 'utf8'));
if (directory !== path.join(repo, '.artifacts/adapter-native', evidence.runId) || !['capture', 'closed'].includes(mode)) throw Error('Explicit owned retirement mode required');
const state = JSON.parse(fs.readFileSync(path.join(directory, 'profile/logs/manual-client.json'), 'utf8'));
if (state.runId !== evidence.coordinatorRunId) throw Error('Owned coordinator changed');
const pids = [state.managerPid, state.hostPid, state.backendPid, state.desktopPid];
if (mode === 'capture' && pids.some(pid => !Number.isSafeInteger(pid) || pid <= 0)) throw Error('Owned process identities missing');
const beforeFile = path.join(directory, 'retirement-' + state.runId + '.before.json');
if (mode === 'capture') {
  if (state.state !== 'ready') throw Error('Capture requires the same ready owned run');
  const roots = pids.map(pid => evidence.processes.find(value => value.pid === pid));
  if (roots.some(value => !value)) throw Error('Owned root evidence missing');
  const snapshot = ownedProcessSnapshot(roots);
  const report = { schema: 2, runId: evidence.runId, coordinatorRunId: state.runId, ...snapshot };
  fs.writeFileSync(beforeFile, JSON.stringify(report, null, 2) + '\n', { flag: 'wx' });
  process.stdout.write(JSON.stringify({ runId: report.runId, coordinatorRunId: state.runId, processes: report.processes.length, rejectedEdges: report.rejectedEdges.length }) + '\n');
} else {
  if (state.state !== 'closed') throw Error('Owned coordinator has not closed');
  const before = JSON.parse(fs.readFileSync(beforeFile, 'utf8'));
  if (before.runId !== evidence.runId || before.coordinatorRunId !== state.runId) throw Error('Retirement capture differs');
  if (before.ownershipMethod !== 'pid-creation-parent-creation-v1') throw Error('Legacy PID-only capture requires a separate ownership audit; original evidence is preserved');
  const live = processFacts(before.processes.map(value => value.pid));
  const remaining = live.filter(actual => before.processes.some(expected => actual.pid === expected.pid && sameCreation(actual.created, expected.created)));
  const report = { schema: 2, ownershipMethod: before.ownershipMethod, runId: evidence.runId, coordinatorRunId: state.runId, checkedAt: new Date().toISOString(), coordinatorState: state.state,
    capturedProcesses: before.processes.length, remainingOwnedProcesses: remaining, reusedPids: live.filter(value => !remaining.includes(value)).map(value => value.pid) };
  fs.writeFileSync(path.join(directory, 'retirement-' + state.runId + '.closed.json'), JSON.stringify(report, null, 2) + '\n', { flag: 'wx' });
  if (remaining.length) throw Error('Owned process identities remain after coordinator closed');
  process.stdout.write(JSON.stringify({ runId: report.runId, coordinatorState: state.state, capturedProcesses: report.capturedProcesses, remainingOwnedProcesses: 0 }) + '\n');
}
