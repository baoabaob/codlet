// Maintainer tool: capture only hashes from verified, previously distributed
// portable artifacts. Never copy old executable/plugin payloads into the repo.
import fs from 'node:fs';
import path from 'node:path';
import crypto from 'node:crypto';
const [output, ...directories] = process.argv.slice(2);
if (!output || !directories.length) throw Error('Usage: node scripts/record-legacy-seeds.mjs OUTPUT.json PRIOR_DISTRIBUTION...');
const hash = data => crypto.createHash('sha256').update(data).digest('hex');
const records = new Map();
for (const directory of directories) {
  const manifestBytes = fs.readFileSync(path.join(directory, 'distribution-manifest.json'));
  const manifest = JSON.parse(manifestBytes.toString('utf8').replace(/^\uFEFF/, ''));
  if (manifest.kind !== 'codlet-portable-distribution' || !/^[a-f0-9]{40}$/.test(manifest.sourceCommit)) throw Error('Invalid historical distribution provenance');
  const catalogBytes = fs.readFileSync(path.join(directory, 'optional-plugins/catalog.json'));
  const catalogFile = manifest.files.find(f => f.path === 'optional-plugins/catalog.json');
  if (!catalogFile || hash(catalogBytes) !== catalogFile.sha256 || catalogBytes.length !== catalogFile.bytes) throw Error('Historical catalog does not match distribution manifest');
  const catalog = JSON.parse(catalogBytes.toString('utf8').replace(/^\uFEFF/, ''));
  if (catalog.schema !== 1 || catalog.kind !== 'codlet-official-plugin-bundle') throw Error('Invalid historical catalog');
  for (const pkg of catalog.packages) {
    for (const file of pkg.files) {
      if (!/^[a-zA-Z0-9._/-]+$/.test(file.path) || file.path.split('/').includes('..')) throw Error('Invalid historical payload path');
      const relative = `optional-plugins/packages/${pkg.id}/${file.path}`;
      const data = fs.readFileSync(path.join(directory, relative));
      const entry = manifest.files.find(f => f.path === relative);
      if (hash(data) !== file.sha256 || data.length !== file.bytes || !entry || entry.sha256 !== file.sha256 || entry.bytes !== file.bytes) throw Error(`Historical payload mismatch: ${relative}`);
    }
    const record = { sourceRevision: manifest.sourceCommit, distributionVersion: manifest.version, distributionManifestSha256: hash(manifestBytes), catalogSha256: hash(catalogBytes), id: pkg.id, version: pkg.version, permissions: pkg.permissions, files: pkg.files };
    records.set(hash(JSON.stringify({ id: pkg.id, files: pkg.files })), record);
  }
}
fs.writeFileSync(output, `${JSON.stringify([...records.values()], null, 2)}\n`);
console.log(`Recorded ${records.size} verified historical package hash sets; no payloads copied.`);
