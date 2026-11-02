import { componentSource, currentElementAncestry, linkedNodes } from '../host-discovery.js';
import { workspaceError } from './workspace-dom.js';

const controllerMethods = ['getScrollElement', 'getLastScrollDistanceFromBottomPx', 'shouldFollowContentGrowth', 'holdViewport', 'scrollToBottom', 'scrollToDistanceFromBottomPx', 'compensateScrollToDistanceFromBottomPx', 'addUserScrollListener'];
const isController = value => value && controllerMethods.every(name => typeof value[name] === 'function');
const isVirtualizer = value => value && typeof value.getEntryGeometry === 'function' && typeof value.scrollToKey === 'function';
const error = (code, message) => workspaceError('workspace_scroll_' + code, message);

// Use the controller read by this Native transcript, not the main window's
// captured scroll context. React may replace the context value during a commit.
export function nativeTranscriptScrollBinding({mount, body, scroll, threadId, ancestry = currentElementAncestry}) {
  const chain = ancestry(body, mount);
  if (!mount.isConnected || !body.isConnected || !mount.contains(body) || !chain)
    throw error('owner_changed', 'The Native transcript scroll owner retired');
  const readings = [], owners = [];
  for (const [index, fiber] of chain.entries()) {
    const props = fiber.memoizedProps;
    if (props?.conversationId === threadId && componentSource(fiber.type).includes('getVirtualizedTurnListApi')) owners.push(fiber);
    for (const dependency of linkedNodes(fiber.dependencies?.firstContext)) {
      const controller = dependency.memoizedValue, context = dependency.context;
      if (!context || !isController(controller) || controller.getScrollElement() !== scroll) continue;
      // A repeated outer provider is not this consumer's lexical owner, even
      // when both providers currently carry the identical controller value.
      const owner = chain.slice(index + 1).find(fiber => fiber.tag === 10 && (fiber.type?._context ?? fiber.type) === context);
      if (!owner || owner.memoizedProps?.value !== controller) throw error('unavailable', 'The Native transcript scroll provider changed');
      readings.push({controller, owner});
    }
  }
  const controllers = new Set(readings.map(value => value.controller));
  if (controllers.size !== 1) throw error('unavailable', 'A unique Native controller for this transcript scroller is required');
  const {controller, owner} = readings[0];
  return {controller, owner, virtualizer() {
    const candidates = new Set();
    for (const owner of owners) for (const hook of linkedNodes(owner.memoizedState)) {
      const value = hook.memoizedState?.current;
      if (isVirtualizer(value)) candidates.add(value);
    }
    if (candidates.size !== 1) throw error('unavailable', 'The Native transcript virtualization owner is unavailable');
    return [...candidates][0];
  }};
}

export function transcriptScrollPosition(value) {
  if (!value || typeof value !== 'object' || Array.isArray(value) || Object.keys(value).some(key => !['top', 'left', 'followingLatest', 'anchor'].includes(key)) ||
      !Number.isFinite(value.top) || !Number.isFinite(value.left) || value.followingLatest !== undefined && typeof value.followingLatest !== 'boolean')
    throw workspaceError('invalid_argument', 'Invalid transcript scroll position');
  if (value.anchor !== undefined) {
    const anchor = value.anchor;
    if (!anchor || typeof anchor !== 'object' || Array.isArray(anchor) || Object.keys(anchor).some(key => !['turnKey', 'unitKey', 'offset'].includes(key)) ||
        typeof anchor.turnKey !== 'string' || !anchor.turnKey || typeof anchor.unitKey !== 'string' || !anchor.unitKey || !Number.isFinite(anchor.offset))
      throw workspaceError('invalid_argument', 'Invalid transcript reading anchor');
  }
  return {...value, ...(value.anchor ? {anchor:{...value.anchor}} : {})};
}

export function createTranscriptScroll({mount, body, scroll, threadId, check, report = () => {}, binding = nativeTranscriptScrollBinding}) {
  let pending = null, disposed = false;
  const owned = () => {
    check();
    if (disposed) throw error('retired', 'Transcript scrolling retired');
    return binding({mount, body, scroll, threadId});
  };
  const current = operation => {
    if (pending !== operation || operation.abort.signal.aborted) throw error('cancelled', 'Transcript scrolling was interrupted');
    const next = owned();
    const sameOwner = next.owner === operation.owner || next.owner?.alternate === operation.owner || operation.owner?.alternate === next.owner;
    if (!sameOwner || controllerMethods.some(name => next.controller[name] !== operation.controller[name])) throw error('owner_changed', 'The Native transcript scroll controller changed');
    return next;
  };
  const scale = () => {
    const rect = scroll.getBoundingClientRect(), style = scroll.ownerDocument.defaultView.getComputedStyle(scroll);
    // offsetHeight rounds fractional pane heights to whole CSS pixels. That
    // rounding must not become a zoom factor for a long message's anchor.
    const height = Number.parseFloat(style.height), extra = style.boxSizing === 'border-box' ? 0 :
      ['paddingTop', 'paddingBottom', 'borderTopWidth', 'borderBottomWidth'].reduce((sum, key) => sum + (Number.parseFloat(style[key]) || 0), 0);
    const layoutHeight = Number.isFinite(height) && height + extra > 0 ? height + extra : scroll.offsetHeight;
    const value = layoutHeight > 0 ? rect.height / layoutHeight : 1;
    return Number.isFinite(value) && value > 0 ? value : 1;
  };
  const findUnit = anchor => [...body.querySelectorAll('[data-content-search-unit-key]')].find(node =>
    node.dataset.contentSearchUnitKey === anchor.unitKey && node.closest('[data-turn-key]')?.dataset.turnKey === anchor.turnKey);
  const readingAnchor = () => {
    const viewport = scroll.getBoundingClientRect(), factor = scale();
    if (!(viewport.height > 0)) return undefined;
    for (const node of body.querySelectorAll('[data-content-search-unit-key]')) {
      const turn = node.closest('[data-turn-key]'), rect = node.getBoundingClientRect();
      if (!turn || !body.contains(turn) || !turn.dataset.turnKey || !node.dataset.contentSearchUnitKey || rect.bottom <= viewport.top || rect.top >= viewport.bottom || rect.height <= 0) continue;
      return {turnKey:turn.dataset.turnKey, unitKey:node.dataset.contentSearchUnitKey, offset:(rect.top - viewport.top) / factor};
    }
  };
  const capture = () => {
    const {controller} = owned();
    if (pending?.position) return transcriptScrollPosition(pending.position);
    const followingLatest = controller.shouldFollowContentGrowth();
    if (typeof followingLatest !== 'boolean') throw error('unavailable', 'The Native transcript follow state changed');
    const anchor = followingLatest ? undefined : readingAnchor();
    return {top:scroll.scrollTop, left:scroll.scrollLeft, followingLatest, ...(anchor ? {anchor} : {})};
  };
  const cleanup = operation => {
    const release = operation.unlisten; operation.unlisten = null;
    for (const stop of [() => release?.(), () => operation.abort.abort()]) try {stop();} catch (failure) {try {report(failure);} catch {}}
  };
  const cancel = () => {
    const operation = pending;
    if (!operation) return;
    pending = null; cleanup(operation);
    try {if (operation.latest && operation.controller.getScrollElement() === scroll) operation.controller.holdViewport();}
    catch (failure) {try {report(failure);} catch {}}
    finally {operation.reject(error('cancelled', 'Transcript scrolling was interrupted'));}
  };
  function operation(binding, position, latest) {
    cancel();
    const abort = new scroll.ownerDocument.defaultView.AbortController();
    let resolve, reject;
    const promise = new Promise((yes, no) => {resolve=yes;reject=no;});
    // Legacy consumers may ignore this return value. The promise remains
    // rejecting for consumers that await completion, without an unhandled task.
    promise.catch(() => {});
    const value = {controller:binding.controller,owner:binding.owner,position,latest,abort,reject,promise};
    pending = value;
    value.finish = failure => {
      if (pending !== value) return;
      pending = null; cleanup(value); failure ? reject(failure) : resolve();
    };
    try {
      const interrupted = () => { if (pending === value) cancel(); };
      value.unlisten = binding.controller.addUserScrollListener(() => {if (pending === value && !value.nativeMove) cancel();});
      for (const name of ['wheel', 'pointerdown', 'touchstart', 'keydown']) scroll.addEventListener(name, interrupted, {capture:true,signal:abort.signal});
    } catch (failure) {value.finish(failure);throw failure;}
    return value;
  }
  const latest = () => {
    const binding = owned(), {controller} = binding;
    const value = operation(binding, {top:scroll.scrollTop,left:scroll.scrollLeft,followingLatest:true}, true);
    try {
      controller.scrollToBottom({durationMs:0, onStop() {
        if (pending !== value) return;
        try { current(value); value.finish(); } catch (failure) { value.finish(failure); }
      }});
    } catch (failure) { value.finish(failure); }
    return value.promise;
  };
  const restore = input => {
    const position = transcriptScrollPosition(input);
    if (position.followingLatest === true) {scroll.scrollLeft=position.left;return latest();}
    const binding = owned(), {controller, virtualizer} = binding;
    cancel(); controller.holdViewport(); scroll.scrollLeft=position.left;
    if (!position.anchor) {
      // The original API is an explicit physical offset, including negative
      // offsets supported by a Native reverse-scrolling surface. It carries no
      // semantic anchor to restore. Native is told to hold before that write.
      scroll.scrollTop=position.top;
      return Promise.resolve();
    }
    const api = virtualizer(), geometry = api.getEntryGeometry(position.anchor.turnKey);
    if (!geometry) throw error('anchor_unavailable', 'The saved Native reading anchor is no longer loaded');
    if (!Number.isFinite(geometry.startPx) || !Number.isFinite(geometry.endPx) || geometry.endPx < geometry.startPx)
      throw error('unavailable', 'The Native transcript entry geometry changed');
    const value = operation(binding, position, false);
    try {
      Promise.resolve(api.scrollToKey(position.anchor.turnKey, turn => {
        try {
          current(value);
          if (!turn?.isConnected || !body.contains(turn) || turn.dataset?.turnKey !== position.anchor.turnKey)
            throw error('owner_changed', 'The Native transcript reading target changed');
        } catch (failure) {value.finish(failure);throw failure;}
        // Native invokes this resolver and its explicit user-origin scroll on
        // the same stack. A later real user scroll (including the scrollbar)
        // retires our restoration rather than being overwritten by completion.
        value.nativeMove = true; queueMicrotask(() => {value.nativeMove=false;});
        return [...turn.querySelectorAll('[data-content-search-unit-key]')].find(node => node.dataset.contentSearchUnitKey === position.anchor.unitKey) ?? turn;
      },
      {align:'top',signal:value.abort.signal})).then(() => {
        if (pending !== value) return;
        try {
          const next = current(value);
          if (next.virtualizer() !== api) throw error('owner_changed', 'The Native transcript virtualization owner changed');
          const node = findUnit(position.anchor);
          if (!node) throw error('anchor_unavailable', 'The saved Native reading anchor is no longer available');
          const delta = (node.getBoundingClientRect().top - scroll.getBoundingClientRect().top) / scale() - position.anchor.offset;
          // Native scrollToKey is a user-origin placement. Hold after it settles
          // and compensate without the normal zero-distance follow shortcut.
          controller.holdViewport();
          controller.compensateScrollToDistanceFromBottomPx(Math.max(0, controller.getLastScrollDistanceFromBottomPx() - delta));
          value.finish();
        } catch (failure) { value.finish(failure); }
      }, failure => value.finish(failure));
    } catch (failure) { value.finish(failure); }
    return value.promise;
  };
  return {capture, latest, restore, dispose() {if(disposed)return;try{cancel();}finally{disposed=true;}}};
}
