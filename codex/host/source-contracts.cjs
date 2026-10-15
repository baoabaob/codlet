'use strict';
const { parse } = require('../../runtime/sdk-source-parser.cjs');
const required = Object.freeze({
  network: ['assertAllowed', 'fetch', 'request'],
  fetch: ['performDesktopFetch', 'performProgressRequest'],
  stdio: ['send'],
  connection: ['routeIncomingMessage', 'getPendingRequestCount', 'restart'],
});
const identifier = value => typeof value === 'string' && /^[A-Za-z_$][\w$]*$/u.test(value);
function method(Constructor, name) {
  const value = Object.getOwnPropertyDescriptor(Constructor?.prototype ?? {}, name)?.value;
  return typeof value === 'function' ? value : null;
}
const parsedMethods = new WeakMap();
function memberPath(node) {
  if (node?.type === 'ThisExpression') return ['this'];
  if (node?.type === 'Identifier') return [node.name];
  if (node?.type !== 'MemberExpression') return null;
  const parent = memberPath(node.object), key = !node.computed && node.property.type === 'Identifier' ? node.property.name
    : node.property.type === 'Literal' && typeof node.property.value === 'string' ? node.property.value : null;
  return parent && key !== null ? [...parent, key] : null;
}
function inspectMethod(Constructor, name) {
  const value = method(Constructor, name);
  if (!value) return null;
  if (parsedMethods.has(value)) return parsedMethods.get(value);
  const source = Function.prototype.toString.call(value);
  let result = null;
  if (source.length <= 256 * 1024) try {
    const tree = parse(`({${source}})`, {ecmaVersion:'latest',sourceType:'script'});
    const fn = tree.body[0]?.expression?.properties?.[0]?.value;
    if (!fn?.body) throw Error('method_missing');
    const calls = [], members = [], strings = [], variables = new Map();
    const walk = node => {
      if (!node || typeof node !== 'object') return;
      if (node.type === 'CallExpression') calls.push({path:memberPath(node.callee)?.join('.'),args:node.arguments,start:node.start});
      if (node.type === 'MemberExpression') members.push(memberPath(node)?.join('.'));
      if (node.type === 'Literal' && typeof node.value === 'string') strings.push(node.value);
      if (node.type === 'TemplateLiteral' && !node.expressions.length) strings.push(node.quasis[0].value.cooked);
      if (node.type === 'VariableDeclarator' && node.id.type === 'Identifier') variables.set(node.id.name,node.init);
      for (const [key, child] of Object.entries(node)) if (key !== 'start' && key !== 'end') {
        if (Array.isArray(child)) child.forEach(walk); else if (child && typeof child === 'object') walk(child);
      }
    };
    walk(fn.body);result={calls,members,strings,variables,params:fn.params};
  } catch { /* An opaque method cannot prove this private contract. */ }
  parsedMethods.set(value,result);return result;
}
function delegatesNetwork(Constructor,name) {
  const info=inspectMethod(Constructor,name);if(!info)return false;
  const guard=info.calls.find(call=>call.path==='this.assertAllowed');
  const calls=info.calls.filter(call=>call.path?.endsWith('.net.'+name));
  if(!guard||calls.length!==1||guard.start>=calls[0].start||info.params[0]?.type!=='Identifier')return false;
  const input=info.params[0].name, same=node=>node?.type==='Identifier'&&node.name===input;
  let argument=calls[0].args[0];
  if(!same(argument)&&argument?.type==='Identifier')argument=info.variables.get(argument.name);
  const normalizedUrl=argument?.type==='ConditionalExpression'&&argument.test.type==='BinaryExpression'&&argument.test.operator==='instanceof'
    &&same(argument.test.left)&&argument.test.right.type==='Identifier'&&argument.test.right.name==='URL'
    &&memberPath(argument.consequent)?.join('.')===input+'.href'&&same(argument.alternate);
  return (same(argument)||name==='fetch'&&normalizedUrl)
    &&(info.params.length<2||info.params[1]?.type==='Identifier'&&calls[0].args[1]?.type==='Identifier'&&calls[0].args[1].name===info.params[1].name);
}
function writesJsonl(Constructor) {
  const info=inspectMethod(Constructor,'send');if(!info)return false;
  const writes=info.calls.filter(call=>call.path==='this.proc.stdin.write');
  if(writes.length!==1||!info.members.includes('this.readyState')||!info.calls.some(call=>call.path==='this.ioStatsTracker.trackWritten'))return false;
  let line=writes[0].args[0];if(line?.type==='Identifier')line=info.variables.get(line.name);
  const suffix=line?.right?.type==='Literal'?line.right.value:line?.right?.type==='TemplateLiteral'&&!line.right.expressions.length?line.right.quasis[0].value.cooked:null;
  const input=info.params[0]?.type==='Identifier'?info.params[0].name:null;
  return !!input&&(line?.type==='BinaryExpression'&&line.operator==='+'&&line.left.type==='Identifier'&&line.left.name===input&&suffix==='\n'
    ||line?.type==='TemplateLiteral'&&line.expressions.length===1&&line.expressions[0].type==='Identifier'&&line.expressions[0].name===input
      &&line.quasis[0].value.cooked===''&&line.quasis[1].value.cooked==='\n');
}
function supportsRole(Constructor, role, recorded = false) {
  if (typeof Constructor !== 'function' || !Constructor.prototype) return false;
  const names = recorded ? ({network:['fetch','request'],fetch:['performDesktopFetch'],stdio:['send'],connection:['routeIncomingMessage']})[role] : required[role];
  if (!names?.every(name => method(Constructor, name))) return false;
  if (recorded) return true;
  // Inspect the methods that this integration delegates to, rather than the
  // whole bundle or minified class name. Native still performs its own policy,
  // authentication and cancellation before the scoped final network calls.
  if (role === 'network') return delegatesNetwork(Constructor,'fetch')&&delegatesNetwork(Constructor,'request');
  if (role === 'fetch') {
    const fetch=inspectMethod(Constructor,'performDesktopFetch'),progress=inspectMethod(Constructor,'performProgressRequest');
    return ['this.options.applicationNetwork.fetch','this.options.applicationNetwork.assertAllowed','this.performProgressRequest']
      .every(path=>fetch?.calls.some(call=>call.path===path))&&progress?.calls.some(call=>call.path==='this.options.applicationNetwork.request')===true;
  }
  if (role === 'stdio') return writesJsonl(Constructor);
  if (role === 'connection') {
    const info=inspectMethod(Constructor,'routeIncomingMessage');
    return !!info&&info.strings.includes('account/updated')&&info.members.some(path=>path?.endsWith('.params.authMode'))
      &&info.calls.some(call=>call.path==='this.clearAuthTokenCache');
  }
  return false;
}
function sourceCandidates(record, profiles, expectedHashes) {
  const candidates = [];
  const add = (role, binding, recorded, read) => candidates.push({role, binding, recorded,
    read:read ?? (() => record.evaluate(binding)), resolved:null});
  if (Object.hasOwn(expectedHashes, record.name) && record.hash === expectedHashes[record.name]) {
    const profile = profiles[record.name] ?? {kind:record.name.startsWith('bootstrap-')?'bootstrap':record.name.startsWith('main-')?'main':'src',
      symbol:record.name.startsWith('bootstrap-')?'Pt':record.name.startsWith('main-')?'wEe':'mQ'};
    if (profile.kind === 'bootstrap') { add('network', profile.symbol, true); if (profile.connectionSymbol) add('connection', profile.connectionSymbol, true); }
    else if (profile.kind === 'main') add('fetch', profile.symbol, true);
    else if (profile.kind === 'stdio') add('stdio', profile.symbol, true);
    else if (profile.kind === 'connection') add('connection', profile.symbol, true);
    else {
      add('stdio', profile.symbol, true);
      add('connection', profile.managerExport ?? 'un', true, () => Object.getOwnPropertyDescriptor(record.exported ?? {}, profile.managerExport ?? 'un')?.value);
    }
    return candidates;
  }
  for (const description of (Array.isArray(record.classes) ? record.classes : []).slice(0, 1024)) {
    if (!identifier(description.binding) || !Array.isArray(description.methods)) continue;
    for (const [role, names] of Object.entries(required)) if (names.every(name => description.methods.includes(name))) add(role, description.binding, false);
  }
  return candidates;
}
module.exports = { sourceCandidates, supportsRole, required };
