// Offline, explicit owned timeline analysis; no client connection.
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
const filename = path.resolve(process.argv[2] ?? ''), directory = path.dirname(filename), outputName = process.argv[3] ?? 'summary.json';
if (!/^summary(?:-[a-z0-9-]+)?\.json$/.test(outputName)) throw Error('Fresh summary filename required');
const report = JSON.parse(fs.readFileSync(filename, 'utf8')), spec = JSON.parse(fs.readFileSync(path.join(directory, 'owned-run.json'), 'utf8'));
const repo = fileURLToPath(new URL('../../../', import.meta.url));
if (filename !== path.join(directory, 'report.json') || path.dirname(directory) !== path.join(repo, '.artifacts/adapter-native', report.runId) ||
    spec.runId !== report.runId || spec.targetId !== report.targetId || spec.mode !== 'timeline') throw Error('Explicit owned timeline required');
function stats(values) {
  const list = values.filter(value => typeof value === 'number').sort((a, b) => a - b), mid = Math.floor(list.length / 2);
  return list.length ? { n: list.length, min: list[0], median: list.length % 2 ? list[mid] : (list[mid - 1] + list[mid]) / 2, max: list.at(-1) } : null;
}
const operations = report.result?.operations ?? [], groups = [];
for (const mode of ['native-strict', 'adapter', 'native-dom-only']) {
  const entries = operations.filter(value => value.mode === mode);
  groups.push({ mode, n: entries.length, passed: entries.every(value => value.status === 'passed'),
    routeDispatchSynchronousMs: stats(entries.map(value => value.routeDispatchSynchronousMs)),
    routerPromiseResolvedMs: stats(entries.map(value => value.routerPromiseResolvedMs)),
    afterDispatchMicrotaskMs: stats(entries.map(value => value.afterDispatchMicrotaskMs)),
    zeroDelayTimerMs: stats(entries.map(value => value.zeroDelayTimerMs)),
    dispatchToMicrotaskMs: stats(entries.map(value => value.afterDispatchMicrotaskMs == null ? null : value.afterDispatchMicrotaskMs - value.routeDispatchReturnMs)),
    dispatchToZeroTimerMs: stats(entries.map(value => value.zeroDelayTimerMs == null ? null : value.zeroDelayTimerMs - value.routeDispatchReturnMs)),
    firstActiveInputDomMs: stats(entries.map(value => value.firstDifferentInputDomMs)),
    firstDomMutationMs: stats(entries.map(value => value.firstDomMutationMs)),
    modelControllerObservedMs: stats(entries.map(value => value.actualModelControllerObservedMs)),
    committedReceiptMs: stats(entries.map(value => value.committedReceiptMs)),
    inspectionCalls: entries.map(value => value.calls.inputInspection?.count ?? 0),
    cumulativeInspectionMs: stats(entries.map(value => value.calls.inputInspection?.totalMs ?? 0)),
    canonicalValidationMs: stats(entries.map(value => value.calls.canonicalBindingValidation?.totalMs ?? 0)),
    connectionCheckMs: stats(entries.map(value => (value.calls.nativeConnectionCheck?.totalMs ?? 0) + (value.calls.ownerConnectionCheck?.totalMs ?? 0))),
    settlingWaitActualMs: stats(entries.map(value => value.postSettleInspectionStartMs == null ? null : value.postSettleInspectionStartMs - value.observedReadyMs)),
    postSettleInspectionMs: stats(entries.map(value => value.postSettleBindingConfirmedMs == null ? null : value.postSettleBindingConfirmedMs - value.postSettleInspectionStartMs)) });
}
const summary = { runId: report.runId, coordinatorRunId: spec.coordinatorRunId, targetId: report.targetId, status: report.status, groups,
  nativeErrors: report.nativeErrors?.length ?? 0, finalOwnedRoots: report.result?.finalOwnedRoots,
  limitations: ['Four rounds per mode, empty synthetic histories, Chromium hidden',
    'DOM-only mode confirms ownership only after an explicit 250ms settling wait; its model timestamp is not earliest readiness',
    'No foreground hard latency floor or pure causal Adapter cost inferred'] };
fs.writeFileSync(path.join(directory, outputName), JSON.stringify(summary, null, 2) + '\n', { flag: 'wx' });
process.stdout.write(JSON.stringify(summary) + '\n');
