// Core-private same-document hook ownership. Update admission applies to Core
// operations; Native traffic always retains a live original transport.
const API = Symbol.for('codlet.core.native-ingress.v1');
const OWNER = Symbol.for('codlet.core.native-ingress.owner.v1');
const fail = (code, message) => Object.assign(new Error(message), {code});
const validId = value => typeof value === 'string' && value.length > 0 && value.length <= 256 && !/[\u0000-\u001f\u007f]/.test(value);
const rejected = (code, message) => ({ok:false, code, message});

// Separate lexical environments prevent the permanent ABI forwarding stubs
// from retaining attachNativeIngress's generation-owned dispatch/owner closure.
function stableWrapper(state) {
  return function(...args) { return state.handlers.ingress(this, args); };
}
function stableApi(state) {
  return Object.freeze({api:1, documentEpoch:state.documentEpoch,
    pause(id) { return state.handlers.pause(id); }, resume(id, options) { return state.handlers.resume(id, options); }});
}

function installHandlers(state) {
  const current = () => state.postbox.postMessage === state.wrapper && state.dispatch !== null;
  state.handlers = {
    pause(id) {
      if (!validId(id)) return rejected('invalid_operation', 'A bounded Core update operation identity is required');
      if (!current()) return rejected('core_ingress_unsupported', 'The live Core Desktop transport is unavailable or has changed');
      if (state.held !== null && state.held !== id) return rejected('core_ingress_busy', 'Another Core update owns this hook handoff');
      state.held = id;
      return {ok:true, held:true, documentEpoch:state.documentEpoch};
    },
    resume(id, options) {
      if (!validId(id) || !options || !['applied','rolledBack'].includes(options.outcome) || Object.keys(options).some(key => key !== 'outcome'))
        return rejected('invalid_operation', 'Only a determinate Core update outcome may complete the hook handoff');
      if (state.held !== id) return rejected('core_ingress_stale', 'This operation does not own the hook handoff');
      if (!current()) return rejected('core_ingress_unsupported', 'A current Core Desktop provider must take over before the handoff completes');
      state.held = null;
      return {ok:true, resumed:true, documentEpoch:state.documentEpoch};
    },
    ingress(receiver, args, legacyRest) {
      // Older stable wrappers pass (receiver, message, rest). Keep their ABI
      // while replacing the queueing implementation during a live takeover.
      if (legacyRest !== undefined) args = [args, ...legacyRest];
      return (state.dispatch ?? state.original).apply(receiver, args);
    },
  };
}

export function attachNativeIngress({global = globalThis, postbox, client, dispatch}) {
  if (!postbox || typeof postbox.postMessage !== 'function' || typeof dispatch !== 'function' || typeof client?.requestPromises?.has !== 'function' || typeof client.requestPromises.get !== 'function' || typeof client.onError !== 'function')
    throw fail('core_ingress_unsupported', 'A reviewed Native postbox and request client are required');
  let state = global[OWNER];
  if (state) {
    if (state.api !== global[API] || state.postbox !== postbox || state.client !== client || postbox.postMessage !== state.wrapper || state.dispatch !== null)
      throw fail('core_ingress_conflict', 'Native ingress belongs to another connection or live provider');
  } else {
    if (global[API] !== undefined) throw fail('core_ingress_conflict', 'Another implementation owns the Core ingress API');
    state = {postbox, client, original:postbox.postMessage, dispatch:null, owner:null, coreDispatch:0,
      held:null, documentEpoch:crypto.randomUUID(), epoch:0, handlers:null};
    state.wrapper = stableWrapper(state);
    state.api = stableApi(state);
    Object.defineProperty(global, OWNER, {value:state, configurable:true});
    Object.defineProperty(global, API, {value:state.api, configurable:true});
  }
  // New module generations replace the implementation while retaining only the
  // Native connection and stable forwarding closures in the registry.
  installHandlers(state);
  const owner = ++state.epoch; state.owner = owner; state.dispatch = dispatch; postbox.postMessage = state.wrapper;
  // Rust seeds the private Core admission lease in replacement/new documents.
  // A new document inherits the Core handoff reservation, but Native dispatch
  // must remain available even if the Core update outcome stays unknown.
  const coreAdmission = global[Symbol.for('codlet.core.renderer-admission.v1')];
  if (coreAdmission?.api === 1 && coreAdmission.operationId !== null && coreAdmission.operationId !== undefined) {
    const held = state.handlers.pause(coreAdmission.operationId);
    if (!held.ok) throw fail(held.code, held.message);
  }
  // An older provider may have queued requests that it never dispatched. Move
  // only still-current Native requests to the original transport, exactly once.
  const legacyQueue = state.queue ?? []; delete state.queue; delete state.bytes;
  for (const entry of legacyQueue) {
    const id = entry.message?.request?.id;
    if (state.client.requestPromises.get(id) !== entry.pending || !state.client.requestPromises.has(id)) continue;
    try { state.original.call(entry.receiver, entry.message, ...entry.rest); }
    catch (error) { state.client.onError(id, error); }
  }
  const check = () => {
    if (state.owner !== owner || state.dispatch !== dispatch || postbox.postMessage !== state.wrapper || global[API] !== state.api)
      throw fail('desktop_patch_drift', 'Core Native ingress ownership changed; renderer reload required');
  };
  return {
    original:state.original, check,
    // This synchronous scope exists only around Core implementation calls into
    // the Native manager. No caller-supplied message can request the exception.
    coreDispatch(operation) { check(); state.coreDispatch++; try { return operation(); } finally { state.coreDispatch--; } },
    detach() {
      check(); state.dispatch = null; state.owner = null;
      if (state.held !== null) return;
      postbox.postMessage = state.original;
      if (global[API] === state.api) delete global[API];
      if (global[OWNER] === state) delete global[OWNER];
    },
  };
}
