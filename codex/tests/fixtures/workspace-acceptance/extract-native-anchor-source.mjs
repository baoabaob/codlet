// Read only the installed, immutable ASAR entries named by the Native stack.
import fs from 'node:fs';
import path from 'node:path';
import { createHash } from 'node:crypto';
import { fileURLToPath } from 'node:url';
const repo = fileURLToPath(new URL('../../../', import.meta.url)), directory = path.resolve(process.argv[2] ?? '');
const plan = JSON.parse(fs.readFileSync(path.join(directory, 'preflight.json'), 'utf8'));
if (directory !== path.join(repo, '.artifacts/adapter-native', plan.runId)) throw Error('Owned static source destination required');
const archive = 'C:/Program Files/WindowsApps/OpenAI.Codex_26.1007.2314.0_x64__2p2nqsd0c76g0/app/resources/app.asar';
const fd = fs.openSync(archive, 'r'), output = path.join(directory, 'native-anchor-source');
try {
  const prefix = Buffer.alloc(16); if(fs.readSync(fd, prefix, 0, 16, 0)!==16)throw Error('Truncated Native ASAR header');
  const headerSize = prefix.readUInt32LE(4), jsonSize = prefix.readUInt32LE(12);
  if (prefix.readUInt32LE(0) !== 4 || jsonSize > 16 * 1024 * 1024 || jsonSize > headerSize - 8) throw Error('Native ASAR header differs');
  const header = Buffer.alloc(jsonSize); if(fs.readSync(fd, header, 0, jsonSize, 16)!==jsonSize)throw Error('Truncated Native ASAR metadata');
  const headerSha256 = createHash('sha256').update(header).digest('hex');
  if (headerSha256 !== '6b993af172cfc4425644e357856706390067ea457bc76bc11d0d3d5905c3bab5') throw Error('Native archive pin differs');
  const names = ['toggle-thread-summary-panel-20b6a6d27c1c.js', 'thread-app-shell-chrome-1fda1ae81717.js'];
  const manifest = { staticOnly: true, headerSha256, files: [] }; const tree = JSON.parse(header);
  fs.mkdirSync(output);
  for (const name of names) {
    let entry = tree;
    for (const part of ['webview', 'assets', name]) entry = entry.files?.[part];
    const offset = Number(entry?.offset), size = entry?.size;
    if (!entry || entry.unpacked || entry.link || !Number.isSafeInteger(offset) || offset<0 || !Number.isSafeInteger(size) || size<0 || size > 4 * 1024 * 1024 ||
        8 + headerSize + offset + size > fs.fstatSync(fd).size) throw Error('Unsupported Native source entry');
    const bytes = Buffer.alloc(size); if (fs.readSync(fd, bytes, 0, size, 8 + headerSize + offset) !== size) throw Error('Truncated Native source');
    fs.writeFileSync(path.join(output, name), bytes, { flag: 'wx' });
    manifest.files.push({ name, bytes: size, sha256: createHash('sha256').update(bytes).digest('hex') });
  }
  fs.writeFileSync(path.join(output, 'manifest.json'), JSON.stringify(manifest, null, 2) + '\n', { flag: 'wx' });
  process.stdout.write(JSON.stringify(manifest) + '\n');
} finally { fs.closeSync(fd); }
