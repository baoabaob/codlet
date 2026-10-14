// Read-only analysis of an already captured Native acceptance profile. Does
// not connect to or operate the Native client; outputs phases, never text/IDs.
import fs from 'node:fs';
import path from 'node:path';
import { randomUUID, createHash } from 'node:crypto';
import { fileURLToPath } from 'node:url';

if (process.argv.length !== 3 || !path.isAbsolute(process.argv[2])) throw Error('Usage: node analyze-native-selection-profile.mjs <absolute-acceptance-summary.json>');
const sourceFile = process.argv[2], bytes = fs.readFileSync(sourceFile), summary = JSON.parse(bytes.toString('utf8'));
const profile = summary.profile?.profile;
if (!profile || profile.droppedEvents !== 0 || !Array.isArray(profile.events)) throw Error('Complete selection profile required');
const operations = new Map();
for (const event of profile.events) {
  if (!['selection', 'input.navigate'].includes(event.operation)) continue;
  if (!Number.isSafeInteger(event.operationId) || !Number.isFinite(event.timestamp)) throw Error('Invalid profile operation');
  const key = event.operation + ':' + event.operationId;
  let entry = operations.get(key);
  if (!entry) { entry = { operation: event.operation, operationId: event.operationId, threadAlias: event.threadAlias, phases: new Map() }; operations.set(key, entry); }
  if (entry.phases.has(event.phase)) throw Error('Duplicate operation phase');
  entry.phases.set(event.phase, event.timestamp);
}
const inputs = [...operations.values()].filter(value => value.operation === 'input.navigate');
const rows = [], skipped = [];
for (const selection of [...operations.values()].filter(value => value.operation === 'selection')) {
  const at = name => selection.phases.get(name);
  if (!['start', 'bindingConfirmed', 'focused', 'inputReady'].every(name => Number.isFinite(at(name)))) { skipped.push(selection.operationId); continue; }
  const matches = inputs.filter(input => input.threadAlias === selection.threadAlias && input.phases.get('start') >= at('start') && input.phases.get('navigationCommitted') <= at('bindingConfirmed'));
  if (matches.length !== 1) { skipped.push(selection.operationId); continue; }
  const input = matches[0], inputAt = name => input.phases.get(name);
  if (!['start', 'navigationExecuted', 'navigationCommitted'].every(name => Number.isFinite(inputAt(name)))) { skipped.push(selection.operationId); continue; }
  const values = [at('start'), inputAt('start'), inputAt('navigationExecuted'), inputAt('navigationCommitted'), at('bindingConfirmed'), at('focused'), at('inputReady')];
  if (values.some((value, index) => index && value < values[index - 1])) throw Error('Profile phases are not ordered');
  rows.push({ operationId: selection.operationId,
    beforeInputTokenMs: values[1] - values[0], executedAfterInputTokenMs: values[2] - values[1], executedToCommittedMs: values[3] - values[2],
    committedToConsumerBindingMs: values[4] - values[3], focusMs: values[5] - values[4], afterFocusMs: values[6] - values[5], totalMs: values[6] - values[0] });
}
const stats = values => {
  const sorted = [...values].sort((a, b) => a - b), at = p => sorted[Math.min(sorted.length - 1, Math.ceil(sorted.length * p) - 1)];
  return { n: values.length, min: sorted[0], median: at(.5), p95: at(.95), max: sorted.at(-1) };
};
const columns = ['beforeInputTokenMs', 'executedAfterInputTokenMs', 'executedToCommittedMs', 'committedToConsumerBindingMs', 'focusMs', 'afterFocusMs', 'totalMs'];
const report = { schema: 1, createdAt: new Date().toISOString(), sampleId: summary.sampleId, sourceFile, sourceSha256: createHash('sha256').update(bytes).digest('hex'),
  scope: 'Existing Native consumer profile; all complete matched selections, not an isolated five-100 window',
  nativeClientStarted: false, sentTurns: 0, droppedEvents: profile.droppedEvents, inputOperations: inputs.length, matchedSelections: rows.length, skippedSelectionOperations: skipped,
  // Input token starts AFTER navigation.open returns in the captured consumer.
  beforeInputTokenMeaning: 'Consumer prechecks plus synchronous navigation.open, including Adapter validation and Native dispatch',
  stats: Object.fromEntries(columns.map(name => [name, stats(rows.map(row => row[name]))])), rows };
const repo = fileURLToPath(new URL('../../../', import.meta.url)), directory = path.join(repo, '.artifacts/workspace-navigation-waits', 'profile-' + randomUUID());
fs.mkdirSync(directory, { recursive: true });
const output = path.join(directory, 'report.json'); fs.writeFileSync(output, JSON.stringify(report, null, 2) + '\n', { flag: 'wx' });
console.log(JSON.stringify({ output, matchedSelections: report.matchedSelections, skipped: skipped.length, stats: report.stats }));
