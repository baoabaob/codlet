// Offline audit only. Never connect, start/stop processes, or rewrite evidence.
import fs from 'node:fs';
import path from 'node:path';
import { createHash } from 'node:crypto';
import { fileURLToPath } from 'node:url';
import { creationTime, sameCreation } from '../../../scripts/process-identity.mjs';

const repo = fileURLToPath(new URL('../../../', import.meta.url)), directory = path.resolve(process.argv[2] ?? '');
const plan = JSON.parse(fs.readFileSync(path.join(directory, 'preflight.json'), 'utf8'));
if (directory !== path.join(repo, '.artifacts/adapter-native', plan.runId)) throw Error('Explicit owned history required');
const outputName = process.argv[3];
if (!/^process-ownership-audit-[a-z0-9-]+\.json$/.test(outputName ?? '')) throw Error('Fresh audit filename required');
const sources = [];
function read(relative) {
  const bytes = fs.readFileSync(path.join(directory, relative));
  sources.push({ path: relative, sha256: createHash('sha256').update(bytes).digest('hex') });
  return JSON.parse(bytes);
}
function auditPopulation(report, state) {
  if (report.runId !== plan.runId || state.runId !== report.coordinatorRunId || creationTime(state.managerCreated) === null) throw Error('Historical ownership metadata differs');
  const manager = report.processes.find(value => value.pid === state.managerPid);
  if (!manager || !sameCreation(manager.created, state.managerCreated)) throw Error('Historical manager identity differs');
  const floor = creationTime(state.managerCreated);
  const impossibleBeforeManager = report.processes.filter(value => creationTime(value.created) !== null && creationTime(value.created) < floor)
    .map(({ pid, created }) => ({ pid, created, reason: 'created_before_verified_manager' }));
  const missingDates = report.processes.filter(value => creationTime(value.created) === null).map(value => value.pid);
  const rootPids = [state.managerPid, state.hostPid, state.backendPid, state.desktopPid];
  return { processCount: report.processes.length, managerCreated: state.managerCreated, rootPids,
    impossibleBeforeManager, missingDates, lineageRecorded: report.processes.every(value => rootPids.includes(value.pid) ||
      Number.isSafeInteger(value.parentPid) && typeof value.parentCreated === 'string'),
    limitation: 'The manager creation floor is necessary only; without parent identities it cannot certify newer processes as descendants' };
}
const retirements = [];
for (const name of fs.readdirSync(directory).filter(name => /^retirement-[0-9]+-[0-9]+\.before\.json$/.test(name)).sort()) {
  const before = read(name), closedName = name.replace('.before.json', '.closed.json');
  const state = read('profile/logs/coordinator-' + before.coordinatorRunId + '/state.json');
  const population = auditPopulation(before, state), closed = fs.existsSync(path.join(directory, closedName)) ? read(closedName) : null;
  const excluded = new Set(population.impossibleBeforeManager.map(value => value.pid));
  if (closed && (closed.runId !== before.runId || closed.coordinatorRunId !== before.coordinatorRunId)) throw Error('Historical retirement identity differs');
  retirements.push({ coordinatorRunId: before.coordinatorRunId, before: name, closed: closedName, ...population,
    status: population.impossibleBeforeManager.length ? 'definitely_contaminated' : population.lineageRecorded ? 'lineage_available_for_validation' : 'no_pre_manager_contamination_found_but_lineage_missing',
    recordedRemaining: closed?.remainingOwnedProcesses?.length ?? null,
    recordedRootsRemaining: closed?.remainingOwnedProcesses?.filter(value => population.rootPids.includes(value.pid)).map(value => value.pid) ?? null,
    residualAfterNecessaryFloorOnly: closed?.remainingOwnedProcesses?.filter(value => !excluded.has(value.pid)).map(value => value.pid) ?? null,
    correctedOwnershipClaim: false });
}
const baselines = [];
for (const name of fs.readdirSync(directory).filter(name => name === 'empty-home-baseline.json')) {
  const report = read(name), state = read('profile/logs/coordinator-' + report.coordinatorRunId + '/state.json');
  const population = auditPopulation(report, state);
  baselines.push({ file: name, coordinatorRunId: report.coordinatorRunId, ...population,
    intervals: report.samples.length, intervalSnapshotsRecorded: Array.isArray(report.snapshots), stableProcessGroupRecorded: report.stableProcessGroup,
    status: population.impossibleBeforeManager.length ? 'definitely_contaminated' : 'not_fully_reconstructible', usableForOwnershipBasedAttribution: false,
    reason: 'Legacy aggregate intervals do not retain per-snapshot parent identity and per-process CPU/memory; final membership alone cannot reconstruct ownership or correct totals' });
}
const audit = { schema: 1, runId: plan.runId, auditedAt: new Date().toISOString(), offlineOnly: true,
  retirements, baselines, sources,
  rendererMetrics: { ownershipAlgorithm: 'exact-owned-Target/CDP-session', usesRecursiveParentPidGroup: false,
    scope: 'native-owned-probe-host.cjs Performance.getMetrics samples; OS group attribution corrections do not change those samples' },
  limits: ['No name-based exclusions', 'No old evidence rewritten', 'No new ownership inference from a present-day PID relationship',
    'Not detecting an older process does not prove complete historical lineage'] };
fs.writeFileSync(path.join(directory, outputName), JSON.stringify(audit, null, 2) + '\n', { flag: 'wx' });
process.stdout.write(JSON.stringify({ retirements: retirements.map(value => ({ coordinator: value.coordinatorRunId, status: value.status,
  captured: value.processCount, impossible: value.impossibleBeforeManager.length, recordedRootsRemaining: value.recordedRootsRemaining })), baselines }) + '\n');
