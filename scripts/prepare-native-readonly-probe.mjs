import fs from 'node:fs';
import path from 'node:path';
import { createRequire } from 'node:module';
import { fileURLToPath } from 'node:url';
import { digest, readSnapshot } from './lib/native-source-snapshot.mjs';
const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..'), frontend = path.join(root, 'frontend');
const require = createRequire(path.join(frontend, 'package.json')), { build } = require('esbuild');
const [snapshotDirectory, statusPath, output, analysisPath] = process.argv.slice(2);
if (![snapshotDirectory, statusPath, output, analysisPath].every(value => path.isAbsolute(value ?? '')) || fs.existsSync(output)) throw Error('Pass snapshot directory, scoped status JSON, a new absolute probe directory and workspace analysis JSON');
const snapshot = readSnapshot(snapshotDirectory), status = JSON.parse(fs.readFileSync(statusPath, 'utf8').replace(/^\uFEFF/, ''));
if (status.status !== 'running' || status.snapshot.codex.package_full_name !== snapshot.identity.packageFullName) throw Error('The running Native identity does not match the source snapshot');
const analysis = JSON.parse(fs.readFileSync(analysisPath, 'utf8'));
if (analysis.snapshotSha256 !== digest(fs.readFileSync(path.join(snapshotDirectory, 'snapshot.json')))) throw Error('Analysis belongs to another snapshot');
const analyzedFiles = new Set([...analysis.analysis.roots, ...analysis.structures.map(value => value.key.split('#')[0])]);
const files = Object.fromEntries(snapshot.files.filter(file => analyzedFiles.has(file.path) && file.path.startsWith('webview/assets/'))
  .map(file => [path.posix.basename(file.path), file.sha256]));
const result = await build({ absWorkingDir: frontend, entryPoints: [path.join(root, 'codex/tests/fixtures/native-adaptation/readonly-source.js')],
  bundle: true, write: false, metafile: true, minify: true, platform: 'browser', format: 'cjs', target: 'chrome132',
  nodePaths: [path.join(frontend, 'node_modules')] });
const candidate = { sha256: digest(result.outputFiles[0].text),
  files: Object.keys(result.metafile.inputs).filter(file => !file.includes('node_modules/')).map(file => ({
    path: path.relative(root, path.resolve(frontend, file)).replaceAll('\\', '/'), sha256: digest(fs.readFileSync(path.resolve(frontend, file))),
  })) };
const expression = `(async()=>{const module={exports:{}};\n${result.outputFiles[0].text}\nreturn await module.exports.inspect(${JSON.stringify({ identity: snapshot.identity, files })});})()`;
if (Buffer.byteLength(JSON.stringify({ expression, awaitPromise: true, returnByValue: true })) > 900 * 1024) throw Error('Probe exceeds the bounded Host JSONL request budget');
candidate.expressionSha256 = digest(expression);
fs.mkdirSync(output, { recursive: true });
fs.writeFileSync(path.join(output, 'probe.js'), expression, { flag: 'wx' });
fs.copyFileSync(path.join(root, 'codex/tests/fixtures/native-adaptation/readonly-host.cjs'), path.join(output, 'host.cjs'), fs.constants.COPYFILE_EXCL);
fs.writeFileSync(path.join(output, 'probe-spec.json'), JSON.stringify({ targetIds: status.snapshot.renderer.targets.map(value => value.target_id),
  residentCoreVersion: status.snapshot.codlet_version, native: snapshot.identity, candidate }, null, 2) + '\n', { flag: 'wx' });
fs.writeFileSync(path.join(output, 'codlet.json'), JSON.stringify({ schema: 1, id: 'dev.native-adaptation-readonly',
  name: 'Native adaptation read-only probe', version: '0.0.1', host: { entry: 'host.cjs', mode: 'node' },
  permissions: ['host.raw', 'cdp.raw'] }, null, 2) + '\n', { flag: 'wx' });
console.log(JSON.stringify({ output, candidateSha256: candidate.sha256, native: snapshot.identity }));
