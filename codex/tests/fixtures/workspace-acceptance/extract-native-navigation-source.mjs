// Static analysis of pinned installed Native entries; source is never evaluated.
import fs from 'node:fs';
import path from 'node:path';
import { createHash } from 'node:crypto';
import { fileURLToPath } from 'node:url';
import { parseExpressionAt } from '../../../frontend/node_modules/acorn/dist/acorn.mjs';
import { transformSync } from '../../../frontend/node_modules/esbuild/lib/main.js';

const repo = fileURLToPath(new URL('../../../', import.meta.url)), directory = path.resolve(process.argv[2] ?? '');
const plan = JSON.parse(fs.readFileSync(path.join(directory, 'preflight.json'), 'utf8'));
if (directory !== path.join(repo, '.artifacts/adapter-native', plan.runId)) throw Error('Explicit owned source destination required');
const fd = fs.openSync('C:/Program Files/WindowsApps/OpenAI.Codex_26.1007.2314.0_x64__2p2nqsd0c76g0/app/resources/app.asar', 'r');
const label = process.argv[3] ?? 'native-navigation-source';
if (!/^native-navigation-source(?:-[a-z0-9-]+)?$/.test(label)) throw Error('Fresh owned source label required');
const output = path.join(directory, label);
try {
  const prefix = Buffer.alloc(16); fs.readSync(fd, prefix, 0, 16, 0);
  const headerSize = prefix.readUInt32LE(4), jsonSize = prefix.readUInt32LE(12);
  if (prefix.readUInt32LE(0) !== 4 || jsonSize > 16 * 1024 * 1024 || jsonSize > headerSize - 8) throw Error('Native ASAR header differs');
  const header = Buffer.alloc(jsonSize); fs.readSync(fd, header, 0, jsonSize, 16);
  const headerSha256 = createHash('sha256').update(header).digest('hex');
  if (headerSha256 !== '6b993af172cfc4425644e357856706390067ea457bc76bc11d0d3d5905c3bab5') throw Error('Installed Native archive pin differs');
  const tree = JSON.parse(header), manifest = { staticOnly: true, headerSha256, entries: [] }; fs.mkdirSync(output);
  for (const [name, names] of [
    ['app-initial-b8e1c8014bb4.js', ['CZo', 'oqo', 'DF', '$tr', 'Qtr', 'zHa', 'HHa', 'KHa', 'DHa', 'iJ']],
    ['app-shared-737655e1fb23.js', ['iIt', 'aIt', 'uIt', 'Vk', 'hA', 'M4', 'N7r']],
  ]) {
    const entry = tree.files?.webview?.files?.assets?.files?.[name], offset = Number(entry?.offset), size = entry?.size;
    if (!entry || entry.unpacked || entry.link || !Number.isSafeInteger(offset) || offset < 0 || !Number.isSafeInteger(size) || size < 0 || size > 16 * 1024 * 1024 ||
        8 + headerSize + offset + size > fs.fstatSync(fd).size) throw Error('Unsupported source entry');
    const bytes = Buffer.alloc(size); if (fs.readSync(fd, bytes, 0, size, 8 + headerSize + offset) !== size) throw Error('Truncated Native source');
    const sha256 = createHash('sha256').update(bytes).digest('hex'), cached = fs.readFileSync(path.join(repo, '.artifacts/composer-native-26.1007', name));
    if (createHash('sha256').update(cached).digest('hex') !== sha256) throw Error('Cached source differs from installed Native');
    const source = bytes.toString('utf8'), functions = [];
    for (const id of names) {
      const marker = 'function ' + id + '(', start = source.indexOf(marker);
      if (start < 0 || source.indexOf(marker, start + marker.length) >= 0) throw Error('Source function missing or ambiguous');
      const ast = parseExpressionAt(source, start, { ecmaVersion: 'latest', sourceType: 'module' });
      if (ast.type !== 'FunctionExpression' || ast.id.name !== id || ast.end - start > 131072) throw Error('Function analysis boundary differs');
      const before = source.slice(0, start), file = id + '.js';
      fs.writeFileSync(path.join(output, file), transformSync(source.slice(start, ast.end), { loader: 'js', minify: false }).code, { flag: 'wx' });
      functions.push({ id, file, line: before.split('\n').length, column: start - before.lastIndexOf('\n'), sourceStart: start, sourceEnd: ast.end });
    }
    manifest.entries.push({ resource: name, sha256, functions });
  }
  fs.writeFileSync(path.join(output, 'manifest.json'), JSON.stringify(manifest, null, 2) + '\n', { flag: 'wx' });
  process.stdout.write(JSON.stringify(manifest) + '\n');
} finally { fs.closeSync(fd); }
