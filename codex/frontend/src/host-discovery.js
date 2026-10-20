// Discover only objects already owned by the mounted Desktop. Never bootstrap a
// new connection, evaluate source text, or use a version number as an ABI test.
const fail = (code, message) => Object.assign(new Error(message), { code });
export function desktopDocument() {
  if (location.origin !== 'app://-' || location.pathname !== '/index.html')
    throw fail('desktop_document_unsupported', 'This is not a Desktop document');
}
export function hostFibers(limit = 20000) {
  const root = document.getElementById('root');
  const key = root && Object.keys(root).find(key => key.startsWith('__reactContainer$'));
  const container = key && root[key], current = container?.stateNode?.current ?? container;
  // AppScope and the router belong to the native shell above its navigation.
  // Inspect that ownership chain, not the rendered messages or other panes.
  const rails = root ? [...root.querySelectorAll?.('nav[data-app-navigation-rail="true"]') ?? []] : [];
  const landmarks = rails.length ? rails : root ? [...root.querySelectorAll?.('nav') ?? []].filter(nav =>
    [...nav.querySelectorAll('button.sidebar-item')].some(button => !button.closest('[data-codlet-native-navigation]'))) : [];
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
  // Auxiliary documents and cold startup have no navigation landmark. Their
  // fallback stays bounded; an unknown large tree still fails closed.
  const pending = [current], seen = new Set();
  while (pending.length) {
    const fiber = pending.pop();
    if (!fiber || seen.has(fiber)) continue;
    if (seen.size >= limit) throw fail('desktop_host_drift', 'Desktop tree exceeds the discovery limit');
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
  const pending = [{ fiber, depth: 1 }], seen = new Set(); let links = 0;
  // A commit may reuse children whose return links still name the previous
  // parent. Prove each edge in either parent's child list, then follow the
  // proven current branch. Bounds cover both alternates of a 256-deep shell.
  for (let index = 0; index < pending.length && seen.size < 512; index++) {
    const entry = pending[index], child = entry.fiber;
    if (!child || seen.has(child) || entry.depth > 256) continue;
    if (child === current) {
      const chain = new Set();
      for (let item = entry; item; item = item.previous) chain.add(item.fiber);
      return chain;
    }
    seen.add(child);
    for (const parent of new Set([child.return, child.return?.alternate])) {
      if (!parent) continue;
      const siblings = new Set(); let candidate = parent.child;
      while (candidate && !siblings.has(candidate)) {
        if (++links > 2048) return null;
        if (candidate === child) { pending.push({ fiber: parent, previous: entry, depth: entry.depth + 1 }); break; }
        siblings.add(candidate); candidate = candidate.sibling;
      }
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
  const depth = fiber => { const seen = new Set(); while (fiber && !seen.has(fiber) && seen.size < 256) { seen.add(fiber); fiber = fiber.return; } return seen.size; };
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
  const candidates = [...new Set(Array.from(document.querySelectorAll('link[rel="modulepreload"]'), item => item.href).filter(url => pattern.test(url)))];
  if (candidates.length !== 1) throw fail(candidates.length ? 'desktop_asset_ambiguous' : 'ui_host_pending', `A unique loaded Desktop ${role} module is required`);
  return candidates[0];
}
export function localConnection() {
  desktopDocument();
  const fibers = hostFibers();
  const nodes = new Set(), matches = new Map();
  let metadataEntries = 0, localReads = 0;
  for (const fiber of fibers) {
    const chain = fiber.memoizedProps?.value;
    if (!(chain instanceof Map)) continue;
    for (const node of chain.values()) {
      if (!node?.token || chain.get(node.token.id) !== node || !(node.familyBindings instanceof Map) || nodes.has(node)) continue;
      nodes.add(node);
      if (nodes.size > 256 || (metadataEntries += node.familyBindings.size) > 32768) throw fail('desktop_scope_drift', 'Desktop scope exceeds the discovery limit');
      const bound = [];
      for (const [family, bindings] of node.familyBindings) {
        if (family?.scope !== node.token || typeof family.read !== 'function' || !(bindings instanceof Map) || !bindings.has('local')) continue;
        if (++localReads > 512) throw fail('desktop_scope_drift', 'Desktop local bindings exceed the discovery limit');
        // read is called only on a family with an existing local binding.
        const value = family.read(node, chain, 'local');
        bound.push({ family, value });
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
    }
  }
  if (matches.size !== 1) throw fail(matches.size ? 'desktop_scope_ambiguous' : 'desktop_connection_not_ready', 'A unique existing local Desktop connection is required');
  const connection = [...matches.values()][0], locate = createScopeLocator(connection.node.token, fibers);
  connection.check = () => {
    desktopDocument();
    const { node, chain } = locate(), { managerFamily, clientFamily, manager, client } = connection;
    if (!node.familyBindings.get(managerFamily)?.has('local') || !node.familyBindings.get(clientFamily)?.has('local') ||
        managerFamily.read(node, chain, 'local') !== manager || clientFamily.read(node, chain, 'local') !== client ||
        manager.getHostId() !== 'local' || manager.requestClient !== client)
      throw fail('desktop_connection_replaced', 'The existing local Desktop connection was replaced');
    connection.chain = chain;
    return connection;
  };
  return connection.check();
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
