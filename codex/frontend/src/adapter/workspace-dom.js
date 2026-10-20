import { componentSource, currentElementAncestry } from '../host-discovery.js';
import { inspectNativeInput, inspectNativeComposerScope } from './workspace-native-input.js';

export const workspaceError = (code, message) => Object.assign(new Error(message), { code });
export const OWNED = '[data-codlet-workspace-owned]';
export function ancestry(node, limit = 64) {
  const key = node && Object.keys(node).find(key => key.startsWith('__reactFiber$'));
  const result = []; let fiber = key && node[key];
  for (; fiber && result.length < limit; fiber = fiber.return) result.push(fiber);
  return result;
}
export function providersFor(node) {
  const result = [], seen = new Set();
  const current = currentElementAncestry(node, node?.ownerDocument?.getElementById('root'));
  // currentElementAncestry already returns the closest host first. Selecting
  // an outer value for a repeated Native context can discard its AppScope.
  for (const fiber of current ?? ancestry(node, 180)) {
    let count = 0;
    for (let dep = fiber.dependencies?.firstContext; dep && count++ < 128; dep = dep.next) {
      if (!dep.context || seen.has(dep.context)) continue;
      seen.add(dep.context); result.push([dep.context, dep.memoizedValue]);
    }
    if (fiber.tag === 10 && Object.hasOwn(fiber.memoizedProps ?? {}, 'value')) {
      const context = fiber.type?._context ?? fiber.type;
      if (context && !seen.has(context)) { seen.add(context); result.push([context, fiber.memoizedProps.value]); }
    }
  }
  return result;
}
export const wrapProviders = (native, providers, child) => providers.reduce((child, [type, value]) =>
  native.React.createElement(type, { value }, child), child);
const active = node => node.isConnected && !node.closest(`${OWNED},[data-app-shell-active-page="false"]`);
function one(nodes, role, optional = false) {
  const candidates = [...new Set([...nodes].filter(active))];
  if (!candidates.length && optional) return null;
  if (candidates.length !== 1) throw workspaceError(candidates.length ? 'workspace_host_drift' : 'workspace_host_pending', `A unique native ${role} is required (found ${candidates.length})`);
  return candidates[0];
}
export function findWorkspaceSurface(document, confirmedComposer = null) {
  if (confirmedComposer && (confirmedComposer.ownerDocument !== document || !active(confirmedComposer) ||
      !confirmedComposer.matches('[data-codex-composer-root]') || !document.getElementById('root')?.contains(confirmedComposer)))
    throw workspaceError('workspace_host_drift', 'The confirmed main composer changed ownership');
  const main = confirmedComposer ? confirmedComposer.closest('main[data-app-shell-main-surface]') :
    one(document.querySelectorAll('main[data-app-shell-main-surface]'), 'main surface', true);
  if (confirmedComposer && (!main || !active(main))) throw workspaceError('workspace_host_drift', 'The confirmed composer has no active main surface');
  if (!main) return null;
  const composer = confirmedComposer ?? one(main.querySelectorAll('[data-codex-composer-root]'), 'main composer', true);
  const scroller = composer ? composer.closest('.thread-scroll-container') : one(main.querySelectorAll('.thread-scroll-container'), 'thread scroller', true);
  if (scroller && !main.contains(scroller)) throw workspaceError('workspace_host_drift', 'The main thread scroller changed ownership');
  // Native home has an explicit composer placement and no thread scroll/footer.
  // Its composer root includes the input and utility controls. Keep that exact
  // region as its footer; do not manufacture a thread footer or move the input.
  const home = !!composer?.matches('[data-composer-placement="home"]') && !scroller;
  const content = scroller?.closest('[data-includes-composer]') ?? (home ? composer.closest('[data-app-shell-main-content-layout]') ?? main :
    !composer ? one(main.querySelectorAll('[data-app-shell-main-content-layout]'), 'main content layout', true) ?? main : null);
  const footer = home ? composer : composer?.closest('[data-thread-scroll-footer]') ?? null;
  if (composer && (!content || !content.contains(composer) || !footer || !home && (!scroller || !scroller.contains(footer))))
    throw workspaceError('workspace_host_drift', 'The thread body and composer footer no longer match the workspace contract');
  const header = one(document.querySelectorAll('[data-app-shell-main-titlebar]'), 'main titlebar', true);
  const rightPanel = one(document.querySelectorAll('aside[data-app-shell-focus-area="right-panel"]'), 'right resource panel', true);
  const floatingContent = [...main.querySelectorAll('[class*="--thread-floating-content-top-inset"][class*="--thread-floating-content-bottom-inset"]')].filter(active);
  let contentMotion = null;
  for (const fiber of composer ? currentElementAncestry(composer, document.getElementById('root')) ?? [] : []) {
    const props = fiber.memoizedProps, text = componentSource(fiber.type);
    if (text.includes('floatingContent') && text.includes('contentX') && text.includes('LocalConversationPage') &&
        typeof props?.contentX?.get === 'function' && typeof props.contentX.on === 'function') contentMotion = props.contentX;
  }
  return { main, composer, content, scroller, footer, header, rightPanel, floatingContent, contentMotion };
}

// Native scroll layout keeps its original width while contentX moves its
// centred body/footer by half a reserved side region. Read that live motion;
// no panel width or transform offset is baked into the consumer contract.
export function workspaceBodyGeometry(document, surface, baseRect) {
  const base = surface?.scroller ?? surface?.content ?? surface?.main;
  if (!base) return { bodyViewport: null, floatingContent: Object.freeze([]) };
  const bounds = baseRect ?? base.getBoundingClientRect(), regions = [], visible = [];
  for (const element of surface.floatingContent ?? []) {
    const rect = element.getBoundingClientRect(), style = document.defaultView.getComputedStyle(element);
    const shown = style.display !== 'none' && style.visibility === 'visible' && !element.closest('[inert],[aria-hidden="true"]') && rect.width > 0 && rect.height > 0;
    const node = geometry(element,rect); regions.push(Object.freeze({ ...node, visible: shown }));
    if (shown) visible.push(rect);
  }
  let left = bounds.left, right = bounds.right;
  const shift = surface.contentMotion?.get();
  if (Number.isFinite(shift)) {
    if (shift < 0) right = Math.max(left, right + shift * 2);
    else if (shift > 0) left = Math.min(right, left + shift * 2);
  }
  // Inline floating regions also occupy the outer gutter when no translation
  // is needed. Only carve rectangles touching an edge of this Native body.
  for (const rect of visible) if (rect.bottom > bounds.top && rect.top < bounds.bottom) {
    if (rect.right >= bounds.right - 1 && rect.left > bounds.left) right = Math.min(right, rect.left);
    else if (rect.left <= bounds.left + 1 && rect.right < bounds.right) left = Math.max(left, rect.right);
  }
  const rect = Object.freeze({ x:left, y:bounds.top, width:Math.max(0,right-left), height:bounds.height, top:bounds.top, right, bottom:bounds.bottom, left });
  return { bodyViewport:Object.freeze({rect}), floatingContent:Object.freeze(regions) };
}
export function findActivity(document) {
  const matches = [];
  for (const button of document.querySelectorAll('#root button')) {
    if (!active(button) || button.closest('main')) continue;
    const owner = ancestry(button, 24).find(fiber => {
      const props = fiber.memoizedProps ?? {};
      if (props.description?.props?.id === 'sidebarElectron.priorityThreads.coachmark.description' &&
          props.title?.props?.id === 'sidebarElectron.priorityThreads.filterByPriority' &&
          props.children?.props?.['aria-label'] === button.getAttribute('aria-label')) return true;
      const source = componentSource(fiber.type);
      return source.includes('sidebarElectron.priorityThreads.coachmark.description') && source.includes('onActivate') && source.includes('needsAttention');
    });
    if (owner) matches.push(button);
  }
  return one(matches, 'activity control', true);
}
export function activityPlacement(button) {
  if (!button?.isConnected) return null;
  const chain = currentElementAncestry(button) ?? ancestry(button, 48);
  const owner = chain.find(fiber => {
    const source = componentSource(fiber.type);
    return source.includes('sidebarElectron.priorityThreads.coachmark.description') && source.includes('onActivate') && source.includes('needsAttention');
  });
  if (!owner) throw workspaceError('workspace_host_drift', 'Native activity ownership changed');
  let anchor = button;
  for (const fiber of chain) {
    if (fiber === owner) break;
    const node = fiber.stateNode;
    if (node?.nodeType === 1 && node.contains(button)) anchor = node;
  }
  return { button, anchor, parent: anchor.parentElement };
}

export function composerBinding(document, composer, native) {
  if (!composer?.isConnected || composer.closest(OWNED)) return null;
  return nativeComposerBinding(composer, document.getElementById('root'), native);
}
export function nativeComposerBinding(composer, root, native) {
  if (!native?.composerScope || !native.ThreadScope || !native.RouteScope) return null;
  return nativeInputBinding(inspectNativeInput(native, composer, root), native);
}
export function nativeInputBinding(value, native) {
  if (!native?.composerScope || !native.ThreadScope || !native.RouteScope || !value?.input.isConnected) return null;
  const scope = value.scope;
  if (!scope || scope.value?.kind !== 'local' || typeof scope.value.conversationId !== 'string' || typeof scope.getOwnValue !== 'function') return null;
  const threadNode = scope.chain?.get(native.ThreadScope.id), routeNode = scope.chain?.get(native.RouteScope.id);
  if (threadNode?.token !== native.ThreadScope || routeNode?.token !== native.RouteScope || scope.chain?.get(native.composerScope.id) !== scope.node) return null;
  const threadValue = scope.getOwnValue(native.ThreadScope), routeValue = scope.getOwnValue(native.RouteScope);
  if (threadValue?.clientThreadId !== scope.value.clientThreadId || routeValue?.conversationId !== scope.value.conversationId ||
      threadValue?.hostId != null && threadValue.hostId !== 'local' || scope.value.hostId != null && scope.value.hostId !== 'local')
    throw workspaceError('workspace_composer_binding_drift', 'Native thread, route and input model disagree');
  return { ...value, threadId: scope.value.conversationId, clientThreadId: scope.value.clientThreadId,
    hostId: 'local', scopeNode: scope.node, scopeValue: scope.node.value, threadNode, threadValue, routeNode, routeValue };
}
export function nativeMainInput(document, native, diagnose) {
  const root = document.getElementById('root'); if (!root) return null;
  const inputs = [...root.querySelectorAll('[data-codex-composer-root]')].filter(input => !input.closest(OWNED + ',[data-app-shell-active-page="false"]'));
  const candidates = [], currentRoute = native?.currentRoute?.();
  for (const input of inputs) {
    if (currentRoute) {
      const scope = inspectNativeComposerScope(native, currentElementAncestry(input, root) ?? []);
      const route = scope?.getOwnValue?.(native.RouteScope);
      // Retained Native pages keep valid editor/controllers while inactive.
      // Only the route owned by the live navigation bridge is the main input.
      if (!route || route.pathname !== currentRoute.pathname || (route.search ?? '') !== currentRoute.search) continue;
    }
    const value = inspectNativeInput(native, input, root, undefined, diagnose); if (!value) continue;
    if (value.scope.value?.placement === 'main' || value.scope.value?.kind === 'new' && value.scope.value.entrypoint === 'home') candidates.push(value);
  }
  if (candidates.length > 1) throw workspaceError('workspace_composer_binding_drift', 'Native main input is ambiguous');
  if (!candidates.length && inputs.length) throw workspaceError('workspace_host_pending', 'Native main input ownership is not ready');
  return candidates[0] ?? null;
}
export function resolveThreadReference(document, element, isCachedLocal = () => false) {
  if (!(element instanceof document.defaultView.Element) || element.ownerDocument !== document || !active(element) || element.closest('main')) return null;
  const title = element.closest('[data-thread-title]');
  if (!title) return null;
  const found = new Map();
  for (const fiber of ancestry(title, 32)) {
    const props = fiber.memoizedProps ?? {};
    const values = [props, props.thread, props.conversation, props.item, props.threadKey];
    for (const value of values) {
      if (!value || typeof value !== 'object') continue;
      const id = value.conversationId ?? value.threadId ?? (value === props ? null : value.id);
      if (typeof id !== 'string' || !/^[\w-]{8,256}$/.test(id)) continue;
      if (value.hostId != null && value.hostId !== 'local' || value.kind != null && !['local', 'codex'].includes(value.kind) || props.itemKind != null && props.itemKind !== 'local') return null;
      if (value.hostId !== 'local' && !['local', 'codex'].includes(value.kind) && props.itemKind !== 'local' && !isCachedLocal(id)) continue;
      found.set(id, { threadId: id, hostId: 'local' });
    }
    if (found.size) break;
  }
  return found.size === 1 ? [...found.values()][0] : null;
}
/** Interpret a Native sidebar gesture without exposing its private row/control
 * selectors to consumers. Embedded buttons and Codlet-owned surfaces keep their
 * original handlers; the Native row button itself remains a task interaction. */
export function resolveThreadInteraction(document, element, isCachedLocal) {
  if (!(element instanceof document.defaultView.Element) || element.ownerDocument !== document ||
      element.closest(OWNED + ',[data-codlet-official-ui],[data-codlet-native-navigation]')) return null;
  const row = element.closest('[data-thread-title]');
  const control = element.closest('button,[role="button"],[role="menu"],input,textarea,select,[contenteditable]:not([contenteditable="false"])');
  if (control && (!row || !control.contains(row))) return null;
  return resolveThreadReference(document, element, isCachedLocal);
}
export function hasBlockingOverlay(document, target) {
  const selector = '[role="dialog"],[role="menu"],[role="listbox"]';
  if (target instanceof document.defaultView.Element && target.ownerDocument === document && target.closest(selector)) return true;
  return [...document.querySelectorAll(selector)].some(element => {
    if (!element.isConnected || element.closest('[hidden],[inert],[aria-hidden="true"]')) return false;
    const style = document.defaultView.getComputedStyle(element);
    return style.display !== 'none' && style.visibility !== 'hidden' && element.getClientRects().length > 0;
  });
}
export function geometry(element, captured) {
  if (!element) return null;
  const rect = captured ?? element.getBoundingClientRect();
  return Object.freeze({ element, rect: Object.freeze(Object.fromEntries(['x', 'y', 'width', 'height', 'top', 'right', 'bottom', 'left'].map(key => [key, rect[key]]))) });
}
const optionDefaults = Object.freeze({ hideBody: false, hideHeader: false, hideComposer: false, composerEnabled: true, rightPanelEnabled: true });
export function surfaceOptions(options, previous = optionDefaults) {
  if (!options || typeof options !== 'object' || Array.isArray(options) || Object.keys(options).some(key => !(key in optionDefaults) || typeof options[key] !== 'boolean'))
    throw workspaceError('invalid_argument', 'Invalid surface lease options');
  return { ...previous, ...options };
}
// Journal individual properties, not complete style attributes. Multiple owners
// compose in one pass; a later unrelated page patch keeps its own value.
export function createSurfaceControl() {
  const leases = new Set(), journal = new Map();
  const read = (node, key) => key === 'visibility' ? [node.style.getPropertyValue(key), node.style.getPropertyPriority(key)] : node.getAttribute(key);
  const write = (node, key, value) => {
    if (key === 'visibility') { if (value[0]) node.style.setProperty(key, ...value); else node.style.removeProperty(key); }
    else if (value == null) node.removeAttribute(key); else node.setAttribute(key, value);
  };
  const equal = (a, b) => Array.isArray(a) ? a[0] === b?.[0] && a[1] === b?.[1] : a === b;
  function reconcile(surface) {
    const desired = new Map();
    function suppress(node, hidden, disabled) {
      if (!node || !hidden && !disabled) return;
      const fields = desired.get(node) ?? new Map(); desired.set(node, fields);
      if (hidden) fields.set('visibility', ['hidden', 'important']);
      if (hidden || disabled) { fields.set('inert', ''); fields.set('aria-hidden', 'true'); }
    }
    if (surface?.composer) for (const lease of leases) {
      if (lease.options.hideBody) {
        const protectedNodes=[surface.composer,surface.footer,surface.header,surface.rightPanel,...surface.floatingContent??[]].filter(Boolean);
        const bodyNode=node=>!node.matches(OWNED)&&!protectedNodes.some(region=>region===node||node.contains(region));
        if(surface.scroller)for(const node of surface.scroller.children){if(bodyNode(node))suppress(node,true,true);}
        else if(surface.content?.contains(surface.composer)){
          // Hide only siblings along the home input's ancestry. Its controller,
          // attachments and controls stay under their original Native parents.
          let child=surface.composer,depth=0;
          while(child!==surface.content){
            const parent=child.parentElement;
            if(!parent||depth++>=32)throw workspaceError('workspace_host_drift','The home composer branch exceeds the surface boundary');
            for(const node of parent.children)if(node!==child&&bodyNode(node))suppress(node,true,true);
            child=parent;
          }
        }
      }
      suppress(surface.header, lease.options.hideHeader, false);
      suppress(surface.footer, lease.options.hideComposer, !lease.options.composerEnabled);
      suppress(surface.composer, false, !lease.options.composerEnabled);
      suppress(surface.rightPanel, false, !lease.options.rightPanelEnabled);
    }
    for (const [node, fields] of journal) {
      for (const [key, entry] of fields) if (!desired.get(node)?.has(key)) {
        if (equal(read(node, key), entry.applied)) write(node, key, entry.original);
        fields.delete(key);
      }
      if (!fields.size) journal.delete(node);
    }
    for (const [node, fields] of desired) for (const [key, value] of fields) {
      const current = read(node, key); let saved = journal.get(node);
      if (!saved) { saved = new Map(); journal.set(node, saved); }
      let entry = saved.get(key);
      if (!entry) { entry = { original: current, applied: value }; saved.set(key, entry); }
      else if (!equal(current, entry.applied)) entry.original = current;
      if (!equal(current, value)) write(node, key, value);
      entry.applied = value;
    }
  }
  return { leases, reconcile, dispose() { leases.clear(); reconcile(null); } };
}
