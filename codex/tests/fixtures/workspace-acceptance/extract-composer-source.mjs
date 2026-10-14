// Static ASAR extraction. Never import/evaluate a Native module or touch a
// running client. The bounded header/offset format is shared with Core's
// scripts/extract-isolation-source.mjs; select only composer-related assets.
import fs from 'node:fs';
import path from 'node:path';
import { createHash } from 'node:crypto';

const [archive, destination, packageVersion] = process.argv.slice(2);
if (!archive || !destination || !/^\d+(?:\.\d+){3}$/.test(packageVersion ?? ''))
  throw Error('Usage: node extract-composer-source.mjs <app.asar> <new-output-directory> <package-version>');
const fd = fs.openSync(archive, 'r');
try {
  const prefix = Buffer.alloc(16);
  if (fs.readSync(fd, prefix, 0, 16, 0) !== 16) throw Error('Truncated ASAR header');
  const headerSize = prefix.readUInt32LE(4), jsonSize = prefix.readUInt32LE(12);
  if (prefix.readUInt32LE(0) !== 4 || jsonSize > 16 * 1024 * 1024 || jsonSize > headerSize - 8)
    throw Error('Unsupported ASAR header');
  const bytes = Buffer.alloc(jsonSize);
  if (fs.readSync(fd, bytes, 0, jsonSize, 16) !== jsonSize) throw Error('Truncated ASAR metadata');
  const entries = [], roles = ['app-shared', 'app-initial', 'app-primary', 'local-conversation-thread'];
  function walk(files, parent = '') {
    for (const [name, entry] of Object.entries(files ?? {})) {
      const fullName = parent ? parent + '/' + name : name;
      if (entry.files) walk(entry.files, fullName);
      else {
        const role = roles.find(role => new RegExp('^' + role + '-[A-Za-z0-9_-]+\\.js$').test(name));
        if (role) entries.push({ role, name, fullName, entry });
      }
    }
  }
  walk(JSON.parse(bytes).files);
  for (const role of roles) {
    const count = entries.filter(entry => entry.role === role).length;
    if (role === 'local-conversation-thread' ? count < 1 || count > 8 : count !== 1)
      throw Error('Missing or ambiguous asset role: ' + role);
  }
  if (new Set(entries.map(entry => entry.name)).size !== entries.length) throw Error('Duplicate source names');
  const archiveSize = fs.fstatSync(fd).size;
  for (const { entry } of entries) {
    const offset = Number(entry.offset), size = entry.size;
    if (entry.unpacked || entry.link || !Number.isSafeInteger(size) || size < 0 || size > 64 * 1024 * 1024 ||
        !Number.isSafeInteger(offset) || offset < 0 || 8 + headerSize + offset + size > archiveSize)
      throw Error('Unsupported source entry');
  }
  fs.mkdirSync(destination); // A fresh directory is required; no overwrites.
  const manifest = { schema: 1, packageVersion, staticOnly: true,
    headerSha256: createHash('sha256').update(bytes).digest('hex'), files: [] };
  for (const { role, name, fullName, entry } of entries) {
    const data = Buffer.alloc(entry.size);
    if (fs.readSync(fd, data, 0, entry.size, 8 + headerSize + Number(entry.offset)) !== entry.size)
      throw Error('Truncated source entry');
    fs.writeFileSync(path.join(destination, name), data, { flag: 'wx' });
    manifest.files.push({ role, name, archiveEntry: fullName, bytes: entry.size,
      sha256: createHash('sha256').update(data).digest('hex') });
  }
  fs.writeFileSync(path.join(destination, 'manifest.json'), JSON.stringify(manifest, null, 2) + '\n', { flag: 'wx' });
  process.stdout.write(JSON.stringify(manifest) + '\n');
} finally { fs.closeSync(fd); }
