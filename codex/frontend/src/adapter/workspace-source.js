import { parse, parseExpressionAt, tokenizer } from 'acorn';
import { analyze } from 'eslint-scope';
import { workspaceError } from './workspace-dom.js';
import { keymapQueryKind } from './workspace-keymap-query.js';

const syntaxCache = new Map(), MAX_DECLARATION = 32768, MAX_MODULE_INTERFACE = 512 * 1024;
const text = node => node?.type === 'Literal' ? node.value :
  node?.type === 'TemplateLiteral' && !node.expressions.length ? node.quasis[0].value.cooked : undefined;
const key = node => node?.computed ? text(node.key ?? node.property) :
  (node?.key ?? node?.property)?.name ?? text(node?.key ?? node?.property);
const functionNode = node => ['FunctionExpression', 'FunctionDeclaration', 'ArrowFunctionExpression'].includes(node?.type);
export function visitWorkspaceSource(node, visit, skipFunctions = false, root = node) {
  if (!node || typeof node !== 'object' || skipFunctions && node !== root && functionNode(node)) return;
  if (node.type) visit(node);
  for (const [name, value] of Object.entries(node)) if (!['start', 'end', 'range', 'loc'].includes(name)) {
    if (Array.isArray(value)) for (const child of value) visitWorkspaceSource(child, visit, skipFunctions, root);
    else if (value && typeof value === 'object') visitWorkspaceSource(value, visit, skipFunctions, root);
  }
}

// Tokenization identifies real declarations, skipping strings/comments and
// nested properties named "export". Only small import/export clauses get ASTs.
export function workspaceModuleSyntax(source) {
  if (syntaxCache.has(source)) return syntaxCache.get(source);
  const result = { imports: [], exports: [], functions: [], parsed: new Map() };
  const stream = tokenizer(source, { ecmaVersion: 'latest', sourceType: 'module' });
  let buffered, braces = 0, brackets = 0, parens = 0;
  const next = () => { const value = buffered ?? stream.getToken(); buffered = undefined; return value; };
  for (;;) {
    const token = next(), label = token.type.label;
    if (label === 'eof') break;
    if (label === 'function') result.functions.push(token.start);
    if (!braces && !brackets && !parens && (label === 'export' || label === 'import')) {
      let item = next();
      if (label === 'export' && item.type.label !== '{' || label === 'import' && ['(', '.'].includes(item.type.label)) { buffered = item; continue; }
      let end = item.end, depth = 0, completed = false;
      if (label === 'export') {
        depth = 1;
        while (depth && end - token.start <= MAX_MODULE_INTERFACE) {
          item = next(); if (item.type.label === 'eof') break;
          if (item.type.label === '{') depth++;
          if (item.type.label === '}') depth--;
          end = item.end;
        }
        if (depth) throw workspaceError('workspace_host_drift', 'Native export declaration exceeds its boundary');
        item = next();
        if (item.value === 'from') {
          item = next();
          if (item.type.label !== 'string') throw workspaceError('workspace_host_drift', 'Native re-export source changed');
          end = item.end;
        } else buffered = item;
        completed = true;
      } else {
        while (end - token.start <= MAX_MODULE_INTERFACE) {
          if (item.type.label === 'string' && !depth) { end = item.end; completed = true; break; }
          if (item.type.label === '{') depth++;
          if (item.type.label === '}') depth--;
          item = next(); end = item.end;
          if (item.type.label === 'eof') break;
        }
      }
      if (!completed) throw workspaceError('workspace_host_drift', 'Native import declaration exceeds its boundary');
      const declaration = parse(source.slice(token.start, end), { ecmaVersion: 'latest', sourceType: 'script', allowImportExportEverywhere: true }).body[0];
      if (declaration.type === 'ExportNamedDeclaration') for (const specifier of declaration.specifiers) result.exports.push({
        local: specifier.local.name ?? specifier.local.value, exported: specifier.exported.name ?? specifier.exported.value,
        source: declaration.source?.value ?? null,
      });
      if (declaration.type === 'ImportDeclaration') for (const specifier of declaration.specifiers) result.imports.push({
        local: specifier.local.name, imported: specifier.imported?.name ?? specifier.imported?.value ??
          (specifier.type === 'ImportDefaultSpecifier' ? 'default' : '*'), source: declaration.source.value,
      });
      continue;
    }
    if (label === '{' || label === '${') braces++;
    if (label === '}') braces--;
    if (label === '[') brackets++;
    if (label === ']') brackets--;
    if (label === '(') parens++;
    if (label === ')') parens--;
  }
  if (syntaxCache.size >= 6) syntaxCache.delete(syntaxCache.keys().next().value);
  syntaxCache.set(source, result); return result;
}

export function workspaceSourceFunctions(source, marker, {identifier=false}={}) {
  if (!source.includes(marker)) return [];
  const syntax = workspaceModuleSyntax(source), found = new Map();
  let count = 0;
  for (let at = source.indexOf(marker); at >= 0; at = source.indexOf(marker, at + marker.length)) {
    if(identifier&&(/[A-Za-z0-9_$]/.test(source[at-1]??'')||/[A-Za-z0-9_$]/.test(source[at+marker.length]??'')))continue;
    if (++count > 128) throw workspaceError('workspace_host_drift', 'Native source marker exceeds its search boundary');
    let low = 0, high = syntax.functions.length;
    while (low < high) { const middle = (low + high) >>> 1; if (syntax.functions[middle] < at) low = middle + 1; else high = middle; }
    for (let i = low - 1, attempts = 0; i >= 0 && attempts++ < 64 && at - syntax.functions[i] <= MAX_DECLARATION; i--) {
      const start = syntax.functions[i];
      if (!syntax.parsed.has(start)) {
        let ast;
        try {
          ast = parseExpressionAt(source.slice(start, start + MAX_DECLARATION), 0, { ecmaVersion: 'latest', ranges: true });
          visitWorkspaceSource(ast, node => { node.start += start; node.end += start; node.range = [node.start, node.end]; });
        } catch { ast = null; }
        syntax.parsed.set(start, ast && ast.end - ast.start <= MAX_DECLARATION ? ast : null);
      }
      const ast = syntax.parsed.get(start);
      if (ast?.end > at) found.set(start, ast);
    }
  }
  return [...found.values()];
}

export function workspaceExportName(source, local, code, role) {
  const names = [...new Set(workspaceModuleSyntax(source).exports.filter(value => value.local === local && !value.source).map(value => value.exported))];
  if (!names.length) throw workspaceError(code, `Native ${role} is not exported`);
  // Multiple aliases of one lexical binding are the same ESM value.
  return names.sort()[0];
}

export function workspaceLexicalReferences(ast) {
  const program = { type: 'Program', sourceType: 'module', start: ast.start, end: ast.end, range: [ast.start, ast.end],
    body: [{ type: 'ExpressionStatement', expression: ast, start: ast.start, end: ast.end, range: [ast.start, ast.end] }] };
  const manager = analyze(program, { ecmaVersion: 2025, sourceType: 'module', ignoreEval: false });
  const resolved = new WeakMap();
  for (const scope of manager.scopes) for (const variable of scope.variables) {
    for (const identifier of variable.identifiers) resolved.set(identifier, variable);
    for (const reference of variable.references) resolved.set(reference.identifier, variable);
  }
  return node => node?.type === 'Identifier' ? resolved.get(node) ?? `global:${node.name}` : null;
}

function assignments(ast) {
  const result = [];
  visitWorkspaceSource(ast, node => {
    if (node.type === 'AssignmentExpression' && node.operator === '=' && node.left.type === 'Identifier') result.push({ left: node.left, right: node.right, start: node.start });
    if (node.type === 'VariableDeclarator' && node.id.type === 'Identifier' && node.init) result.push({ left: node.id, right: node.init, start: node.start });
  });
  return result;
}

function queryDataReturns(callback, get, query, resolve) {
  const queryResults = new Set(), data = new Set(), declarations = [], returns = [];
  visitWorkspaceSource(callback.body, node => {
    if (node.type === 'VariableDeclarator') declarations.push(node);
    if (node.type === 'ReturnStatement') returns.push(node.argument);
  }, true);
  if (callback.body.type !== 'BlockStatement') returns.push(callback.body);
  const readsQuery = node => node?.type === 'CallExpression' && resolve(node.callee) === get && node.arguments.length === 1 && resolve(node.arguments[0]) === query;
  const dataValue = node => node?.type === 'Identifier' && data.has(resolve(node)) ||
    node?.type === 'MemberExpression' && key(node) === 'data' &&
      (readsQuery(node.object) || queryResults.has(resolve(node.object)));
  for (let pass = 0; pass <= declarations.length; pass++) {
    const before = queryResults.size + data.size;
    for (const declaration of declarations) {
      if (declaration.id.type === 'Identifier') {
        if (readsQuery(declaration.init)) queryResults.add(resolve(declaration.id));
        if (dataValue(declaration.init)) data.add(resolve(declaration.id));
      } else if (declaration.id.type === 'ObjectPattern' && (readsQuery(declaration.init) || queryResults.has(resolve(declaration.init)))) {
        for (const property of declaration.id.properties) if (key(property) === 'data' && property.value?.type === 'Identifier') data.add(resolve(property.value));
      }
    }
    if (before === queryResults.size + data.size) break;
  }
  return returns.some(value => {
    if (functionNode(value)) return false;
    let consumes = false;
    visitWorkspaceSource(value, node => { if (dataValue(node)) consumes = true; }, true);
    return consumes;
  });
}

export function keymapSourceExport(source, { optional = false } = {}) {
  const code = 'workspace_shortcuts_unavailable', matches = new Map();
  const roots=new Map(workspaceSourceFunctions(source,'codex-command-keymap-state').map(ast=>[ast.start,ast]));
  const keys=new Set();
  for(const ast of roots.values()){
    const resolve=workspaceLexicalReferences(ast);
    for(const value of assignments(ast))if(typeof resolve(value.left)==='string'&&value.right.type==='ArrayExpression'&&value.right.elements.length===2&&text(value.right.elements[0])==='vscode'&&text(value.right.elements[1])==='codex-command-keymap-state')keys.add(value.left.name);
  }
  if(keys.size>16)throw workspaceError(code,'Native keymap keys exceed the discovery boundary');
  // Native can initialize the module-level query key separately from its query
  // and derived state. Collect only bounded functions that reference that key.
  for(const name of keys)for(const ast of workspaceSourceFunctions(source,name,{identifier:true}))roots.set(ast.start,ast);
  const definitions=new Map();
  for(const ast of roots.values()){
    const resolve=workspaceLexicalReferences(ast);
    for(const value of assignments(ast)){
      const id=resolve(value.left);if(typeof id!=='string'||!keys.has(value.left.name))continue;
      if(!definitions.has(id))definitions.set(id,new Map());definitions.get(id).set(value.start,value.right);
    }
  }
  for (const ast of roots.values()) {
    const resolve = workspaceLexicalReferences(ast), values = assignments(ast);
    const lookup = identifier => {
      const external=definitions.get(resolve(identifier));
      if(external)return external.size===1?[...external.values()][0]:null;
      const matches = values.filter(value => resolve(value.left) === resolve(identifier));
      return matches.length === 1 ? matches[0].right : null;
    };
    const queries = values.map(value => ({ ...value, kind: keymapQueryKind(value.right, lookup) })).filter(value => value.kind);
    for (const derived of values) {
      const call = derived.right, callback = call.arguments?.[1];
      if (call.type !== 'CallExpression' || call.arguments.length !== 2 || !functionNode(callback)) continue;
      const parameter = callback.params[0], getter = parameter?.type === 'ObjectPattern' &&
        parameter.properties.find(property => key(property) === 'get' && property.value?.type === 'Identifier')?.value;
      if (!getter) continue;
      let stateProperty = false;
      visitWorkspaceSource(callback.body, node => { if (['Property', 'MemberExpression'].includes(node.type) && key(node) === 'primaryNumberShortcutTarget') stateProperty = true; }, true);
      for (const query of queries) if ((query.kind === 'options' || stateProperty) && resolve(query.right.arguments[0]) === resolve(call.arguments[0]) &&
        queryDataReturns(callback, resolve(getter), resolve(query.left), resolve)) {
        matches.set(`${query.start}:${derived.start}`, derived.left.name);
      }
    }
  }
  if (!matches.size && optional) return null;
  if (matches.size !== 1) throw workspaceError(code, 'Native keymap query-to-state flow is missing or ambiguous');
  return workspaceExportName(source, [...matches.values()][0], code, 'keymap state');
}

export function navigationSourceExport(source, { optional = false } = {}) {
  const code = 'workspace_navigation_unsupported', matches = new Map(), required = ['navigate', 'navigateToLocalConversation', 'prepareNavigation'];
  for (const ast of workspaceSourceFunctions(source, 'prepareNavigation')) {
    const resolve = workspaceLexicalReferences(ast), values = assignments(ast);
    const defaults = values.filter(value => value.right.type === 'ObjectExpression' && value.right.properties.length === 3 &&
      required.every(name => value.right.properties.some(property => key(property) === name && property.value?.type === 'Identifier')));
    for (const candidate of values) {
      const call = candidate.right;
      if (call.type !== 'CallExpression' || call.arguments.length !== 2 || call.arguments[1]?.type !== 'Identifier') continue;
      for (const fallback of defaults) if (resolve(call.arguments[1]) === resolve(fallback.left)) {
        const owners = fallback.right.properties.map(property => resolve(property.value));
        if (owners.some(owner => owner !== owners[0])) continue;
        const missing = workspaceSourceFunctions(source, 'AppNavigationSignalBridge is missing')
          .some(fn => fn.id && owners[0] === `global:${fn.id.name}` && fn.params.length === 0 &&
            fn.body.body.some(statement => statement.type === 'ThrowStatement'));
        if (missing) matches.set(`${fallback.start}:${candidate.start}`, candidate.left.name);
      }
    }
  }
  if (!matches.size && optional) return null;
  if (matches.size !== 1) throw workspaceError(code, 'Native navigation defaults-to-signal flow is missing or ambiguous');
  return workspaceExportName(source, [...matches.values()][0], code, 'navigation signal');
}

export function clearWorkspaceSourceCache() { syntaxCache.clear(); }
