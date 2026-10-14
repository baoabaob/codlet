// Static cached Native source only. No evaluation, profile or client access.
import fs from 'node:fs';
import path from 'node:path';
import { randomUUID, createHash } from 'node:crypto';
import { fileURLToPath } from 'node:url';
import { parse } from '../../../frontend/node_modules/acorn/dist/acorn.mjs';
import { transformSync } from '../../../frontend/node_modules/esbuild/lib/main.js';

const repo = fileURLToPath(new URL('../../../', import.meta.url));
const directory = path.join(repo, '.artifacts/workspace-context-source', 'source-' + randomUUID()); fs.mkdirSync(directory, { recursive: true });
const files = [
  path.join(repo, '.artifacts/composer-native-26.1007/app-initial-b8e1c8014bb4.js'),
  path.join(repo, '.artifacts/composer-native-26.1007/app-primary-19fe57fd8c00.js'),
  path.join(repo, '.artifacts/composer-native-26.1007/local-conversation-thread-70abb87ab9c8.js'),
  path.join(repo, '.artifacts/adapter-native/adapter-44f7b16a-5596-4bf0-b079-f70095b71696/native-anchor-source/thread-app-shell-chrome-1fda1ae81717.js')
];
const markers = process.argv.slice(2).length ? process.argv.slice(2) : ['over-tabs', 'storageKey', 'HeaderToolbar', 'paneWidth'];
const manifest = { staticOnly: true, files: [] };
for (let index = 0; index < files.length; index++) {
  const bytes = fs.readFileSync(files[index]), source = bytes.toString('utf8');
  const ast = parse(source, { ecmaVersion: 'latest', sourceType: 'module' });
  const selected = [];
  for (const node of ast.body) {
    if (node.type !== 'FunctionDeclaration' || node.end - node.start > 131072) continue;
    const text = source.slice(node.start, node.end), found = markers.filter(marker => text.includes(marker));
    if (!found.length) continue;
    const filename = `${index}-${node.start}-${node.id.name}.js`;
    fs.writeFileSync(path.join(directory, filename), transformSync(text, { loader: 'js', minify: false }).code, { flag: 'wx' });
    selected.push({ name: node.id.name, filename, markers: found, start: node.start, end: node.end });
  }
  manifest.files.push({ source: files[index], sha256: createHash('sha256').update(bytes).digest('hex'), selected });
}
fs.writeFileSync(path.join(directory, 'manifest.json'), JSON.stringify(manifest, null, 2) + '\n', { flag: 'wx' });
console.log(JSON.stringify({ directory, files: manifest.files.map(value => ({ source: path.basename(value.source), selected: value.selected })) }));
