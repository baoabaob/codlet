// Export the exact binary's schemas only. Never launch app-server or a profile.
import fs from 'node:fs';
import path from 'node:path';
import { execFileSync } from 'node:child_process';
import { randomUUID, createHash } from 'node:crypto';
import { fileURLToPath, pathToFileURL } from 'node:url';
import { sha256 } from './synthetic-history.mjs';

export function hasDeclaredField(source, field) {
  const declarations = source.replace(/\/\*[\s\S]*?\*\/|\/\/[^\n]*/g, '');
  return new RegExp('\\b' + field + '\\??\\s*:').test(declarations);
}

async function main() {
  const binary = process.argv[2];
  if (!binary || !path.isAbsolute(binary) || process.argv.length !== 3) throw Error('Usage: node inspect-history-protocol.mjs <absolute-codex-executable>');
  const repo = fileURLToPath(new URL('../../../', import.meta.url));
  const directory = path.join(repo, '.artifacts/workspace-history', 'protocol-' + randomUUID());
  fs.mkdirSync(directory, { recursive: true });
  const execute = args => execFileSync(binary, args, { encoding: 'utf8', windowsHide: true, timeout: 30000, maxBuffer: 1024 * 1024 });
  const version = execute(['--version']).trim();
  execute(['app-server', 'generate-ts', '--out', path.join(directory, 'public')]);
  execute(['app-server', 'generate-ts', '--experimental', '--out', path.join(directory, 'experimental')]);
  const read = relative => fs.readFileSync(path.join(directory, relative), 'utf8');
  const client = read('public/ClientRequest.ts'), publicResume = read('public/v2/ThreadResumeParams.ts');
  const experimentalResume = read('experimental/v2/ThreadResumeParams.ts'), inject = read('public/v2/ThreadInjectItemsParams.ts');
  const methods = [...client.matchAll(/"method":\s*"([^"]+)"/g)].map(match => match[1]);
  const files = ['public/ClientRequest.ts', 'public/v2/ThreadResumeParams.ts', 'experimental/v2/ThreadResumeParams.ts', 'public/v2/ThreadInjectItemsParams.ts', 'public/ResponseItem.ts', 'public/v2/ThreadItem.ts'];
  const report = { schema: 1, createdAt: new Date().toISOString(), version, binary, binarySha256: createHash('sha256').update(fs.readFileSync(binary)).digest('hex'),
    schemaSha256: Object.fromEntries(files.map(file => [file, sha256(read(file))])),
    threadMethods: methods.filter(method => method.startsWith('thread/')),
    publicInjectItems: methods.includes('thread/inject_items'), publicDelete: methods.includes('thread/delete'),
    injectionScope: /model-visible history/.test(inject) ? 'model-visible history' : 'unrecognized',
    publicResumeHistory: hasDeclaredField(publicResume, 'history'), publicResumePath: hasDeclaredField(publicResume, 'path'),
    experimentalResumeHistory: hasDeclaredField(experimentalResume, 'history'), experimentalHistoryCloudOnly: /FOR CODEX CLOUD - DO NOT USE/.test(experimentalResume),
    declaredReplayMethods: methods.filter(method => /replay|fixture|inject.*(event|turn)|append.*(event|turn)/i.test(method)),
    nativeClientTested: false, backendLaunched: false, sentTurns: 0,
    nativeVisibleHistory: 'not verified by schema export; inject_items requires a separate read-back gate', nativeStreamingReplay: 'no declared client request identified' };
  fs.writeFileSync(path.join(directory, 'report.json'), JSON.stringify(report, null, 2) + '\n', { flag: 'wx' });
  console.log(JSON.stringify({ directory, report: path.join(directory, 'report.json'), version, publicInjectItems: report.publicInjectItems,
    injectionScope: report.injectionScope, publicResumeHistory: report.publicResumeHistory, experimentalHistoryCloudOnly: report.experimentalHistoryCloudOnly,
    declaredReplayMethods: report.declaredReplayMethods, backendLaunched: false }));
}

if (process.argv[1] && import.meta.url === pathToFileURL(path.resolve(process.argv[1])).href) await main();
