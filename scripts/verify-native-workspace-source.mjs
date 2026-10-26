// Run Core's source decoders against captured Native bytes. This loads only
// Codlet's own parser/discovery definitions; no Native module is evaluated.
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { createRequire } from 'node:module';
import { digest, relativeSourcePath } from './lib/native-source-snapshot.mjs';
import { resolveModulePath } from './lib/native-source-index.mjs';
const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..'), frontend = path.join(root, 'frontend');
const require = createRequire(path.join(frontend, 'package.json')), { build } = require('esbuild');
const [analysisPath, output] = process.argv.slice(2);
if (!path.isAbsolute(analysisPath ?? '') || !path.isAbsolute(output ?? '') || fs.existsSync(output)) throw Error('Pass the analysis JSON and a new absolute report path');
const analysis = JSON.parse(fs.readFileSync(analysisPath, 'utf8'));
const metadata = fs.readFileSync(path.join(analysis.snapshot, 'snapshot.json'));
if (digest(metadata) !== analysis.snapshotSha256) throw Error('Snapshot metadata changed after analysis');
const files = new Map(JSON.parse(metadata).files.map(file => [file.path, file]));
const bundle = await build({ absWorkingDir: frontend, stdin: {
  contents: 'export * from "../codex/frontend/src/adapter/workspace-source.js";export * from "../codex/frontend/src/adapter/workspace-native-viewport.js";export * from "../codex/frontend/src/adapter/workspace-role-contracts.js";export {parseExpressionAt} from "acorn";',
  resolveDir: frontend, sourcefile: 'native-source-verification.mjs', loader: 'js',
}, bundle: true, write: false, metafile: true, platform: 'node', format: 'esm', target: 'node24', nodePaths: [path.join(frontend, 'node_modules')] });
const api = await import('data:text/javascript;base64,' + Buffer.from(bundle.outputFiles[0].text).toString('base64'));
const sources = new Map(), checks = [];
const readFile = (filename, expectedSha256 = null) => {
  const name = relativeSourcePath(filename), file = files.get(name);
  if (!file || expectedSha256 !== null && file.sha256 !== expectedSha256) throw Error('Native source differs from snapshot metadata');
  if (!sources.has(name)) {
    const bytes = fs.readFileSync(path.join(analysis.snapshot, 'sources', name));
    if (bytes.length !== file.bytes || digest(bytes) !== file.sha256) throw Error('Native source changed after analysis');
    sources.set(name, bytes.toString('utf8'));
  }
  return sources.get(name);
};
const read = candidate => readFile(candidate.file, candidate.sha256);
const check = (id, work) => {
  try { const detail = work(); checks.push({ id, status: 'passed', evidence: 'source', detail }); }
  catch (error) { checks.push({ id, status: 'failed', evidence: 'source', error: String(error.message) }); }
};
const candidate = role => {
  const value = analysis.roles[role];
  if (value?.status !== 'located' || value.candidates.length !== 1) throw Error(`No unique ${role} responsibility`);
  return value.candidates[0];
};
for (const [name, contract] of Object.entries(api.WORKSPACE_FUNCTION_ROLES)) check(name, () => {
  const value = candidate(name), text = read(value).slice(value.start.offset, value.end.offset);
  const properties = contract.inputProperties ? api.workspaceInputProperties(api.parseExpressionAt(text, 0, { ecmaVersion: 'latest' })) : [];
  if (!api.matchesWorkspaceFunction(text, value.interface.parameters.length, contract, properties)) throw Error('Core predicate differs from analyzed source role');
  return { file: value.file, sha256: value.sha256, start: value.start, exports: value.exports, consumedProperties: properties };
});
check('navigationSignal', () => {
  const value = candidate('navigationSignal'), found = api.navigationSourceExport(read(value));
  if (!value.exports.includes(found)) throw Error('Navigation decoder selected another binding');
  return { file: value.file, export: found, sha256: value.sha256 };
});
check('shortcutState', () => {
  const value = candidate('shortcutState'), found = api.keymapSourceExport(read(value));
  if (!value.exports.includes(found)) throw Error('Shortcut decoder selected another binding');
  return { file: value.file, export: found, sha256: value.sha256,
    queryReferences: analysis.roles.shortcutState.flow[0].reads.length,
    consumerCount: analysis.roles.shortcutState.flow[0].consumers.length };
});
check('viewportSignals', () => {
  const value = candidate('viewportSetOpen'), found = api.viewportSignalExports(read(value));
  if (!value.exports.includes(found.setOpen)) throw Error('Viewport decoder selected another action');
  return { file: value.file, sha256: value.sha256, exports: found };
});
check('viewportPersistence', () => {
  const value = candidate('viewportPersistence'), found = api.viewportPersistenceReference(read(value));
  const file = found.source === null ? value.file : resolveModulePath(value.file, found.source);
  if (!file) throw Error('Persistence dependency is not a relative module');
  const text = readFile(file);
  if (!api.workspaceModuleSyntax(text).exports.some(entry => entry.exported === found.imported)) throw Error('Persistence import does not have a matching export');
  return { importer: value.file, file, sha256: digest(text), export: found.imported };
});
for (const role of ['threadScope', 'routeScope', 'composerScope']) check(role, () => {
  candidate(role);
  if (!analysis.roles[role].parentRelation?.matched) throw Error('Scope parent relationship changed');
  return analysis.roles[role].parentRelation;
});
const report = { schema: 1, kind: 'native-workspace-source-contract-verification',
  passed: checks.every(value => value.status === 'passed'), evidence: 'source',
  native: analysis.identity, snapshotSha256: analysis.snapshotSha256,
  core: { verificationBundleSha256: digest(bundle.outputFiles[0].text), files: Object.keys(bundle.metafile.inputs)
    .filter(file => file !== 'native-source-verification.mjs' && !file.includes('node_modules/'))
    .map(file => ({ path: path.relative(root, path.resolve(frontend, file)).replaceAll('\\', '/'),
      sha256: digest(fs.readFileSync(path.resolve(frontend, file))) })) },
  checks, liveInteraction: 'not-verified', nativeModulesExecuted: 0, messagesSent: 0 };
fs.writeFileSync(output, JSON.stringify(report, null, 2) + '\n', { flag: 'wx' });
console.log(JSON.stringify({ passed: report.passed, checks: checks.length, failures: checks.filter(check => check.status === 'failed') }, null, 2));
if (!report.passed) process.exitCode = 1;
