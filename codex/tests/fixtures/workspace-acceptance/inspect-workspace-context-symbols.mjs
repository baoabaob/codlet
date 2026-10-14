// Static import/export/declaration extraction. Cached assets only; no eval.
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { randomUUID } from 'node:crypto';
import { parse } from '../../../frontend/node_modules/acorn/dist/acorn.mjs';
import { transformSync } from '../../../frontend/node_modules/esbuild/lib/main.js';

const repo = fileURLToPath(new URL('../../../', import.meta.url));
const directory = path.join(repo, '.artifacts/workspace-context-source/symbols-' + randomUUID()); fs.mkdirSync(directory, { recursive: true });
const initial = fs.readFileSync(path.join(repo, '.artifacts/composer-native-26.1007/app-initial-b8e1c8014bb4.js'), 'utf8');
const shared = fs.readFileSync(path.join(repo, '.artifacts/composer-native-26.1007/app-shared-737655e1fb23.js'), 'utf8');
const primary = fs.readFileSync(path.join(repo, '.artifacts/composer-native-26.1007/app-primary-19fe57fd8c00.js'), 'utf8');
const dropdown = fs.readFileSync(path.join(repo, '.artifacts/workspace-context-source/permissions-67eb6050-c752-4084-9337-cb00c0d507b9/permissions-mode-dropdown-7bfb50f8e130.js'), 'utf8');
const initialAst = parse(initial, { ecmaVersion: 'latest', sourceType: 'module' }), sharedAst = parse(shared, { ecmaVersion: 'latest', sourceType: 'module' });
const primaryAst = parse(primary, { ecmaVersion: 'latest', sourceType: 'module' });
const dropdownAst = parse(dropdown, { ecmaVersion: 'latest', sourceType: 'module' });
const names = process.argv.slice(2).length ? process.argv.slice(2) : ['shared:gI','shared:hI','shared:mI','shared:sO','shared:Qct'];
const exports = new Map();
for (const node of sharedAst.body) if (node.type === 'ExportNamedDeclaration') for (const spec of node.specifiers) exports.set(spec.exported.name, spec.local.name);
const declarations = (ast, name) => ast.body.flatMap(node => node.type === 'FunctionDeclaration' && node.id?.name === name ? [node] :
  node.type === 'VariableDeclaration' ? node.declarations.filter(value => value.id.name === name) : []);
function assignments(ast, name) {
  const result = []; const visit = value => {
    if (!value || typeof value !== 'object') return;
    if (value.type === 'AssignmentExpression' && value.left.type === 'Identifier' && value.left.name === name) result.push(value);
    for (const [key, child] of Object.entries(value)) if (key !== 'start' && key !== 'end') {
      if (Array.isArray(child)) child.forEach(visit); else if (child && typeof child === 'object') visit(child);
    }
  }; visit(ast); return result;
}
const result = [];
for (const requested of new Set(names)) {
  const name=requested.replace(/^(shared|primary|dropdown):/,''), fromPrimary=requested.startsWith('primary:'), fromDropdown=requested.startsWith('dropdown:'), originAst=fromDropdown?dropdownAst:fromPrimary?primaryAst:initialAst;
  const importNode = originAst.body.find(node => node.type === 'ImportDeclaration' && node.specifiers.some(spec => spec.local.name === name));
  const importSpec = importNode?.specifiers.find(spec => spec.local.name === name);
  const directShared=requested.startsWith('shared:');
  const fromShared = directShared||importNode?.source.value.includes('app-shared-737655e1fb23');
  const initialExports=new Map();for(const node of initialAst.body)if(node.type==='ExportNamedDeclaration')for(const spec of node.specifiers)initialExports.set(spec.exported.name,spec.local.name);
  const fromInitial=(fromPrimary||fromDropdown)&&importNode?.source.value.includes('app-initial-b8e1c8014bb4');
  const local = directShared?name:fromShared ? exports.get(importSpec.imported.name) : fromInitial?initialExports.get(importSpec.imported.name):name, graph = fromShared ? shared : fromInitial?initial:fromDropdown?dropdown:fromPrimary?primary:initial, ast = fromShared ? sharedAst :fromInitial?initialAst:fromDropdown?dropdownAst:fromPrimary?primaryAst:initialAst;
  const found = [...declarations(ast, local), ...assignments(ast, local)], files = [];
  for (const node of found) {
    const filename = `symbol-${name}-${node.start}.js`;
    fs.writeFileSync(path.join(directory, filename), transformSync((node.type === 'VariableDeclarator' ? 'let ' : '') + graph.slice(node.start, node.end) + ';', { loader: 'js', minify: false }).code, { flag: 'wx' }); files.push(filename);
  }
  result.push({ name, imported: importSpec?.imported?.name, from: importNode?.source.value, local, files });
}
fs.writeFileSync(path.join(directory, 'symbols.json'), JSON.stringify(result, null, 2) + '\n', { flag: 'wx' });
console.log(JSON.stringify({ directory, symbols: result }));
