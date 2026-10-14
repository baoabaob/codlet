import fs from 'node:fs/promises';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { createHash } from 'node:crypto';
import { buildPlugin } from '../../../frontend/build-plugin.mjs';

const repo = fileURLToPath(new URL('../../../', import.meta.url)), directory = path.resolve(process.argv[2] ?? '');
const evidence = JSON.parse(await fs.readFile(path.join(directory, 'owned-runtime-evidence.json'), 'utf8'));
if (directory !== path.join(repo, '.artifacts/adapter-native', evidence.runId) || evidence.phase !== 'ready' || !evidence.authenticated ||
    !evidence.sandboxReady || evidence.activeThreads !== 0 || evidence.archivedThreads !== 0) throw Error('Verified owned empty Native run required');
const label = process.argv[3] ?? 'discovery-probe';
if (!/^discovery-[a-z0-9-]{1,48}$/.test(label)) throw Error('Invalid discovery fixture label');
const output = path.join(directory, label);
await fs.mkdir(output); // A previous uncertain probe is never overwritten/replayed.
const bundle = await buildPlugin(path.join(repo, 'frontend'), '../tests/fixtures/workspace-acceptance/native-discovery-source.js');
const expression = `(async()=>{const module={exports:{}};${bundle.code}\nreturn await module.exports.inspect();})()`;
await fs.writeFile(path.join(output, 'probe.js'), expression, { flag: 'wx' });
await fs.copyFile(new URL('./native-owned-probe-host.cjs', import.meta.url), path.join(output, 'host.cjs'));
await fs.writeFile(path.join(output, 'owned-run.json'), JSON.stringify({ runId: evidence.runId, directory,
  coordinatorRunId: evidence.coordinatorRunId, targetId: evidence.targetId, registryScope: evidence.registryScope,
  sourceSha256: createHash('sha256').update(bundle.code).digest('hex') }, null, 2) + '\n', { flag: 'wx' });
await fs.writeFile(path.join(output, 'codlet.json'), JSON.stringify({ schema: 1, id: label === 'discovery-probe' ? 'dev.adapter.native-discovery' : 'dev.adapter.native-' + label,
  name: 'Owned Native composer discovery', version: '0.0.1', host: { entry: 'host.cjs' }, permissions: ['host.process', 'cdp.raw'] }, null, 2) + '\n', { flag: 'wx' });
process.stdout.write(JSON.stringify({ runId: evidence.runId, probe: output }) + '\n');
