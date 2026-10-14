// Offline analysis of an explicit owned probe; never connects to a client.
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const filename = path.resolve(process.argv[2] ?? ''), directory = path.dirname(filename);
const report = JSON.parse(fs.readFileSync(filename, 'utf8'));
const spec = JSON.parse(fs.readFileSync(path.join(directory, 'owned-run.json'), 'utf8'));
const repo = fileURLToPath(new URL('../../../', import.meta.url));
if (filename !== path.join(directory, 'report.json') || !/^adapter-[a-f0-9-]{36}$/.test(report.runId) ||
    path.dirname(directory) !== path.join(repo, '.artifacts/adapter-native', report.runId) ||
    spec.runId !== report.runId || spec.targetId !== report.targetId) throw Error('Explicit owned Native report required');

function stats(values) {
  if (!values.length) return null;
  const ordered = [...values].sort((a, b) => a - b);
  const middle = Math.floor(ordered.length / 2);
  return { n: ordered.length, minMs: ordered[0], medianMs: ordered.length % 2 ? ordered[middle] : (ordered[middle - 1] + ordered[middle]) / 2,
    p95Ms: ordered[Math.ceil(ordered.length * .95) - 1], maxMs: ordered.at(-1) };
}
const result = report.result ?? {}, phases = result.phases ?? [];
const paired = phases.find(phase => phase.name === 'paired-warm-navigation');
const samples = paired?.result?.samples ?? result.partialPairedSamples ?? [];
const idle = [];
for (const name of [...new Set((report.rendererTaskSamples ?? []).map(sample => sample.phase))]) {
  if (!/^transcript-idle-\d+$|^transcript-retired-idle$/.test(name)) continue;
  const records = report.rendererTaskSamples.filter(sample => sample.phase === name), first = records[0]?.metrics, last = records.at(-1)?.metrics;
  if (records.length < 2 || !(last.Timestamp > first.Timestamp)) continue;
  const seconds = last.Timestamp - first.Timestamp;
  idle.push({ phase: name, samples: records.length, observedSeconds: seconds,
    taskBusyMsPerSecond: (last.TaskDuration - first.TaskDuration) * 1000 / seconds,
    scriptMsPerSecond: (last.ScriptDuration - first.ScriptDuration) * 1000 / seconds,
    layoutMsPerSecond: (last.LayoutDuration - first.LayoutDuration) * 1000 / seconds,
    styleMsPerSecond: (last.RecalcStyleDuration - first.RecalcStyleDuration) * 1000 / seconds,
    heapBytesFirst: first.JSHeapUsedSize, heapBytesLast: last.JSHeapUsedSize });
}
const summary = { schema: 1, runId: report.runId, targetId: report.targetId, coordinatorRunId: spec.coordinatorRunId,
  sourceSha256: spec.sourceSha256, status: report.status, startedAt: report.startedAt, completedAt: report.completedAt,
  sentTurns: result.sentTurns, additionalEditors: result.additionalEditors, nativePaintMeasured: result.nativePaintMeasured,
  failure: result.error ?? report.error ?? null,
  navigation: { pairedStatus: paired?.status ?? null, native: stats(samples.filter(sample => sample.mode === 'native').map(sample => sample.ms)),
    adapter: stats(samples.filter(sample => sample.mode === 'adapter').map(sample => sample.ms)),
    inspection: stats(phases.find(phase => phase.name === 'binding-inspection-cost')?.result?.samples ?? []) },
  bodies: phases.filter(phase => /^native-transcripts-\d+$/.test(phase.name)).map(phase => ({ status: phase.status, ...phase.result })),
  adapterCounts: result.metrics?.counts ?? {}, idle,
  limitations: ['Empty synthetic histories only; no streamed or long-history workload',
    'Renderer task busy time is not OS process CPU and includes Native plus probe traffic',
    'Short idle windows and heap snapshots do not establish steady-state cost per instance',
    'Chromium document was hidden; no foreground presentation or physical IME claim'] };
fs.writeFileSync(path.join(directory, 'summary.json'), JSON.stringify(summary, null, 2) + '\n', { flag: 'wx' });
process.stdout.write(JSON.stringify(summary) + '\n');
