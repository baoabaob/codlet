import { workspaceError } from './workspace-dom.js';
import { hostFibers, componentSource, linkedNodes } from '../host-discovery.js';
import { navigationSourceExport } from './workspace-source.js';
import { isNativeLocalNavigationDelegate } from './workspace-role-contracts.js';

export function navigationSignalExport(source, options) {
  try { return navigationSourceExport(source, options); }
  catch (error) {
    if (error.code) throw error;
    throw workspaceError('workspace_navigation_unsupported', 'Native navigation source cannot be parsed');
  }
}

export function nativeNavigationScope(connection) {
  const { node } = connection;
  // hA's mounted Native AppScope hook stores its imperative facade in a ref.
  // Inspect only the committed navigation ancestry, independently of editors.
  for (const fiber of hostFibers()) for (const hook of linkedNodes(fiber.memoizedState)) {
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
    if (bridge == null) throw workspaceError('workspace_host_pending', 'Native navigation bridge is not mounted');
    if (!['navigate', 'navigateToLocalConversation', 'prepareNavigation'].every(key => typeof bridge[key] === 'function') ||
        typeof bridge.pathname !== 'string' || typeof bridge.search !== 'string') throw workspaceError('workspace_navigation_unsupported', 'Mounted Native navigation bridge contract changed');
    return bridge;
  };
  current();
  if (typeof dispatch !== 'function' || typeof scope !== 'function') throw workspaceError('workspace_navigation_unsupported', 'Native thread navigation action is unavailable');
  const direct=isNativeLocalNavigationDelegate(componentSource(dispatch));
  return { currentRoute() { const bridge=current();return {pathname:bridge.pathname,search:bridge.search}; }, restoreLocation(location) {
    const bridge=current();
    if(!location||typeof location.pathname!=='string'||!location.pathname.startsWith('/'))throw workspaceError('invalid_argument','Invalid captured Native location');
    if(bridge.navigate({pathname:location.pathname,search:location.search??'',hash:location.hash??'',key:location.key},{replace:true,state:location.state})!==true)
      throw workspaceError('workspace_location_restore_unavailable','Native declined captured page restoration');
  }, openLocalThread(threadId) {
    const bridge = current();
    if(direct){
      if(bridge.navigateToLocalConversation(threadId)!==true)throw workspaceError('workspace_navigation_unavailable','Native declined local task navigation');
      return;
    }
    const facade = scope();
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
