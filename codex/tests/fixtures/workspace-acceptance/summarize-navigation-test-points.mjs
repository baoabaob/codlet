// Offline reader for private bounded Adapter test points. No client access.
import fs from 'node:fs';
import path from 'node:path';
import { randomUUID, createHash } from 'node:crypto';
import { fileURLToPath, pathToFileURL } from 'node:url';

export function summarizeNavigationTestPoints(report) {
  if (!report || report.layer !== 'adapter' || !Number.isSafeInteger(report.capacity) || report.capacity < 1 || report.capacity > 4096 ||
      !Number.isSafeInteger(report.written) || report.written < 0 || !Array.isArray(report.samples) || report.samples.length !== Math.min(report.written, report.capacity))
    throw Error('A bounded Adapter test-point report is required');
  const grouped = new Map(); let previous = -Infinity;
  for (const sample of report.samples) {
    if (!Number.isFinite(sample.timestamp) || sample.timestamp < previous || typeof sample.phase !== 'string' ||
        (sample.duration != null && (!Number.isFinite(sample.duration) || sample.duration < 0))) throw Error('Invalid or unordered test point');
    previous = sample.timestamp;
    if (!Number.isSafeInteger(sample.operationId) || sample.operationId < 0 ||
        !sample.phase.startsWith('navigation.') && sample.phase !== 'surface.geometry.complete') continue;
    let events = grouped.get(sample.operationId);
    if (!events) { events = []; grouped.set(sample.operationId, events); }
    events.push(sample);
  }
  const operations = [];
  for (const [operationId, events] of grouped) {
    const find = phase => events.find(sample => sample.phase === phase);
    const sum = phase => {
      const measured = events.filter(sample => sample.phase === phase && sample.duration != null);
      return measured.length ? measured.reduce((total, sample) => total + sample.duration, 0) : null;
    };
    const call = find('navigation.call'), executed = find('navigation.executed'), confirmed = find('navigation.input.confirmed');
    const committed = find('navigation.committed'), wait = find('navigation.confirmation.wait');
    const checks = events.filter(sample => sample.phase === 'navigation.input.inspect' && sample.duration != null &&
      executed && confirmed && sample.timestamp >= executed.timestamp && sample.timestamp <= confirmed.timestamp);
    const checkMs = checks.reduce((total, sample) => total + sample.duration, 0);
    const complete = !!(call && executed && confirmed && committed && wait && wait.duration != null && committed.duration != null);
    const gap = complete ? wait.duration - checkMs : null;
    // Only inspect spans are subtracted. bind/read/pulse overlap them and must
    // not be added again; unallocated time is not labelled Native or CPU time.
    operations.push({ operationId, complete,
      state: committed ? 'committed' : find('navigation.preflight.failed') ? 'preflight-rejected' : find('navigation.finished') ? 'finished' : 'partial',
      preflightMs: find('navigation.preflight')?.duration ?? null, metadataRequestsObserved: events.filter(sample => sample.phase === 'navigation.metadata.begin').length,
      metadataMs: sum('navigation.metadata'), dispatchesObserved: events.filter(sample => sample.phase === 'navigation.dispatch.begin').length, dispatchMs: sum('navigation.dispatch'),
      confirmationWaitMs: complete ? wait.duration : null, confirmationCheckCount: complete ? checks.length : null,
      confirmationCheckMs: complete ? checkMs : null, unallocatedConfirmationMs: gap != null && gap >= 0 ? gap : null,
      timingConsistent: gap == null ? null : gap >= 0,
      surfaceMs: sum('navigation.surface'), surfaceScanMs: sum('navigation.surface.scan'), surfaceControlMs: sum('navigation.surface.control'),
      surfaceGeometryMs: sum('surface.geometry.complete'), surfacePublishMs: sum('navigation.surface.publish'),
      focusAttempts: events.filter(sample => sample.phase === 'navigation.focus').length, focusAttemptMs: sum('navigation.focus'),
      publicCallToCommittedMs: committed?.duration ?? null });
  }
  return { schema: 1, layer: 'adapter', capacity: report.capacity, written: report.written, retained: report.samples.length,
    omittedEarlierPoints: report.written - report.samples.length, fullWindowRetained: report.written === report.samples.length,
    interpretation: 'Inspection spans include Native getters and Adapter checks; unallocated time may include Native work, queues, workspace reads and instrumentation. Nested spans are not additive. Focus points count attempts only.',
    operations };
}

async function main() {
  if (process.argv.length !== 3 || !path.isAbsolute(process.argv[2])) throw Error('Usage: node summarize-navigation-test-points.mjs <absolute-test-point-report.json>');
  const filename = process.argv[2], bytes = fs.readFileSync(filename), data = JSON.parse(bytes.toString('utf8'));
  const reports = data.layer === 'adapter' ? [data] : Array.isArray(data.cases) ? data.cases.map(value => value.testPoints) : [];
  if (!reports.length) throw Error('No private Adapter test-point reports found');
  const result = { schema: 1, sourceFile: filename, sourceSha256: createHash('sha256').update(bytes).digest('hex'), nativeClientStarted: false,
    sentTurns: 0, reports: reports.map(summarizeNavigationTestPoints) };
  const repo = fileURLToPath(new URL('../../../', import.meta.url)), directory = path.join(repo, '.artifacts/workspace-navigation-waits', 'phases-' + randomUUID());
  fs.mkdirSync(directory, { recursive: true });
  const output = path.join(directory, 'report.json'); fs.writeFileSync(output, JSON.stringify(result, null, 2) + '\n', { flag: 'wx' });
  console.log(JSON.stringify({ output, nativeClientStarted: false, reports: result.reports.map(value => ({ written: value.written, fullWindowRetained: value.fullWindowRetained, operations: value.operations })) }));
}

if (process.argv[1] && import.meta.url === pathToFileURL(path.resolve(process.argv[1])).href) await main();
