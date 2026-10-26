import fs from 'node:fs/promises';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { createHash } from 'node:crypto';
import { buildPlugin } from '../../../frontend/build-plugin.mjs';

const repo = fileURLToPath(new URL('../../../', import.meta.url)), directory = path.resolve(process.argv[2] ?? '');
const evidence = JSON.parse(await fs.readFile(path.join(directory, 'owned-runtime-evidence.json'), 'utf8'));
const ledger = JSON.parse(await fs.readFile(path.join(directory, 'synthetic-threads.json'), 'utf8'));
const label = process.argv[3], mode = process.argv[4];
const variant = process.argv[5] ?? 'exact';
if (directory !== path.join(repo, '.artifacts/adapter-native', evidence.runId) || evidence.phase !== 'ready' || !evidence.authenticated ||
    !evidence.sandboxReady || evidence.syntheticThreadsVerified !== 8 || ledger.state !== 'ready' || ledger.sentTurns !== 0 ||
    !/^investigation-[a-z0-9-]{1,48}$/.test(label ?? '') || !['replay', 'timeline'].includes(mode) ||
    !['exact', 'no-ime', 'no-rapid', 'canonical-local'].includes(variant) || mode === 'timeline' && variant !== 'exact') throw Error('Explicit verified owned investigation required');
const output = path.join(directory, label); await fs.mkdir(output);
let expression, controlKey;
if (mode === 'replay') {
  // The historical package is preserved; only Target/coordinator ownership in
  // the new Host descriptor changes. This is not a regenerated approximation.
  const previous = path.join(directory, 'navigation-perf-20261011-1');
  expression = await fs.readFile(path.join(previous, 'probe.js'), 'utf8');
  const oldSpec = JSON.parse(await fs.readFile(path.join(previous, 'owned-run.json'), 'utf8'));
  const prefix = '(async()=>{const module={exports:{}};', end = expression.lastIndexOf('\nreturn await module.exports.run(');
  if (!expression.startsWith(prefix) || end < prefix.length || createHash('sha256').update(expression.slice(prefix.length, end)).digest('hex') !== oldSpec.sourceSha256)
    throw Error('Historical probe bundle hash differs');
  controlKey = 'codlet.adapter.native.probe.' + evidence.runId + '.navigation-perf-20261011-1';
  if (!expression.includes(JSON.stringify(controlKey)) || !expression.includes('"performanceOnly":true')) throw Error('Historical reproduction source differs');
  if (variant === 'canonical-local') {
    // Preserve the frozen failed sequence and replace its two reviewed dispatch
    // sites only. No monkeypatching of the Native router or official components.
    const replacements = [
      ['navigator.push("/local/" + id)', 'ownedCanonical.open(id)'],
      ['router.push("/local/" + fixture.id)', 'ownedCanonical.open(fixture.id)'],
    ];
    for (const [before, after] of replacements) {
      if (expression.split(before).length !== 2) throw Error('Frozen dispatch site differs');
      expression = expression.replace(before, after);
    }
    const phaseAnchor = 'const phase = async (name, work) => {\n';
    if (expression.split(phaseAnchor).length !== 2) throw Error('Frozen phase wrapper differs');
    expression = expression.replace(phaseAnchor, phaseAnchor + "if(name==='binding-inspection-cost'||name.startsWith('native-transcripts-')||name==='transcript-retired-idle'){report.phases.push({name,status:'skipped',reason:'unchanged matrix excluded from correctness comparison'});return;}\n");
    const helper = await buildPlugin(path.join(repo, 'frontend'), '../tests/fixtures/workspace-acceptance/native-canonical-entry.js');
    const prepare = `(async()=>{const module={exports:{}};${helper.code}\nreturn await module.exports.prepare(${JSON.stringify(ledger.threads.map(value => value.id))});})()`;
    expression = `(async()=>{const ownedCanonical=await ${prepare};try{return await ${expression};}finally{ownedCanonical.dispose();}})()`;
  } else if (variant !== 'exact') {
    const anchor = 'const phase = async (name, work) => {\n', skip = variant === 'no-ime' ? 'composition-preflight' : 'rapid-replacement';
    if (expression.split(anchor).length !== 2) throw Error('Historical phase wrapper differs');
    expression = expression.replace(anchor, anchor + `if(name===${JSON.stringify(skip)}){report.phases.push({name,status:'skipped',reason:'controlled reproduction variant'});return;}\n`);
  }
} else {
  const bundle = await buildPlugin(path.join(repo, 'frontend'), '../tests/fixtures/workspace-acceptance/native-navigation-timeline.js');
  controlKey = 'codlet.adapter.native.probe.' + evidence.runId + '.' + label;
  const args = { runId: evidence.runId, controlKey, threads: ledger.threads.map(({ id, index }) => ({ id, index })) };
  expression = `(async()=>{const module={exports:{}};${bundle.code}\nreturn await module.exports.run(${JSON.stringify(args)});})()`;
}
await fs.writeFile(path.join(output, 'probe.js'), expression, { flag: 'wx' });
await fs.copyFile(new URL('./native-owned-probe-host.cjs', import.meta.url), path.join(output, 'host.cjs'));
await fs.writeFile(path.join(output, 'owned-run.json'), JSON.stringify({ runId: evidence.runId, directory, coordinatorRunId: evidence.coordinatorRunId,
  targetId: evidence.targetId, registryScope: evidence.registryScope, sourceSha256: createHash('sha256').update(expression).digest('hex'),
  expressionSha256: createHash('sha256').update(expression).digest('hex'), asyncProbe: true, captureErrors: true, measureRendererTasks: mode === 'replay', controlKey, mode, variant }, null, 2) + '\n', { flag: 'wx' });
await fs.writeFile(path.join(output, 'codlet.json'), JSON.stringify({ schema: 1, id: 'dev.adapter.native-' + label, name: 'Owned Native navigation investigation',
  version: '0.0.1', host: { entry: 'host.cjs' }, permissions: ['host.process', 'cdp.raw'] }, null, 2) + '\n', { flag: 'wx' });
process.stdout.write(JSON.stringify({ probe: output, mode }) + '\n');
