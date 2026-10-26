import { workspaceError } from './workspace-dom.js';

const identityKeys = ['threadId', 'hostId'];
function identity(value) {
  if (!value || typeof value !== 'object' || Array.isArray(value) ||
      Object.keys(value).some(key => !identityKeys.includes(key)) ||
      !/^[\w-]{8,256}$/.test(value.threadId ?? '') || (value.hostId ?? 'local') !== 'local')
    throw workspaceError('invalid_argument', 'Invalid local composer identity');
  return Object.freeze({ threadId: value.threadId, hostId: 'local' });
}
function invocation(value, revision = false) {
  if (!value || typeof value !== 'object' || Array.isArray(value) ||
      Object.keys(value).some(key => key !== 'signal' && (!revision || key !== 'bindingRevision')))
    throw workspaceError('invalid_argument', 'Invalid composer invocation');
  const signal = value.signal;
  if (signal != null && (typeof signal.aborted !== 'boolean' || typeof signal.addEventListener !== 'function' || typeof signal.removeEventListener !== 'function'))
    throw workspaceError('invalid_argument', 'Invalid composer signal');
  if (value.bindingRevision != null && (!Number.isSafeInteger(value.bindingRevision) || value.bindingRevision < 1))
    throw workspaceError('invalid_argument', 'Invalid composer binding revision');
  return value;
}
const deferred = () => {
  let resolve, reject;
  const promise = new Promise((yes, no) => { resolve = yes; reject = no; });
  promise.catch(() => {});
  return { promise, resolve, reject };
};
const cancelled = () => workspaceError('invocation_cancelled', 'Composer operation was cancelled');

// State/cancellation boundary only. A reviewed Native driver owns the actual
// scopes, editor, submit binding, draft checkpoint and asynchronous release.
// Supplying this controller is not evidence that a Native profile supports it.
export function createComposerBinding({ driver, initialIdentity, onState, check, report, metrics, timeoutMs = Infinity, released = () => {} }) {
  for (const method of ['bind', 'activate', 'block', 'readBinding', 'focus', 'isComposing', 'close'])
    if (typeof driver?.[method] !== 'function') throw workspaceError('workspace_composer_unsupported', 'Native composer driver is incomplete');
  let requested = identity(initialIdentity), revision = 0, phase, bindingOp, activationOp, active = false, retired = false, closing, closeController, closeDone = false;
  const closeListeners = new Map();
  const first = deferred(), viewId = metrics?.nextView();
  const valid = () => { check(); if (retired) throw workspaceError('workspace_retired', 'Composer handle retired'); };
  const matches = value => value?.inputConfirmed === true && value.threadId === requested.threadId && value.hostId === 'local' && value.bindingRevision === revision;
  function expected(options) {
    if (options.bindingRevision != null && options.bindingRevision !== revision)
      throw workspaceError('workspace_composer_superseded', 'The composer binding was replaced');
  }
  function state(next, error) {
    if (phase === next && !error) return;
    phase = next;
    metrics?.add('composer.state', { viewId, threadAlias: revision });
    const value = Object.freeze({ phase, ...requested, bindingRevision: revision,
      diagnostic: error ? Object.freeze({ code: error.code ?? 'workspace_composer_unavailable', message: error.message }) : null });
    try { Promise.resolve(onState?.(value)).catch(report); } catch (error) { report(error); }
  }
  function block() { active = false; driver.block(); }
  function finish(op, error, receipt) {
    if (op.done) return;
    op.done = true; clearTimeout(op.timer); op.unsubscribe?.();
    if (bindingOp === op) bindingOp = null;
    if (activationOp === op) activationOp = null;
    if (error) { op.controller.abort(error); op.reject(error); }
    else op.resolve(receipt);
  }
  function cancel(op, code, message) { if (op) finish(op, workspaceError(code, message)); }
  function operation(kind, signal) {
    const op = { ...deferred(), kind, revision, controller: new AbortController(), done: false,
      operationId: metrics?.nextOperation(), started: metrics?.start() };
    const abort = () => {
      if (op.done) return;
      const current = kind === 'bind' ? bindingOp === op : activationOp === op;
      finish(op, cancelled());
      if (current && !retired && op.revision === revision) { block(); state('inactive', cancelled()); }
    };
    if (signal) { signal.addEventListener('abort', abort, { once: true }); op.unsubscribe = () => signal.removeEventListener('abort', abort); }
    if (Number.isFinite(timeoutMs)) op.timer = setTimeout(() => {
      if (op.done) return;
      finish(op, workspaceError(`workspace_composer_${kind}_timeout`, 'Native composer did not complete ' + kind));
      if (!retired && op.revision === revision) { block(); state('error', workspaceError(`workspace_composer_${kind}_timeout`, 'Native composer timed out')); }
    }, timeoutMs);
    return op;
  }
  function current(op) { return !op.done && !retired && op.revision === revision; }
  function receipt() { return Object.freeze({ ...requested, bindingRevision: revision, inputConfirmed: true, submitDisabled: !active }); }
  function failure(op, error) {
    if (!current(op)) return;
    finish(op, error);
    block(); state('error', error); report(error);
  }
  function beginBind(target, options = {}) {
    valid(); const next = identity(target), opts = invocation(options);
    if (opts.signal?.aborted) { const failed = deferred(); failed.reject(cancelled()); return failed.promise; }
    if (driver.isComposing()) throw workspaceError('workspace_composer_busy', 'Finish composition before rebinding the composer');
    cancel(bindingOp, 'workspace_composer_superseded', 'A newer composer binding replaced this operation');
    cancel(activationOp, 'workspace_composer_superseded', 'The composer binding was replaced');
    block(); requested = next; revision++;
    const op = operation('bind', opts.signal); bindingOp = op;
    if (revision === 1) op.promise.then(first.resolve, first.reject);
    metrics?.add('composer.bind.begin', { viewId, operationId: op.operationId, threadAlias: revision });
    state(revision === 1 ? 'preparing' : 'binding');
    // State callbacks may themselves rebind or retire the handle.
    if (current(op)) Promise.resolve().then(() => {
      if (current(op)) return driver.bind({ ...next, bindingRevision: op.revision }, { signal: op.controller.signal });
    }).then(() => {
      if (!current(op)) return;
      check();
      if (!matches(driver.readBinding())) throw workspaceError('workspace_composer_binding_drift', 'Native input or submit target does not match the requested binding');
      const value = receipt(); finish(op, null, value);
      if (metrics) metrics.end('composer.bind.complete', op.started, { viewId, operationId: op.operationId, threadAlias: op.revision });
      state(activationOp ? 'activating' : 'ready');
    }).catch(error => failure(op, error));
    return op.promise;
  }
  function activate(options = {}) {
    valid(); const opts = invocation(options, true); expected(opts);
    if (opts.signal?.aborted) { const failed = deferred(); failed.reject(cancelled()); return failed.promise; }
    const existing = active && driver.readBinding();
    if (active && matches(existing) && existing.submitDisabled === false)
      return Promise.resolve(Object.freeze({ ...receipt(), submitDisabled: false }));
    cancel(activationOp, 'workspace_composer_superseded', 'A newer activation replaced this operation');
    block();
    const op = operation('activate', opts.signal); activationOp = op;
    const bound = bindingOp?.promise ?? Promise.resolve();
    state('activating');
    Promise.resolve(bound).then(() => {
      if (current(op)) return driver.activate({ bindingRevision: op.revision, signal: op.controller.signal });
    }).then(() => {
      if (!current(op)) return;
      check(); const value = driver.readBinding();
      if (!matches(value) || value.submitDisabled !== false) throw workspaceError('workspace_composer_binding_drift', 'Native composer did not confirm an editable binding');
      active = true; finish(op, null, Object.freeze({ ...receipt(), submitDisabled: false }));
      if (metrics) metrics.end('composer.activate.complete', op.started, { viewId, operationId: op.operationId, threadAlias: op.revision });
      state('active');
    }).catch(error => failure(op, error));
    return op.promise;
  }
  function deactivate() {
    valid(); block(); cancel(activationOp, 'workspace_composer_deactivated', 'Composer activation was cancelled');
    if (!bindingOp) state('inactive');
  }
  function startClose(options = {}) {
    const opts = invocation(options);
    if (!closing) {
      retired = true; block();
      cancel(bindingOp, 'workspace_retired', 'Composer retired before binding');
      cancel(activationOp, 'workspace_retired', 'Composer retired before activation');
      first.reject(workspaceError('workspace_retired', 'Composer retired before readiness'));
      const completion = deferred(); closing = completion.promise; closeController = new AbortController();
      state('closing');
      const started = metrics?.start(); let closeError;
      // The same completion is retained after synchronous retirement. Native
      // must fail, rather than claim persistence, if checkpoint cannot finish.
      const aborted = deferred();
      const abort = () => aborted.reject(closeController.signal.reason ?? cancelled());
      closeController.signal.addEventListener('abort', abort, { once: true });
      if (closeController.signal.aborted) abort();
      const timer = Number.isFinite(timeoutMs) ? setTimeout(() => closeController.abort(workspaceError('workspace_composer_cleanup_incomplete', 'Native composer cleanup did not finish')), timeoutMs) : undefined;
      Promise.race([Promise.resolve().then(() => driver.close({ signal: closeController.signal })), aborted.promise]).then(() => {
        closeController.signal.throwIfAborted();
        if (metrics) metrics.end('composer.close.complete', started, { viewId, threadAlias: revision });
        state('disposed');
      }).catch(error => { closeError = error; state('error', error); throw error; }).finally(() => {
        closeDone = true; clearTimeout(timer); closeController.signal.removeEventListener('abort', abort);
        for (const [signal, listener] of closeListeners) signal.removeEventListener('abort', listener);
        closeListeners.clear(); released(closeError);
      }).then(completion.resolve, completion.reject);
      closing.catch(report);
    }
    if (opts.signal && !closeDone && !closeListeners.has(opts.signal)) {
      const abort = () => closeController.abort(cancelled());
      if (opts.signal.aborted) abort();
      else { closeListeners.set(opts.signal, abort); opts.signal.addEventListener('abort', abort, { once: true }); }
    }
    return closing;
  }
  const handle = Object.freeze({
    get threadId() { return requested.threadId; }, get hostId() { return 'local'; },
    ready: first.promise,
    bind: beginBind, activate, deactivate,
    focus(options = {}) {
      valid(); const opts = invocation(options, true);
      if (opts.signal != null) throw workspaceError('invalid_argument', 'Focus accepts only a binding revision');
      expected(opts);
      const value = driver.readBinding();
      if (active && !matches(value)) {
        block(); const error = workspaceError('workspace_composer_binding_drift', 'The active Native input changed its binding');
        state('error', error); throw error;
      }
      if (!active || value?.submitDisabled !== false)
        throw workspaceError('workspace_composer_inactive', 'Activate the current binding before focusing it');
      return driver.focus() === true;
    },
    close: startClose,
    dispose() { void startClose(); },
  });
  queueMicrotask(() => {
    if (retired || revision) return;
    try { beginBind(requested); } catch (error) { first.reject(error); }
  });
  return handle;
}
