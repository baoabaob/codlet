import { component } from '../host-discovery.js';
import { parse } from 'acorn';
import { workspaceModuleSyntax, workspaceSourceFunctions, workspaceLexicalReferences, visitWorkspaceSource } from './workspace-source.js';

const fail = message => Object.assign(new Error(message), { code: 'ui_build_drift' });
const property = node => node?.computed ? node.key?.value : node.key?.name ?? node.key?.value;
const headerObject = node => node?.type === 'ObjectExpression' && ['Root', 'Header', 'HeaderToolbar'].every(name =>
  node.properties.filter(item => item.type === 'Property' && property(item) === name).length === 1);
const headerValue = value => value && ['Root','Header','HeaderToolbar'].every(key=>component(Object.getOwnPropertyDescriptor(value,key)?.value));

// The modern AppShell is a live export assigned by its own lazy initializer.
// Resolve both exports from the same lexical assignment; an unrelated function
// mentioning HeaderToolbar does not authorize an initializer call.
export function nativePageHeaderContract(source) {
  const syntax = workspaceModuleSyntax(source), exports = local => [...new Set(syntax.exports.filter(item => !item.source && item.local === local).map(item => item.exported))].sort();
  const found = [];
  for (const ast of workspaceSourceFunctions(source, 'HeaderToolbar', { topLevel: true })) {
    if (!ast.id || ast.params.length || ast.async || ast.generator) continue;
    const initializer = exports(ast.id.name);
    if (!initializer.length) continue;
    const resolve = workspaceLexicalReferences(ast), candidates = [];
    visitWorkspaceSource(ast, node => {
      if (node.type !== 'AssignmentExpression' || node.operator !== '=' || node.left.type !== 'Identifier' || !headerObject(node.right)) return;
      if (resolve(node.left) !== `global:${node.left.name}`) return;
      const names = exports(node.left.name);
      if (names.length) candidates.push({ node, names });
    });
    if (!candidates.length) continue;
    // Native's self-replacing initializer invokes exactly the callback that
    // assigns the live AppShell binding. Never call an arbitrary setup function.
    const returns = ast.body.body.filter(node => node.type === 'ReturnStatement');
    const invocation = returns.length === 1 ? returns[0].argument : null;
    const assignment = invocation?.type === 'CallExpression' && !invocation.arguments.length ? invocation.callee : null;
    const call = assignment?.type === 'AssignmentExpression' && assignment.operator === '=' && resolve(assignment.left) === resolve(ast.id) ? assignment.right : null;
    const callback = call?.type === 'CallExpression' && call.arguments.length === 1 ? call.arguments[0] : null;
    if (!['ArrowFunctionExpression', 'FunctionExpression'].includes(callback?.type) || callback.params.length || callback.async || callback.generator) continue;
    for (const candidate of candidates) {
      let direct = false;
      visitWorkspaceSource(callback.body, node => { if (node === candidate.node) direct = true; }, true);
      if (direct) found.push({ initializer: initializer[0], value: candidate.names[0], declaration: ast.start });
    }
  }
  if (!found.length) return null;
  // A named function expression can shadow an exported declaration with the
  // same spelling. Confirm that the selected function is the actual module
  // declaration before granting its exported function permission to initialize.
  const declarations = new Set(parse(source, { ecmaVersion: 'latest', sourceType: 'module' }).body.map(node =>
    node.type === 'ExportNamedDeclaration' ? node.declaration : node).filter(node => node?.type === 'FunctionDeclaration').map(node => node.start));
  const declared = found.filter(item => declarations.has(item.declaration));
  if (declared.length > 1) throw fail('The native page header initializer is ambiguous');
  return declared.length ? { initializer: declared[0].initializer, value: declared[0].value } : null;
}

export function resolveNativePageHeader(records, check = () => {}) {
  const existing = [...new Set(records.flatMap(({ module }) => Object.values(module)))].filter(headerValue);
  if (existing.length > 1) throw fail('The native page header is ambiguous');
  if (existing.length === 1) return existing[0];
  const matches = records.map(record => ({ ...record, contract: nativePageHeaderContract(record.source) })).filter(record => record.contract);
  if (matches.length > 1) throw fail('The native page header initializer is ambiguous');
  if (!matches.length) return undefined;
  const { module, contract } = matches[0];
  check();
  const initialize = module[contract.initializer];
  if (typeof initialize !== 'function') throw fail('The native page header initializer export changed');
  initialize();
  check();
  const header = module[contract.value];
  if (!headerValue(header)) throw fail('The native page header export changed after initialization');
  return header;
}
