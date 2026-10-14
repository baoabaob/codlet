import { componentSource, currentElementAncestry } from '../host-discovery.js';

const fail = message => Object.assign(new Error(message), { code: 'workspace_composer_binding_drift' });
const hasMarkers = (fiber, markers) => markers.every(marker => componentSource(fiber.type).includes(marker));

export function inspectNativeComposerScope(native, chain) {
  // EditorProvider shares these prop names. The nearest matching component must
  // also hold the actual Native composer facade; text matches alone are weak.
  for (const implementation of chain) {
    if (!hasMarkers(implementation, ['onDocumentChange', 'onDocumentDispose', 'composerController'])) continue;
    let model;
    for (let hook = implementation.memoizedState, count = 0; hook && count++ < 128; hook = hook.next) {
      const candidate = hook.memoizedState?.current;
      if (candidate?.scope !== native.composerScope || !candidate.node) continue;
      if (model && model.node !== candidate.node) throw fail('Native composer model is ambiguous');
      model = candidate;
    }
    if (model) return model;
  }
  return null;
}

export function inspectNativeInput(native, input, root, register, diagnose) {
  const pending = (stage, counts = {}) => { diagnose?.({ stage, ...counts }); return null; };
  if (!input?.isConnected) return null;
  const editables = [...input.querySelectorAll('[contenteditable="true"]')].filter(element => {
    const ancestor = element.parentElement.closest('[contenteditable="true"]');
    return !ancestor || !input.contains(ancestor); // Rich code blocks can own nested editors.
  });
  if (!editables.length) return pending('editable');
  if (editables.length !== 1) throw fail('Native editable input is ambiguous');
  const editable = editables[0]; let chain;
  // ProseMirror inserts its DOM outside React; prove the closest committed host.
  for (let element = editable, depth = 0; element && root.contains(element) && depth < 16; element = element.parentElement, depth++) {
    chain = currentElementAncestry(element, root); if (chain) break;
  }
  if (!chain) return pending('committed-ancestry');
  const scope = inspectNativeComposerScope(native, chain); if (!scope) return pending('composer-scope', { ancestry: chain.length });
  // Native can attach ProseMirror directly below the composer's host DOM. Its
  // EditorProvider then belongs to that host's committed descendants rather
  // than the editable's DOM ancestry. Inspect only this input's bounded branch.
  const inputChain = currentElementAncestry(input, root);
  const owner = inputChain?.find(fiber => fiber.stateNode === input);
  const branch = [], queue = owner?.child ? [owner.child] : [], seen = new Set();
  while (queue.length) {
    const fiber = queue.pop(); if (!fiber || seen.has(fiber)) continue;
    if (seen.size >= 2048) throw fail('Native input branch exceeds the discovery limit');
    seen.add(fiber); branch.push(fiber);
    if (fiber.child) queue.push(fiber.child);
    if (fiber.sibling) queue.push(fiber.sibling);
  }
  const candidates = [...new Set([...chain, ...branch])];
  const controllers = new Set();
  // Phase-only instrumentation needs no per-provider/dependency view details.
  // Existing diagnostic callers keep their richer output by default.
  const views = diagnose && !diagnose.countsOnly ? [] : null;
  for (const fiber of candidates) {
    const value = fiber.tag === 10 && fiber.memoizedProps?.value;
    if (views && value?.view?.dom) views.push({ kind: 'provider', sameDom: value.view.dom === editable, withinInput: input.contains(value.view.dom) });
    if (value?.view?.dom === editable) controllers.add(value);
    for (let dep = fiber.dependencies?.firstContext, count = 0; dep && count++ < 128; dep = dep.next) {
      if (views && dep.memoizedValue?.view?.dom) views.push({ kind: 'dependency', sameDom: dep.memoizedValue.view.dom === editable, withinInput: input.contains(dep.memoizedValue.view.dom) });
      if (dep.memoizedValue?.view?.dom === editable) controllers.add(dep.memoizedValue);
    }
    if (views) for (let hook = fiber.memoizedState, count = 0; hook && count++ < 128; hook = hook.next) {
      const value = hook.memoizedState?.current?.controller;
      if (views && value?.view?.dom) views.push({ kind: 'hook', sameDom: value.view.dom === editable, withinInput: input.contains(value.view.dom) });
    }
  }
  if (!controllers.size) return pending('controller', { ancestry: chain.length, proseMirror: !!editable.pmViewDesc, views });
  if (controllers.size !== 1) throw fail('Native editor controller is ambiguous');
  const controller = [...controllers][0];
  if (controller.view.isDestroyed || typeof controller.getPersistedText !== 'function' || typeof controller.restoreDraft !== 'function')
    throw fail('Native editor controller changed');
  const submission = candidates.find(fiber => typeof fiber.memoizedProps?.onSubmitLocal === 'function' &&
    typeof fiber.memoizedProps?.submitDisabled === 'boolean' && (register === undefined || fiber.memoizedProps.registerSubmitHandler === register));
  if (!submission) return pending('submission', { ancestry: chain.length });
  let draft = null;
  if (typeof native.draftKey === 'function') {
    const key = native.draftKey(scope.value), providers = candidates.filter(fiber => hasMarkers(fiber,
      ['getInitialContent', 'getInitialInput', 'onDocumentChange', 'onDocumentDispose', 'pending-input-ready']));
    const owners = providers.filter(fiber => {
      if (fiber.memoizedProps?.composerController === controller) return true;
      for (let hook = fiber.memoizedState, count = 0; hook && count++ < 128; hook = hook.next)
        if (hook.memoizedState?.current?.controller === controller) return true;
      return false;
    });
    diagnose?.({stage:'draft',formatterKeyPresent:typeof key==='string'&&!!key,providerCount:providers.length,ownerCount:owners.length,
      keyMatches:owners.map(owner=>owner.key===key),externalOwnerCount:owners.filter(owner=>owner.memoizedProps?.composerController===controller).length});
    // Native home nests an EditorProvider around an externally supplied editor.
    // Both providers own this controller and the same draft namespace. A rebuilt
    // controller is also valid; conflicting namespaces remain unconfirmed.
    if (typeof key === 'string' && key.length && owners.length > 0 && owners.every(owner => owner.key === key)) {
      const value = scope.value;
      draft = Object.freeze({ key, kind: value.kind, conversationId: value.conversationId ?? null, clientThreadId: value.clientThreadId ?? null,
        entrypoint: value.entrypoint ?? null, routeKind: value.routeKind ?? null });
    }
  }
  return { input, editable, controller, scope, submitHandler: submission.memoizedProps.onSubmitLocal,
    submitDisabled: submission.memoizedProps.submitDisabled === true, draft };
}

export function sameNativeInput(left, right) {
  return !!left && !!right && ['input', 'editable', 'controller', 'submitHandler', 'scopeNode', 'scopeValue',
    'threadNode', 'threadValue', 'routeNode', 'routeValue', 'threadId', 'clientThreadId', 'hostId'].every(key => left[key] === right[key]);
}
