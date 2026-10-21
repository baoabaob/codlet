import fs from 'node:fs';
import path from 'node:path';
import {createHash} from 'node:crypto';
import {fileURLToPath} from 'node:url';

const sha = bytes => createHash('sha256').update(bytes).digest('hex');
function plain(file, directory = false) {
  const full = path.resolve(file);
  for (let current = full; ; current = path.dirname(current)) {
    if (fs.lstatSync(current).isSymbolicLink()) throw Error(`Linked online input: ${current}`);
    if (path.dirname(current) === current) break;
  }
  const info = fs.statSync(full);
  if (directory ? !info.isDirectory() : !info.isFile() || info.nlink !== 1 || info.size > 512 * 1024 * 1024) throw Error(`Invalid online input: ${full}`);
  return full;
}
export function residentFingerprint(files) {
  return sha(files.slice().sort((a,b)=>a.path < b.path ? -1 : a.path > b.path ? 1 : 0).map(file => `${file.path}\0${file.bytes}\0${file.sha256}\n`).join(''));
}
export function inspectOnlineBase(baseDirectory, buildRoot, {includeEvidence = true} = {}) {
  const root = plain(baseDirectory, true), build = plain(buildRoot, true);
  const distribution = JSON.parse(fs.readFileSync(plain(path.join(root,'distribution-manifest.json')),'utf8'));
  if (distribution.schema !== 1 || !['codlet-portable-distribution','codlet-msi-distribution'].includes(distribution.kind) || distribution.platform !== 'win-x64' || !/^[a-f0-9]{40}$/.test(distribution.sourceCommit ?? '')) throw Error('A recorded Windows distribution is required');
  const pin = JSON.parse(fs.readFileSync(plain(path.join(root,'runtime/node-runtime.json')),'utf8'));
  if (pin.schema !== 1 || !['managed','bundled'].includes(pin.mode ?? 'bundled') || !/^[0-9]+\.[0-9]+\.[0-9]+$/.test(pin.version)) throw Error('Unsupported resident Node pin');
  const names = ['codlet.exe','runtime/node-runtime.json'];
  if ((pin.mode ?? 'bundled') === 'bundled') names.push(`runtime/node-v${pin.version}-win-x64/node.exe`,`runtime/node-v${pin.version}-win-x64/LICENSE`);
  const files = names.sort().map(relative => {
    const expected = distribution.files.filter(file => file.path === relative);
    if (expected.length !== 1) throw Error(`Missing or ambiguous resident file: ${relative}`);
    const content = fs.readFileSync(plain(path.join(root,relative)));
    const record = {path:relative,bytes:content.length,sha256:sha(content)};
    if (record.bytes !== expected[0].bytes || record.sha256 !== expected[0].sha256) throw Error(`Resident file differs from distribution: ${relative}`);
    return record;
  });
  const executable = fs.readFileSync(path.join(root,'codlet.exe'));
  const bridges = [['bridge','runtime/client-bridge-bundle.cjs'],['bootstrap','runtime/client-bridge-bootstrap.cjs']].map(([role,relative]) => {
    const bytes = fs.readFileSync(plain(path.join(build,relative)));
    if (!bytes.length || bytes.length > 8 * 1024 * 1024) throw Error('Invalid compiled bridge source');
    return {role,path:relative,sha256:sha(bytes),exactBytesPresent:executable.includes(bytes)};
  });
  const compatible = bridges.every(item => item.exactBytesPresent);
  return {
    schema:1,kind:'codlet-online-base-inspection',baseVersion:distribution.version,baseSourceCommit:distribution.sourceCommit,
    platform:'win-x64',profile:'portable',installerOwned:distribution.kind === 'codlet-msi-distribution',
    residentSha256:residentFingerprint(files),residentFiles:files,
    staticCompatible:compatible,runtimePreflightRequired:true,
    reason:compatible ? null : 'The candidate bridge/bootstrap is absent from the recorded resident executable.',
    ...(includeEvidence ? {bridgeEvidence:bridges} : {})
  };
}
if (process.argv[1] && path.resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  const [base,build,output] = process.argv.slice(2);
  if (!base || !build || !output) throw Error('Usage: node scripts/inspect-online-base.mjs BASE_DIRECTORY BUILD_ROOT FRESH_REPORT.json');
  const report = inspectOnlineBase(base,build);
  fs.writeFileSync(path.resolve(output),JSON.stringify(report,null,2)+'\n',{flag:'wx'});
  console.log(JSON.stringify(report));
}
