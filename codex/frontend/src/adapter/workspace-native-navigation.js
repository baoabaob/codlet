import { parseExpressionAt } from 'acorn';
import { workspaceError } from './workspace-dom.js';
import { hostFibers } from '../host-discovery.js';

function visit(node, work) {
  if (!node || typeof node !== 'object') return;
  if (node.type) work(node);
  for (const [key, value] of Object.entries(node)) if (!['start', 'end'].includes(key)) {
    if (Array.isArray(value)) value.forEach(item => visit(item, work));
    else if (value && typeof value === 'object') visit(value, work);
  }
}

export function navigationSignalExport(source) {
  const marker = 'AppNavigationSignalBridge is missing', at = source.indexOf(marker);
  if (at < 0 || source.indexOf(marker, at + marker.length) >= 0) throw workspaceError('workspace_navigation_unsupported', 'Native navigation bridge marker is missing or ambiguous');
  const next = /\bfunction\s+[A-Za-z_$][\w$]*\s*\(/.exec(source.slice(at, at + 4096));
  if (!next) throw workspaceError('workspace_navigation_unsupported', 'Native navigation bridge initializer is unavailable');
  const ast = parseExpressionAt(source, at + next.index, { ecmaVersion: 'latest', sourceType: 'module' });
  if (ast.end - ast.start > 32768) throw workspaceError('workspace_navigation_unsupported', 'Native navigation bridge initializer exceeds its boundary');
  const defaults = new Set(), signals = new Set();
  visit(ast, node => {
    if (node.type !== 'AssignmentExpression' || node.left.type !== 'Identifier' || node.right.type !== 'ObjectExpression') return;
    const keys = node.right.properties.map(property => property.key?.name ?? property.key?.value);
    if (keys.length === 3 && ['navigate', 'navigateToLocalConversation', 'prepareNavigation'].every(key => keys.includes(key))) defaults.add(node.left.name);
  });
  visit(ast, node => {
    if (node.type === 'AssignmentExpression' && node.left.type === 'Identifier' && node.right.type === 'CallExpression' &&
        node.right.arguments.length === 2 && node.right.arguments[1].type === 'Identifier' && defaults.has(node.right.arguments[1].name)) signals.add(node.left.name);
  });
  if (signals.size !== 1) throw workspaceError('workspace_navigation_unsupported', 'Native navigation signal is missing or ambiguous');
  const local = [...signals][0], pattern = new RegExp('(?:\\{|,)\\s*' + local.replace(/\$/g, '\\$&') + '\\s+as\\s+([A-Za-z_$][\\w$]*)\\s*(?=,|\\})', 'g');
  const aliases = [...source.slice(source.lastIndexOf('export')).matchAll(pattern)].map(match => match[1]);
  if (aliases.length !== 1) throw workspaceError('workspace_navigation_unsupported', 'Native navigation signal export is missing or ambiguous');
  return aliases[0];
}

export function nativeNavigationScope(connection) {
  const { node } = connection;
  // hA's mounted Native AppScope hook stores its imperative facade in a ref.
  // Inspect only the committed navigation ancestry, independently of editors.
  for (const fiber of hostFibers()) for (let hook = fiber.memoizedState, count = 0; hook && count++ < 128; hook = hook.next) {
    const value = hook.memoizedState?.current;
    if (value?.scope === node.token && value.node === node && value.chain?.get(node.token.id) === node &&
        typeof value.get === 'function' && typeof value.set === 'function') return value;
  }
  throw workspaceError('workspace_host_pending', 'Waiting for the mounted Native AppScope facade');
}

export function createNativeNavigation(signal, connection, dispatch, scope) {
  const current = () => {
    const { node, chain } = connection();
    if (signal?.scope !== node.token || signal.cache !== 'signal' || typeof signal.resolve !== 'function') throw workspaceError('workspace_navigation_unsupported', 'Native navigation signal belongs to a different scope');
    // Read an existing binding only; never resolve an unbound default bridge.
    if (!node.signalBindings?.has(signal)) throw workspaceError('workspace_host_pending', 'Waiting for the mounted Native navigation bridge');
    const bridge = node.store.get(signal.resolve(node, chain));
    if (!bridge || !['navigate', 'navigateToLocalConversation', 'prepareNavigation'].every(key => typeof bridge[key] === 'function') ||
        typeof bridge.pathname !== 'string' || typeof bridge.search !== 'string') throw workspaceError('workspace_host_pending', 'Native navigation bridge is not mounted');
    return bridge;
  };
  current();
  if (typeof dispatch !== 'function' || typeof scope !== 'function') throw workspaceError('workspace_navigation_unsupported', 'Native thread navigation action is unavailable');
  return { restoreLocation(location) {
    const bridge=current();
    if(!location||typeof location.pathname!=='string'||!location.pathname.startsWith('/'))throw workspaceError('invalid_argument','Invalid captured Native location');
    if(bridge.navigate({pathname:location.pathname,search:location.search??'',hash:location.hash??'',key:location.key},{replace:true,state:location.state})!==true)
      throw workspaceError('workspace_location_restore_unavailable','Native declined captured page restoration');
  }, openLocalThread(threadId) {
    const bridge = current(), facade = scope();
    if (!facade || typeof facade.get !== 'function' || typeof facade.set !== 'function') throw workspaceError('workspace_host_pending', 'Native navigation scope is not mounted');
    let accepted = false;
    dispatch(facade, 'local:' + threadId, (id, hostId, options) => {
      if (id !== threadId || hostId != null && hostId !== 'local') throw workspaceError('workspace_navigation_unavailable', 'Native navigation resolved a different local task');
      if (bridge.navigateToLocalConversation(id, hostId, options) !== true) throw workspaceError('workspace_navigation_unavailable', 'Native declined local task navigation');
      accepted = true;
    }, () => { throw workspaceError('workspace_navigation_unsupported', 'Native task requires a different route kind'); }, 'local');
    if (!accepted) throw workspaceError('workspace_navigation_unavailable', 'Native did not dispatch local task navigation');
  } };
}
