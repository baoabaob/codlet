const text = node => node?.type === 'Literal' ? node.value :
  node?.type === 'TemplateLiteral' && !node.expressions.length ? node.quasis[0].value.cooked : undefined;
const key = node => node?.computed ? text(node.key) : node?.key?.name ?? text(node?.key);
const callable = node => ['FunctionExpression', 'ArrowFunctionExpression'].includes(node?.type);

// Native has used both a keyed query factory and a query-options factory. Keep
// their source contracts shared by offline analysis and runtime discovery.
export function keymapQueryKind(call, lookup) {
  if (call?.type !== 'CallExpression' || ![2, 3].includes(call.arguments.length) || call.arguments[0]?.type !== 'Identifier') return null;
  if (text(call.arguments[1]) === 'codex-command-keymap-state') return 'keyed';
  const factory = call.arguments[1];
  if (call.arguments.length !== 2 || !callable(factory) || factory.async || factory.params.length || factory.body.type !== 'ObjectExpression') return null;
  const fields = name => factory.body.properties.filter(property => property.type === 'Property' && key(property) === name);
  const queryKeys = fields('queryKey'), queryFunctions = fields('queryFn');
  if (queryKeys.length !== 1 || queryFunctions.length !== 1 || !callable(queryFunctions[0].value)) return null;
  const value = queryKeys[0].value;
  const queryKey = value.type === 'Identifier' ? lookup(value) : value;
  return queryKey?.type === 'ArrayExpression' && queryKey.elements.length === 2 &&
    text(queryKey.elements[0]) === 'vscode' && text(queryKey.elements[1]) === 'codex-command-keymap-state' ? 'options' : null;
}
