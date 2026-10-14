import fs from 'node:fs/promises';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { createHash } from 'node:crypto';
import { buildPlugin } from '../../../frontend/build-plugin.mjs';

const repo = fileURLToPath(new URL('../../../', import.meta.url)), directory = path.resolve(process.argv[2] ?? '');
const evidence = JSON.parse(await fs.readFile(path.join(directory, 'owned-runtime-evidence.json'), 'utf8'));
const synthetic = JSON.parse(await fs.readFile(path.join(directory, 'synthetic-threads.json'), 'utf8'));
if (directory !== path.join(repo, '.artifacts/adapter-native', evidence.runId) || evidence.phase !== 'ready' || !evidence.authenticated ||
    !evidence.sandboxReady || evidence.syntheticThreadsVerified !== 8 || synthetic.runId !== evidence.runId || synthetic.state !== 'ready' || synthetic.sentTurns !== 0)
  throw Error('Verified owned synthetic Native run required');
const label = process.argv[3] ?? 'navigation-probe';
if (!/^navigation-[a-z0-9-]{1,48}$/.test(label)) throw Error('Invalid navigation fixture label');
if (process.argv[4] && !['--inspect-only', '--shell-only', '--performance-only', '--body-only', '--navigation-bench-only', '--attachment-only', '--contract-only'].includes(process.argv[4])) throw Error('Unknown Native probe mode');
const output = path.join(directory, label); await fs.mkdir(output);
const bundle = await buildPlugin(path.join(repo, 'frontend'), '../tests/fixtures/workspace-acceptance/native-navigation-source.js');
const controlKey = 'codlet.adapter.native.probe.' + evidence.runId + '.' + label;
const args = { runId: evidence.runId, controlKey, inspectOnly: process.argv[4] === '--inspect-only', bodyOnly: process.argv[4] === '--body-only',
  shellOnly: process.argv[4] === '--shell-only',
  contractOnly: process.argv[4] === '--contract-only',
  navigationBenchOnly: process.argv[4] === '--navigation-bench-only', attachmentOnly: process.argv[4] === '--attachment-only',
  performanceOnly: ['--performance-only', '--body-only', '--navigation-bench-only', '--contract-only'].includes(process.argv[4]),
  nativeInitialPin: { name: 'app-initial-b8e1c8014bb4.js', sha256: '799331dde54905c4df5e360f23a9621141759e2c0acb230aeab909f9904b646f' },
  threads: synthetic.threads.map(({ id, index }) => ({ id, index })) };
const expression = `(async()=>{const module={exports:{}};${bundle.code}\nreturn await module.exports.run(${JSON.stringify(args)});})()`;
await fs.writeFile(path.join(output, 'probe.js'), expression, { flag: 'wx' });
await fs.copyFile(new URL('./native-owned-probe-host.cjs', import.meta.url), path.join(output, 'host.cjs'));
await fs.writeFile(path.join(output, 'owned-run.json'), JSON.stringify({ runId: evidence.runId, directory,
  coordinatorRunId: evidence.coordinatorRunId, targetId: evidence.targetId, registryScope: evidence.registryScope,
  asyncProbe: true, measureRendererTasks: args.performanceOnly && !args.contractOnly, captureErrors: args.contractOnly, screenshot: args.shellOnly, controlKey,
  sourceSha256: createHash('sha256').update(bundle.code).digest('hex') }, null, 2) + '\n', { flag: 'wx' });
await fs.writeFile(path.join(output, 'codlet.json'), JSON.stringify({ schema: 1, id: 'dev.adapter.native-' + label,
  name: 'Owned Native main input navigation', version: '0.0.1', host: { entry: 'host.cjs' },
  permissions: ['host.process', 'cdp.raw'] }, null, 2) + '\n', { flag: 'wx' });
process.stdout.write(JSON.stringify({ runId: evidence.runId, probe: output }) + '\n');
