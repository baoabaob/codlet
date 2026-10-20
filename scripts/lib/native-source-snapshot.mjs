// Static package inspection. No Native source is imported or evaluated.
import fs from 'node:fs';
import path from 'node:path';
import { createHash } from 'node:crypto';

export const digest = value => createHash('sha256').update(value).digest('hex');
const MAX_FILE = 64 * 1024 * 1024;
const MAX_TOTAL = 512 * 1024 * 1024;
const sourceEntry = name => name === 'package.json' ||
  /^(?:webview\/assets|\.vite\/build)\/[^/]+\.(?:js|mjs|cjs)$/.test(name) ||
  /^[^/]*(?:build|metadata|version)[^/]*\.json$/i.test(name);

export function relativeSourcePath(name) {
  if (typeof name !== 'string' || !name || name.includes('\\') || name.startsWith('/') ||
      name.split('/').some(part => !part || part === '.' || part === '..' || part.includes(':'))) {
    throw Error(`Invalid source entry: ${name}`);
  }
  return name;
}

export function openSourceArchive(filename) {
  const stat = fs.lstatSync(filename);
  if (!stat.isFile() || stat.isSymbolicLink()) throw Error('A regular ASAR file is required');
  const fd = fs.openSync(filename, 'r');
  try {
    const prefix = Buffer.alloc(16);
    if (fs.readSync(fd, prefix, 0, 16, 0) !== 16) throw Error('Truncated ASAR header');
    const headerSize = prefix.readUInt32LE(4), jsonSize = prefix.readUInt32LE(12);
    if (prefix.readUInt32LE(0) !== 4 || jsonSize > 16 * 1024 * 1024 || jsonSize > headerSize - 8 ||
        8 + headerSize > stat.size) throw Error('Unsupported ASAR header');
    const bytes = Buffer.alloc(jsonSize);
    if (fs.readSync(fd, bytes, 0, jsonSize, 16) !== jsonSize) throw Error('Truncated ASAR metadata');
    const entries = new Map(), visit = (tree, parent = '') => {
      for (const [name, value] of Object.entries(tree.files ?? {})) {
        const entry = relativeSourcePath(parent ? `${parent}/${name}` : name);
        if (value.files) visit(value, entry);
        else entries.set(entry, value);
      }
    };
    visit(JSON.parse(bytes.toString('utf8')));
    return {
      entries, bytes: stat.size, headerSha256: digest(bytes),
      read(name) {
        const entry = entries.get(relativeSourcePath(name));
        const offset = Number(entry?.offset), size = entry?.size;
        if (!entry || entry.link || entry.unpacked || !Number.isSafeInteger(offset) || offset < 0 ||
            !Number.isSafeInteger(size) || size < 0 || size > MAX_FILE ||
            8 + headerSize + offset + size > stat.size) throw Error(`Unsupported source entry: ${name}`);
        const output = Buffer.alloc(size);
        if (fs.readSync(fd, output, 0, size, 8 + headerSize + offset) !== size) throw Error(`Truncated source entry: ${name}`);
        return output;
      },
      close: () => fs.closeSync(fd),
    };
  } catch (error) { fs.closeSync(fd); throw error; }
}

async function fileDigest(filename) {
  const hash = createHash('sha256');
  for await (const bytes of fs.createReadStream(filename)) hash.update(bytes);
  return hash.digest('hex');
}

function freshDirectory(output) {
  if (!path.isAbsolute(output)) throw Error('Use an absolute snapshot output directory');
  if (fs.existsSync(output)) throw Error('Snapshot output must be new');
  fs.mkdirSync(output, { recursive: true });
}

function saveEntry(output, name, bytes) {
  const relative = relativeSourcePath(name);
  const filename = path.join(output, 'sources', relative);
  fs.mkdirSync(path.dirname(filename), { recursive: true });
  fs.writeFileSync(filename, bytes, { flag: 'wx' });
  return { path: relative, bytes: bytes.length, sha256: digest(bytes) };
}

export async function snapshotArchive({ archive, output, packageFullName = null }) {
  if (!path.isAbsolute(archive ?? '')) throw Error('Use an absolute ASAR path');
  const reader = openSourceArchive(archive);
  try {
    const selected = [...reader.entries.keys()].filter(sourceEntry).sort();
    if (!selected.includes('package.json')) throw Error('Native package metadata is missing');
    let total = 0;
    for (const name of selected) {
      const entry = reader.entries.get(name);
      if (entry.link || entry.unpacked || !Number.isSafeInteger(entry.size) || entry.size > MAX_FILE ||
          entry.size < 0 || (total += entry.size) > MAX_TOTAL) throw Error(`Source snapshot exceeds its boundary: ${name}`);
    }
    const metadata = JSON.parse(reader.read('package.json'));
    if (typeof metadata.version !== 'string') throw Error('Native app version is missing');
    const archiveSha256 = await fileDigest(archive);
    freshDirectory(output);
    const files = selected.map(name => saveEntry(output, name, reader.read(name)));
    const manifest = {
      schema: 1, kind: 'native-source-snapshot', capturedAt: new Date().toISOString(),
      identity: { packageFullName, packageVersion: /OpenAI\.Codex_(\d+\.\d+\.\d+\.\d+)_/.exec(packageFullName ?? '')?.[1] ?? null,
        appVersion: metadata.version, buildNumber: metadata.codexBuildNumber ?? metadata.buildNumber ?? null,
        ...((metadata.codexBuildNumber ?? metadata.buildNumber) != null ? { buildNumberSource: 'package.json' } : {}) },
      provenance: { kind: 'installed-asar', archive, archiveBytes: reader.bytes, archiveSha256, headerSha256: reader.headerSha256 },
      coverage: { renderer: true, main: true, partial: false }, files,
    };
    // Build numbers are stored separately in some client distributions. Preserve
    // their original file identities and never infer one from an app version.
    for (const entry of files.filter(item => /(?:build|metadata|version).*\.json$/i.test(item.path))) {
      const data = JSON.parse(reader.read(entry.path));
      const build = data.buildNumber ?? data.build_number;
      if (build !== undefined) {
        if (manifest.identity.buildNumber !== null && String(manifest.identity.buildNumber) !== String(build)) throw Error('Conflicting Native build numbers');
        manifest.identity.buildNumber = String(build);
        manifest.identity.buildNumberSource = entry.path;
      }
    }
    fs.writeFileSync(path.join(output, 'snapshot.json'), JSON.stringify(manifest, null, 2) + '\n', { flag: 'wx' });
    return manifest;
  } finally { reader.close(); }
}

export function snapshotPreserved({ directory, output, identity, evidence }) {
  if (!path.isAbsolute(directory ?? '') || !identity || !evidence) throw Error('Preserved sources need an absolute path, explicit identity and provenance');
  const names = fs.readdirSync(directory).filter(name => /\.(?:m?js|cjs)$/.test(name)).sort();
  if (!names.length) throw Error('No preserved source files found');
  const entries = names.map(name => {
    const filename = path.join(directory, name), stat = fs.lstatSync(filename);
    if (!stat.isFile() || stat.isSymbolicLink() || stat.size > MAX_FILE) throw Error('Preserved source must be a bounded regular file');
    return { name, filename, bytes: stat.size };
  });
  if (entries.reduce((sum, item) => sum + item.bytes, 0) > MAX_TOTAL) throw Error('Preserved source snapshot is too large');
  freshDirectory(output);
  const files = entries.map(item => saveEntry(output, `webview/assets/${item.name}`, fs.readFileSync(item.filename)));
  const manifest = {
    schema: 1, kind: 'native-source-snapshot', capturedAt: new Date().toISOString(), identity,
    provenance: { kind: 'preserved-source', directory, evidence },
    coverage: { renderer: true, main: false, partial: true }, files,
  };
  fs.writeFileSync(path.join(output, 'snapshot.json'), JSON.stringify(manifest, null, 2) + '\n', { flag: 'wx' });
  return manifest;
}

export function readSnapshot(directory) {
  const manifest = JSON.parse(fs.readFileSync(path.join(directory, 'snapshot.json'), 'utf8'));
  if (manifest.schema !== 1 || manifest.kind !== 'native-source-snapshot' || !Array.isArray(manifest.files)) throw Error('Unsupported source snapshot');
  const seen = new Set();
  for (const file of manifest.files) {
    const name = relativeSourcePath(file.path);
    if (seen.has(name)) throw Error(`Duplicate source entry: ${name}`);
    seen.add(name);
    const filename = path.join(directory, 'sources', name), stat = fs.lstatSync(filename);
    if (!stat.isFile() || stat.isSymbolicLink() || stat.size !== file.bytes || stat.size > MAX_FILE ||
        digest(fs.readFileSync(filename)) !== file.sha256) throw Error(`Source snapshot changed: ${name}`);
  }
  return manifest;
}
