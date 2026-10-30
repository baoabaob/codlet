import { createNativeManagerRpc } from './desktop/native-manager-rpc.js';
// Discover only objects already owned by the mounted Desktop. Never bootstrap a
// new connection, evaluate source text, or use a version number as an ABI test.
const fail = (code, message) => Object.assign(new Error(message), { code });
export function desktopDocument() {
  if (location.origin !== 'app://-' || location.pathname !== '/index.html')
    throw fail('desktop_document_unsupported', 'This is not a Desktop document');
}
// Native owns these finite linked structures. Cycles terminate traversal;
// component depth and hook count are not compatibility contracts.
export function* linkedNodes(first, next = value => value.next) {
  const seen = new Set();
  for(let value=first;value&&!seen.has(value);value=next(value)) { seen.add(value);yield value; }
}
export function classicNavigationItem(fiber) {
  const props = fiber.memoizedProps;
  return component(fiber.type) && ['sidebar-new-chat', 'sidebar-tasks', 'sidebar-plugins', 'sidebar-library'].includes(props?.animatedIcon) &&
    props.label != null && props.icon != null && typeof props.onClick === 'function' &&
    ['sidebar-item', 'animatedIcon', 'isActive'].every(marker => componentSource(fiber.type).includes(marker));
}
export function hostFibers() {
  const root = document.getElementById('root');
  const key = root && Object.keys(root).find(key => key.startsWith('__reactContainer$'));
  const container = key && root[key], current = container?.stateNode?.current ?? container;
  // AppScope and the router belong to the native shell above its navigation.
  // Inspect that ownership chain, not the rendered messages or other panes.
  const rails = root ? [...root.querySelectorAll?.('nav[data-app-navigation-rail="true"]') ?? []] : [];
  const landmarks = rails.length ? rails : root ? [...root.querySelectorAll?.('nav') ?? []].filter(nav =>
    [...nav.querySelectorAll('button.sidebar-item')].some(button => {
      if (button.closest('nav') !== nav || button.closest('[data-codlet-native-navigation]')) return false;
      const key = Object.keys(button).find(key => key.startsWith('__reactFiber$')), attached = key && button[key];
      return [attached, attached?.alternate].some(start => [...linkedNodes(start, fiber => fiber.return)].some(classicNavigationItem));
    })) : [];
  if (landmarks.length > 1) throw fail('desktop_host_drift', 'Native navigation ownership is ambiguous');
  if (landmarks.length === 1) {
    const landmark = landmarks[0], attachedKey = Object.keys(landmark).find(key => key.startsWith('__reactFiber$'));
    const attached = attachedKey && landmark[attachedKey];
    for (const start of [attached, attached?.alternate]) {
      if (!start || start.stateNode !== landmark) continue;
      const chain = currentAncestry(start, current);
      if (chain) return chain;
    }
    throw fail('desktop_host_pending', 'Waiting for the current native navigation tree');
  }
  // Auxiliary documents and cold startup have no navigation landmark.
  const pending = [current], seen = new Set();
  while (pending.length) {
    const fiber = pending.pop();
    if (!fiber || seen.has(fiber)) continue;
    seen.add(fiber);
    if (fiber.sibling) pending.push(fiber.sibling);
    if (fiber.child) pending.push(fiber.child);
  }
  return seen;
}

// Verify a captured provider against the current root without visiting its
// descendants. React can reuse a child whose return points at the alternate;
// checking both parents' actual child links handles that case and rejects a
// detached provider even when its stale return chain still reaches the root.
export function currentAncestry(fiber, current) {
  if(!fiber||!current)return null;
  const pending = [{ fiber }], queued = new Set([fiber]), children = new Map();
  // A commit may reuse children whose return links still name the previous
  // parent. Prove each edge in either parent's child list, then follow the
  // proven current branch. Cache sibling proofs so shared ancestors are read
  // once, without visiting message descendants or imposing a shell depth.
  const owns=(parent,child)=>{
    let scan=children.get(parent);
    if(!scan){scan={next:parent.child,seen:new Set()};children.set(parent,scan);}
    while(!scan.seen.has(child)&&scan.next&&!scan.seen.has(scan.next)){
      const candidate=scan.next;scan.seen.add(candidate);scan.next=candidate.sibling;
    }
    return scan.seen.has(child);
  };
  for (let index = 0; index < pending.length; index++) {
    const entry = pending[index], child = entry.fiber;
    if (child === current) {
      const chain = new Set();
      for (let item = entry; item; item = item.previous) chain.add(item.fiber);
      return chain;
    }
    for (const parent of new Set([child.return, child.return?.alternate])) {
      if (!parent||queued.has(parent)||!owns(parent,child)) continue;
      queued.add(parent);pending.push({fiber:parent,previous:entry});
    }
  }
  return null;
}

export function currentElementAncestry(element, root = document.getElementById('root')) {
  const key = root && Object.keys(root).find(key => key.startsWith('__reactContainer$'));
  const container = key && root[key], current = container?.stateNode?.current ?? container;
  const attachedKey = element && Object.keys(element).find(key => key.startsWith('__reactFiber$'));
  const attached = attachedKey && element[attachedKey];
  if (!current) return null;
  for (const fiber of [attached, attached?.alternate]) if (fiber?.stateNode === element) {
    const chain = currentAncestry(fiber, current); if (chain) return [...chain].reverse();
  }
  return null;
}

export function createScopeLocator(token, fibers = hostFibers()) {
  const root = document.getElementById('root');
  const key = root && Object.keys(root).find(key => key.startsWith('__reactContainer$'));
  const container = key && root[key];
  const owners = [...fibers].filter(fiber => {
    const chain = fiber.memoizedProps?.value, node = chain instanceof Map && chain.get(token?.id);
    return token && node?.token === token && node?.store && node.familyBindings instanceof Map;
  });
  const nodes = new Set(owners.map(fiber => fiber.memoizedProps.value.get(token.id)));
  if (nodes.size > 1) throw fail('desktop_scope_ambiguous', 'Desktop AppScope has multiple owners');
  if (!owners.length) throw fail('desktop_scope_missing', 'Desktop AppScope is not mounted; reload the adapter after Desktop is ready');
  // Prefer the outermost matching provider so route/sidebar replacement does
  // not retire an app-wide connection inherited by those inner providers.
  const depth = fiber => [...linkedNodes(fiber,value=>value.return)].length;
  owners.sort((a, b) => depth(a) - depth(b));
  const node = [...nodes][0];
  return () => {
    if (document.getElementById('root') !== root || root[key] !== container)
      throw fail('desktop_scope_missing', 'Desktop AppScope root was replaced');
    const current = container?.stateNode?.current ?? container;
    for (const owner of owners) for (const fiber of [owner, owner.alternate]) {
      if (!currentAncestry(fiber, current)) continue;
      const chain = fiber.memoizedProps?.value, present = chain instanceof Map && chain.get(token.id);
      if (present?.token !== token) continue;
      if (present !== node) throw fail('desktop_connection_replaced', 'Desktop AppScope was replaced');
      return { chain, node };
    }
    throw fail('desktop_scope_missing', 'Desktop AppScope is no longer mounted');
  };
}
export function loadedAsset(role) {
  desktopDocument();
  if (!['shared', 'initial'].includes(role)) throw fail('desktop_asset_invalid', 'Unknown native module role');
  const pattern = new RegExp('^app://-/assets/app-' + role + '-[A-Za-z0-9_-]+\\.js$');
  // Static imports need not have modulepreload elements. The current document's
  // script resource entries also identify modules Native actually requested;
  // fetching source text alone must not introduce a module candidate.
  const resources = globalThis.performance?.getEntriesByType?.('resource') ?? [];
  const urls = [
    ...Array.from(document.querySelectorAll('link[rel="modulepreload"]'), item => item.href),
    ...Array.from(document.scripts ?? []).filter(item => item.type === 'module').map(item => item.src),
    ...resources.filter(item => item.initiatorType === 'script').map(item => item.name),
  ];
  const candidates = [...new Set(urls.filter(url => pattern.test(url)))];
  if (candidates.length !== 1) throw fail(candidates.length ? 'desktop_asset_ambiguous' : 'ui_host_pending', `A unique loaded Desktop ${role} module is required`);
  return candidates[0];
}
export function localConnection() {
  desktopDocument();
  const fibers = hostFibers();
  const nodes = new Set(), matches = new Map();
  for (const fiber of fibers) {
    const chain = fiber.memoizedProps?.value;
    if (!(chain instanceof Map)) continue;
    for (const node of chain.values()) {
      if (!node?.token || chain.get(node.token.id) !== node || !(node.familyBindings instanceof Map) || nodes.has(node)) continue;
      nodes.add(node);
      const bound = [];
      for (const [family, bindings] of node.familyBindings) {
        if (family?.scope !== node.token || typeof family.read !== 'function' || !(bindings instanceof Map) || !bindings.has('local')) continue;
        // read is called only on a family with an existing local binding.
        const value = family.read(node, chain, 'local');
        bound.push({ family, value, bindings, binding: bindings.get('local') });
      }
      for (const { family: managerFamily, value: manager } of bound) {
        if (typeof manager?.getHostId !== 'function' || manager.getHostId() !== 'local' || typeof manager.getConversation !== 'function') continue;
        const client = manager.requestClient;
        const clients = bound.filter(item => item.value === client && typeof client?.sendRequest === 'function' &&
          typeof client.getAppServerVersion === 'function' && typeof client.setAppServerVersion === 'function' && client.requestPromises instanceof Map);
        if (clients.length !== 1) continue;
        const previous = matches.get(manager);
        if (previous && (previous.node !== node || previous.clientFamily !== clients[0].family))
          throw fail('desktop_scope_ambiguous', 'Desktop connection has multiple owners');
        matches.set(manager, { node, chain, managerFamily, clientFamily: clients[0].family, manager, client });
      }
      const clients = bound.filter(({ value }) => typeof value?.sendRequest === 'function' &&
        typeof value.getAppServerVersion === 'function' && typeof value.setAppServerVersion === 'function' && value.requestPromises instanceof Map);
      for (const item of bound) {
        const state = item.value, hostClient = state?.client;
        // This is Native's existing HostClient resource, not an arbitrary RPC
        // proxy matched by method names (its every property can be callable).
        if (state?.status !== 'ready' || hostClient?.hostId !== 'local' || typeof hostClient.rpc !== 'function' || clients.length !== 1 || clients[0].value.hostId !== 'local') continue;
        const clientItem = clients[0], client = clientItem.value;
        const previous = matches.get(hostClient.rpc);
        if (previous) {
          if (previous.node !== node || previous.managerFamily !== item.family || previous.clientFamily !== clientItem.family)
            throw fail('desktop_scope_ambiguous', 'Native manager RPC has multiple owners');
          continue;
        }
        matches.set(hostClient.rpc, { node, chain, managerFamily: item.family, clientFamily: clientItem.family,
          hostClient, rpc: hostClient.rpc, managerBinding: item.binding, clientBinding: clientItem.binding, client });
      }
    }
  }
  if (matches.size !== 1) throw fail(matches.size ? 'desktop_scope_ambiguous' : 'desktop_connection_not_ready', 'A unique existing local Desktop connection is required');
  const connection = [...matches.values()][0], locate = createScopeLocator(connection.node.token, fibers);
  connection.check = () => {
    desktopDocument();
    const { node, chain } = locate(), { managerFamily, clientFamily, manager, client } = connection;
    if (connection.rpc && manager?.error) throw manager.error;
    const managerBindings = node.familyBindings.get(managerFamily), clientBindings = node.familyBindings.get(clientFamily);
    const managerCurrent = managerBindings?.has('local') && managerFamily.read(node, chain, 'local');
    const clientCurrent = clientBindings?.has('local') && clientFamily.read(node, chain, 'local');
    const current = connection.rpc ? managerBindings?.get('local') === connection.managerBinding && clientBindings?.get('local') === connection.clientBinding &&
      managerCurrent?.status === 'ready' && managerCurrent.client === connection.hostClient && connection.hostClient.rpc === connection.rpc :
      managerCurrent === manager && manager.getHostId() === 'local' && manager.requestClient === client;
    if (!current || clientCurrent !== client)
      throw fail('desktop_connection_replaced', 'The existing local Desktop connection was replaced');
    connection.chain = chain;
    return connection;
  };
  if (connection.rpc) {
    connection.manager = createNativeManagerRpc({rpc: connection.rpc, client: connection.client, check: connection.check});
    connection.ready = connection.manager.ready;
    connection.dispose = () => connection.manager.dispose();
  }
  try { return connection.check(); }
  catch (error) { connection.dispose?.(); throw error; }
}
export const component = value => typeof value === 'function' ||
  [Symbol.for('react.memo'), Symbol.for('react.forward_ref')].includes(value?.$$typeof);
const sourceCache = new WeakMap();
export function componentSource(value) {
  // Native UIKit includes callable proxies whose source inspector rejects its
  // own wrapped value. An unrelated opaque export is not a candidate; the role
  // matcher still requires one positively inspected native component.
  if (value == null || !['function', 'object'].includes(typeof value)) return '';
  if (sourceCache.has(value)) return sourceCache.get(value);
  try {
    const fn = typeof value === 'function' ? value : value?.render ?? value?.type;
    const result = typeof fn === 'function' ? Function.prototype.toString.call(fn) : '';
    sourceCache.set(value, result); return result;
  } catch { sourceCache.set(value, ''); return ''; }
}
export function uniqueExport(module, predicate, role, optional = false) {
  const values = [...new Set(Object.values(module).filter(predicate))];
  if (!values.length && optional) return undefined;
  if (values.length !== 1) throw fail('desktop_contract_drift', `A unique native ${role} is required (found ${values.length})`);
  return values[0];
}
export function uniqueModuleExport(modules, predicate, role, optional = false) {
  const candidates = new Map();
  for (const [url, namespace] of modules) for (const [name, value] of Object.entries(namespace)) {
    if (!predicate(value)) continue;
    const origins = candidates.get(value) ?? [];
    origins.push({ module: url, export: name }); candidates.set(value, origins);
  }
  if (!candidates.size && optional) return undefined;
  if (candidates.size !== 1) {
    const error = fail('desktop_contract_drift', `A unique native ${role} is required (found ${candidates.size})`);
    error.details = { role, candidates: [...candidates].map(([value, origins]) => ({ type: typeof value, origins })) };
    throw error;
  }
  return candidates.keys().next().value;
}
