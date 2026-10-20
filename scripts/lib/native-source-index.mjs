import fs from 'node:fs';
import path from 'node:path';
import { createRequire } from 'node:module';
import { digest, readSnapshot, relativeSourcePath } from './native-source-snapshot.mjs';

const require = createRequire(new URL('../../frontend/package.json', import.meta.url));
const { parse } = require('acorn');
const { analyze } = require('eslint-scope');
const MAX_DECLARATION = 256 * 1024;
const scalar = node => node?.type === 'Literal' ? node.value :
  node?.type === 'TemplateLiteral' && !node.expressions.length ? node.quasis[0].value.cooked : undefined;
const propertyName = node => node?.computed ? scalar(node.key ?? node.property) :
  (node?.key ?? node?.property)?.name ?? scalar(node?.key ?? node?.property);
const isFunction = node => ['FunctionDeclaration', 'FunctionExpression', 'ArrowFunctionExpression'].includes(node?.type);

export function walkSource(node, visit, parent = null, key = null) {
  if (!node || typeof node !== 'object') return;
  if (node.type) visit(node, parent, key);
  for (const [name, value] of Object.entries(node)) {
    if (['start', 'end', 'range', 'loc'].includes(name)) continue;
    if (Array.isArray(value)) for (const child of value) walkSource(child, visit, node, name);
    else if (value && typeof value === 'object') walkSource(value, visit, node, name);
  }
}

function parameterPath(pattern, target, prefix = []) {
  if (!pattern) return null;
  if (pattern.type === 'Identifier') return pattern === target ? prefix : null;
  if (pattern.type === 'AssignmentPattern') return parameterPath(pattern.left, target, prefix);
  if (pattern.type === 'RestElement') return parameterPath(pattern.argument, target, [...prefix, '...']);
  if (pattern.type === 'ObjectPattern') {
    for (const property of pattern.properties) {
      const found = property.type === 'RestElement' ? parameterPath(property, target, prefix) :
        parameterPath(property.value, target, [...prefix, String(propertyName(property))]);
      if (found) return found;
    }
  }
  if (pattern.type === 'ArrayPattern') for (let i = 0; i < pattern.elements.length; i++) {
    const found = parameterPath(pattern.elements[i], target, [...prefix, i]);
    if (found) return found;
  }
  return null;
}

export function parseSourceModel(source, filename = 'source.js') {
  const ast = parse(source, { ecmaVersion: 'latest', sourceType: 'module', ranges: true,
    allowHashBang: true, allowReturnOutsideFunction: true });
  const scopes = analyze(ast, { ecmaVersion: 2025, sourceType: 'module', optimistic: false, ignoreEval: false });
  const variables = [], bindingFor = new WeakMap(), variableIds = new Map(), scopeIds = new Map(), bindingDeclarations = [];
  const parents = new WeakMap();
  walkSource(ast, (node, parent) => { if (parent) parents.set(node, parent); });
  for (let i = 0; i < scopes.scopes.length; i++) {
    const scope = scopes.scopes[i]; scopeIds.set(scope, i);
    for (let j = 0; j < scope.variables.length; j++) {
      const variable = scope.variables[j], id = `s${i}:v${j}`;
      variableIds.set(variable, id); variables.push(variable);
      for (const identifier of variable.identifiers) {
        bindingFor.set(identifier, variable); bindingDeclarations.push({ start: identifier.start, end: identifier.end, variable });
      }
      if (!variable.defs.length && variable.name === 'arguments') bindingDeclarations.push({ start: variable.scope.block.start, end: variable.scope.block.end, variable });
      for (const reference of variable.references) bindingFor.set(reference.identifier, variable);
    }
  }
  const lines = [0];
  for (let i = 0; i < source.length; i++) if (source.charCodeAt(i) === 10) lines.push(i + 1);
  const location = offset => {
    let low = 0, high = lines.length;
    while (low + 1 < high) { const middle = (low + high) >>> 1; if (lines[middle] <= offset) low = middle; else high = middle; }
    return { line: low + 1, column: offset - lines[low] + 1, offset };
  };
  const binding = node => {
    const variable = bindingFor.get(node);
    if (!variable) return node?.type === 'Identifier' ? { global: node.name } : null;
    const result = { binding: variableIds.get(variable), name: variable.name };
    const definition = variable.defs.find(value => value.type === 'Parameter');
    if (definition) result.parameter = { index: definition.index,
      path: parameterPath(definition.node.params[definition.index], definition.name) ?? [] };
    return result;
  };
  bindingDeclarations.sort((left, right) => left.start - right.start || right.end - left.end);
  return { ast, scopes, variables, bindingFor, variableIds, scopeIds, parents, source, filename, location, binding, bindingDeclarations };
}

function syntaxKey(node, parent, key) {
  return node.type === 'Identifier' && (
    ((parent?.type === 'MemberExpression' || parent?.type === 'Property' || parent?.type === 'MethodDefinition' ||
      parent?.type === 'PropertyDefinition') && (key === 'property' || key === 'key') && !parent.computed) ||
    (parent?.type === 'ImportSpecifier' && key === 'imported') ||
    (parent?.type === 'ExportSpecifier' && key === 'exported') ||
    key === 'label'
  );
}

// Alpha normalization uses resolved variables, never identifier spelling. One
// canonical identity is shared by a binding and all its references. External
// dependencies receive distinct slots and are checked separately during diff.
export function normalizedSource(node, model) {
  const locals = new Map(), external = new Map();
  const declarations = model.bindingDeclarations;
  let low = 0, high = declarations.length;
  while (low < high) { const middle = (low + high) >>> 1; if (declarations[middle].start < node.start) low = middle + 1; else high = middle; }
  for (let i = low; i < declarations.length && declarations[i].start < node.end; i++) {
    const declaration = declarations[i];
    if (declaration.end <= node.end && !locals.has(declaration.variable)) locals.set(declaration.variable, `local:${locals.size}`);
  }
  const normalize = (value, parent = null, key = null) => {
    if (typeof value === 'bigint') return { bigint: String(value) };
    if (!value || typeof value !== 'object') return value;
    if (Array.isArray(value)) return value.map(item => normalize(item, parent, key));
    if (value.type === 'Identifier' && !syntaxKey(value, parent, key)) {
      const variable = model.bindingFor.get(value);
      if (!variable) return { type: 'Identifier', name: `global:${value.name}` };
      if (locals.has(variable)) return { type: 'Identifier', name: locals.get(variable) };
      if (!external.has(variable)) external.set(variable, `dependency:${external.size}`);
      return { type: 'Identifier', name: external.get(variable) };
    }
    return Object.fromEntries(Object.entries(value)
      .filter(([name]) => !['start', 'end', 'range', 'loc', 'raw'].includes(name))
      .map(([name, child]) => [name, normalize(child, value, name)]));
  };
  const normalized = normalize(node);
  return { normalized, hash: digest(JSON.stringify(normalized)),
    dependencies: [...external].map(([variable, slot]) => ({ slot, binding: model.variableIds.get(variable), name: variable.name })) };
}

function expression(node, model, depth = 0) {
  if (!node) return null;
  if (node.type === 'Identifier') return model.binding(node);
  const literal = scalar(node);
  if (literal !== undefined && (literal === null || ['string', 'boolean', 'number'].includes(typeof literal))) {
    return { literal: typeof literal === 'string' && literal.length > 200 ? { sha256: digest(literal), length: literal.length } : literal };
  }
  if (depth > 3) return { type: node.type };
  if (node.type === 'MemberExpression') return { member: propertyName(node) ?? null, object: expression(node.object, model, depth + 1), computed: node.computed };
  if (node.type === 'ObjectExpression') return { object: node.properties.map(value => ({
    key: propertyName(value) ?? null, value: expression(value.value ?? value.argument, model, depth + 1),
  })) };
  if (isFunction(node)) return { type: node.type, params: node.params.length, async: node.async, generator: node.generator };
  if (node.type === 'CallExpression' || node.type === 'NewExpression') return {
    type: node.type, callee: expression(node.callee, model, depth + 1),
    arguments: node.arguments.map(argument => expression(argument, model, depth + 1)),
  };
  return { type: node.type };
}

function interfaceShape(node, model) {
  if (isFunction(node)) return {
    kind: 'function', async: !!node.async, generator: !!node.generator,
    parameters: node.params.map(value => normalizedSource(value, model).normalized),
  };
  if (node.type === 'CallExpression') return { kind: 'call', arity: node.arguments.length,
    arguments: node.arguments.map(argument => argument.type === 'ObjectExpression'
      ? { objectKeys: argument.properties.map(value => propertyName(value)).sort() } : { type: argument.type }) };
  if (node.type === 'ObjectExpression') return { kind: 'object', keys: node.properties.map(value => propertyName(value)).sort() };
  if (node.type === 'ClassExpression' || node.type === 'ClassDeclaration') return { kind: 'class',
    methods: node.body.body.map(value => ({ key: propertyName(value), kind: value.kind, static: !!value.static, params: value.value?.params?.length })) };
  return { kind: node.type };
}

export function indexSource(source, filename = 'source.js') {
  const model = parseSourceModel(source, filename), { ast } = model;
  const imports = [], exports = [], candidates = [], recordKeys = new Set();
  const isTopLevel = variable => variable && ['module', 'global'].includes(variable.scope.type);
  const add = (variable, node, declarationKind) => {
    if (!isTopLevel(variable) || !node) return;
    const id = `${model.variableIds.get(variable)}@${node.start}`;
    if (recordKeys.has(id)) return;
    recordKeys.add(id); candidates.push({ variable, node, declarationKind, id });
  };
  walkSource(ast, node => {
    if (node.type === 'ImportDeclaration') imports.push({ source: node.source.value, location: model.location(node.start),
      specifiers: node.specifiers.map(value => ({ imported: value.imported?.name ?? value.imported?.value ??
        (value.type === 'ImportDefaultSpecifier' ? 'default' : '*'), local: value.local.name, ...model.binding(value.local) })) });
    if (node.type === 'ImportExpression' && typeof scalar(node.source) === 'string') imports.push({ source: scalar(node.source), dynamic: true, location: model.location(node.start), specifiers: [] });
    if (node.type === 'ExportNamedDeclaration') {
      for (const value of node.specifiers) exports.push({ exported: value.exported.name ?? value.exported.value,
        local: value.local.name, ...model.binding(value.local), source: node.source?.value ?? null, location: model.location(value.start) });
      if (node.declaration?.id) exports.push({ exported: node.declaration.id.name, local: node.declaration.id.name, ...model.binding(node.declaration.id), location: model.location(node.start) });
      for (const declaration of node.declaration?.declarations ?? []) if (declaration.id.type === 'Identifier') exports.push({
        exported: declaration.id.name, local: declaration.id.name, ...model.binding(declaration.id), location: model.location(node.start) });
    }
    if (node.type === 'ExportAllDeclaration') imports.push({ source: node.source.value, reexport: true, location: model.location(node.start), specifiers: [] });
    if (['FunctionDeclaration', 'ClassDeclaration'].includes(node.type) && node.id) add(model.bindingFor.get(node.id), node, 'declaration');
    if (node.type === 'VariableDeclarator' && node.id.type === 'Identifier') add(model.bindingFor.get(node.id), node.init, 'initializer');
    if (node.type === 'AssignmentExpression' && node.operator === '=' && node.left.type === 'Identifier') add(model.bindingFor.get(node.left), node.right, 'assignment');
  });
  const exportsByBinding = new Map();
  for (const entry of exports) {
    if (!exportsByBinding.has(entry.binding)) exportsByBinding.set(entry.binding, []);
    exportsByBinding.get(entry.binding).push(entry.exported);
  }
  const records = candidates.map(({ variable, node, declarationKind, id }) => {
    const start = model.location(node.start), end = model.location(node.end);
    const result = { id, binding: model.variableIds.get(variable), local: variable.name, declarationKind, type: node.type,
      start, end, exportNames: exportsByBinding.get(model.variableIds.get(variable)) ?? [] };
    if (node.end - node.start > MAX_DECLARATION) return { ...result, unresolved: 'declaration-size-limit' };
    const normalized = normalizedSource(node, model), literals = new Set(), properties = new Set(), calls = [], operators = new Set();
    const returns = [];
    let maxCallsExceeded = false, directEval = false;
    walkSource(node, child => {
      const text = scalar(child);
      if (typeof text === 'string' && text.length <= 200) literals.add(text);
      if (['MemberExpression', 'Property', 'MethodDefinition', 'PropertyDefinition'].includes(child.type)) {
        const name = propertyName(child); if (typeof name === 'string') properties.add(name);
      }
      if (child.operator) operators.add(`${child.type}:${child.operator}`);
      if (child.type === 'ReturnStatement' && child.argument?.type === 'ObjectExpression') returns.push(child.argument.properties.map(value => propertyName(value)).sort());
      if (child.type === 'CallExpression' || child.type === 'NewExpression') {
        if (child.callee.type === 'Identifier' && child.callee.name === 'eval' && !model.bindingFor.has(child.callee)) directEval = true;
        if (calls.length < 256) calls.push({ ...expression(child, model), at: model.location(child.start) });
        else maxCallsExceeded = true;
      }
    });
    const api = interfaceShape(node, model);
    return { ...result, normalizedHash: normalized.hash, interface: api, interfaceHash: digest(JSON.stringify(api)),
      dependencies: normalized.dependencies, value: expression(node, model), literals: [...literals].sort(),
      properties: [...properties].sort(), operators: [...operators].sort(), returns, calls,
      ...(maxCallsExceeded || directEval ? { unresolved: directEval ? 'dynamic-eval' : 'call-graph-limit' } : {}) };
  });
  const bindings = model.variables.filter(isTopLevel).map(variable => ({
    id: model.variableIds.get(variable), name: variable.name,
    declarations: variable.identifiers.map(identifier => model.location(identifier.start)),
    references: variable.references.map(reference => ({ at: model.location(reference.identifier.start),
      read: reference.isRead(), write: reference.isWrite() })),
  }));
  return { schema: 1, path: filename, sha256: digest(source), bytes: Buffer.byteLength(source), imports, exports, bindings, records };
}

export function resolveModulePath(from, request) {
  if (!request.startsWith('.')) return null;
  const resolved = path.posix.normalize(path.posix.join(path.posix.dirname(from), request));
  try { return relativeSourcePath(resolved); } catch { return null; }
}

export async function indexSnapshot(directory, { roots, all = false, onModule = () => {} } = {}) {
  const snapshot = readSnapshot(directory);
  const sources = new Map(snapshot.files.filter(file => /\.(?:m?js|cjs)$/.test(file.path)).map(file => [file.path, file]));
  const defaultRoots = /\/(?:app-(?:initial|shared|primary)|local-conversation-thread|keyboard-shortcuts-settings)-[^/]+\.js$/;
  const selected = all ? [...sources.keys()] : roots ?? [...sources.keys()].filter(name => defaultRoots.test(name));
  if (!selected.length) throw Error('No source roots match the snapshot');
  const pending = [...new Set(selected)].sort(), modules = [], seen = new Set(), missing = new Set();
  for (let i = 0; i < pending.length; i++) {
    const filename = pending[i];
    if (seen.has(filename)) continue;
    seen.add(filename);
    if (!sources.has(filename)) { missing.add(filename); continue; }
    const started = performance.now();
    const indexed = indexSource(fs.readFileSync(path.join(directory, 'sources', filename), 'utf8'), filename);
    modules.push(indexed);
    for (const item of indexed.imports) {
      const target = resolveModulePath(filename, item.source);
      if (!item.dynamic && target && !seen.has(target)) pending.push(target);
    }
    onModule({ path: filename, records: indexed.records.length, elapsedMs: Math.round(performance.now() - started) });
    // Scope models are per module and deliberately not retained in the index.
  }
  return { schema: 1, kind: 'native-source-index', snapshot: path.resolve(directory),
    snapshotSha256: digest(fs.readFileSync(path.join(directory, 'snapshot.json'))), identity: snapshot.identity,
    analysis: { roots: selected, mode: all ? 'all-modules' : 'roots-and-static-dependencies',
      filesInSnapshot: sources.size, indexed: modules.length, missing: [...missing].sort(),
      unindexed: [...sources.keys()].filter(name => !seen.has(name)), partialBaseline: snapshot.coverage.partial,
      normalizer: 'acorn-8.15.0/eslint-scope-9.0.0/resolved-bindings-v1' }, modules };
}
