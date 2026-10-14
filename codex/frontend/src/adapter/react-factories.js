import { parse, tokenizer } from 'acorn';

const fail = message => Object.assign(new Error(message), { code: 'ui_react_drift' });
export function factoryStatements(source) {
  // Tokenize the native module once, but construct ASTs only for possible CJS
  // factories and its export map. Native's unrelated UI functions dominate the
  // multi-megabyte module and need neither AST allocation nor traversal here.
  const tokens = tokenizer(source, { ecmaVersion: 'latest', sourceType: 'module' }), result = [];
  let braces = 0, parentheses = 0, brackets = 0, start = null, kind = null;
  for (;;) {
    const token = tokens.getToken(), label = token.type.label;
    if (label === 'eof') break;
    const keyword = token.type.keyword ?? (token.value === 'let' ? 'let' : null);
    if (!braces && !parentheses && !brackets && ['var', 'let', 'const', 'export'].includes(keyword)) {
      if (start != null && kind === 'export' && /^export\s*$/.test(source.slice(start, token.start))) continue;
      if (start != null) add(token.start);
      start = token.start; kind = keyword;
    }
    if (label === '{' || label === '${') braces++;
    else if (label === '}') braces--;
    else if (label === '(') parentheses++;
    else if (label === ')') parentheses--;
    else if (label === '[') brackets++;
    else if (label === ']') brackets--;
    if (start != null && label === ';' && !braces && !parentheses && !brackets) add(token.end);
  }
  if (start != null) add(source.length);
  return result;
  function add(end) {
    const part = source.slice(start, end);
    if (kind === 'export' || /\bexports\b|\.createElement\b|\.createRoot\b|\.flushSync\b/.test(part))
      // A sliced export map has declarations in other slices. Parse only its
      // syntax here; the factory graph below validates every referenced name.
      result.push(...parse(part, { ecmaVersion: 'latest', sourceType: kind === 'export' ? 'script' : 'module', allowImportExportEverywhere: kind === 'export' }).body);
    start = kind = null;
  }
}
// Resolve CommonJS exports structurally. Parsing never executes downloaded text;
// only a uniquely identified React/DOM factory from the loaded native ESM module
// can be called. The generated local identifiers and export aliases may change.
export function reactFactories(source) {
  if (typeof source !== 'string' || source.length > 16 * 1024 * 1024) throw fail('Native shared module exceeds the source limit');
  const factories = new Map(), exports = new Map();
  const expressions = value => value?.type === 'SequenceExpression' ? value.expressions.flatMap(expressions) : [value];
  for (const statement of factoryStatements(source)) {
    if (statement.type === 'ExportNamedDeclaration') for (const item of statement.specifiers)
      if (item.type === 'ExportSpecifier') exports.set(item.local.name, item.exported.name);
    if (statement.type !== 'VariableDeclaration') continue;
    for (const declaration of statement.declarations) {
      const call = declaration.init, fn = call?.type === 'CallExpression' && call.arguments.length === 1 ? call.arguments[0] : null;
      if (declaration.id.type !== 'Identifier' || !['ArrowFunctionExpression', 'FunctionExpression'].includes(fn?.type) ||
          fn.body.type !== 'BlockStatement' || !fn.params.length || fn.params.some(p => p.type !== 'Identifier')) continue;
      const properties = new Set(), aliases = new Set();
      for (const statement of fn.body.body) {
        if (statement.type !== 'ExpressionStatement') continue;
        for (const assignment of expressions(statement.expression)) {
          if (assignment?.type !== 'AssignmentExpression' || assignment.operator !== '=' || assignment.left.type !== 'MemberExpression' || assignment.left.computed) continue;
          const { object, property } = assignment.left;
          if (object.type !== 'Identifier' || property.type !== 'Identifier') continue;
          if (object.name === fn.params[0].name) properties.add(property.name);
          const right = assignment.right;
          if (object.name === fn.params[1]?.name && property.name === 'exports' && right.type === 'CallExpression' &&
              right.callee.type === 'Identifier' && right.arguments.length === 0) aliases.add(right.callee.name);
        }
      }
      factories.set(declaration.id.name, { properties, aliases });
    }
  }
  const roles = { react: ['createElement', 'useState', 'useEffect', 'Fragment', 'version'],
    dom: ['createPortal', 'flushSync', 'version'], client: ['createRoot'] };
  const result = {};
  for (const [role, properties] of Object.entries(roles)) {
    const roots = [...factories].filter(([, value]) => properties.every(p => value.properties.has(p))).map(([name]) => name);
    if (roots.length !== 1) throw fail(`Native ${role} factory is missing or ambiguous`);
    const reaches = (name, seen = new Set()) => {
      if (name === roots[0]) return true;
      if (seen.has(name) || seen.size >= 8) return false;
      seen.add(name);
      const aliases = factories.get(name)?.aliases;
      return aliases?.size === 1 && reaches([...aliases][0], seen);
    };
    const names = [...exports].filter(([name]) => reaches(name)).map(([, name]) => name);
    if (names.length !== 1) throw fail(`Native ${role} export is missing or ambiguous`);
    result[role] = names[0];
  }
  return result;
}
