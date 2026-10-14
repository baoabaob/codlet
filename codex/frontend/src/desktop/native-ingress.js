// Core-private same-document transport ownership. This is a continuity gate,
// not a security boundary against trusted main-world code.
const API = Symbol.for('codlet.core.native-ingress.v1');
const OWNER = Symbol.for('codlet.core.native-ingress.owner.v1');
const fail = (code, message) => Object.assign(new Error(message), {code});
const validId = value => typeof value === 'string' && value.length > 0 && value.length <= 256 && !/[\u0000-\u001f\u007f]/.test(value);
const request = message => message?.type === 'mcp-request' && message.hostId === 'local' && message.request && validId(String(message.request.id));
const rejected = (code, message) => ({ok:false, code, message});
const maxCalls = 64, maxBytes = 4 * 1024 * 1024;

// Separate lexical environments prevent the permanent ABI forwarding stubs
// from retaining attachNativeIngress's generation-owned dispatch/owner closure.
function stableWrapper(state) {
  return function(message, ...rest) { return state.handlers.ingress(this, message, rest); };
}
function stableApi(state) {
  return Object.freeze({api:1, documentEpoch:state.documentEpoch,
    pause(id) { return state.handlers.pause(id); }, resume(id, options) { return state.handlers.resume(id, options); }});
}

function installHandlers(state) {
  const current = () => state.postbox.postMessage === state.wrapper && state.dispatch !== null;
  const reject = (entry, error) => {
    const id = entry.message.request.id;
    if (state.client.requestPromises.has(id) && state.client.requestPromises.get(id) === entry.pending) state.client.onError(id, error);
  };
  const fresh = entry => state.client.requestPromises.has(entry.message.request.id) && state.client.requestPromises.get(entry.message.request.id) === entry.pending && entry.expires > Date.now();
  state.handlers = {
    pause(id) {
      if (!validId(id)) return rejected('invalid_operation', 'A bounded Core update operation identity is required');
      if (!current()) return rejected('core_ingress_unsupported', 'The live Core Desktop transport is unavailable or has changed');
      if (state.held !== null && state.held !== id) return rejected('core_ingress_busy', 'Another Core update owns Native ingress');
      state.held = id;
      return {ok:true, held:true, documentEpoch:state.documentEpoch};
    },
    resume(id, options) {
      if (!validId(id) || !options || !['applied','rolledBack'].includes(options.outcome) || Object.keys(options).some(key => key !== 'outcome'))
        return rejected('invalid_operation', 'Only a determinate Core update outcome may resume Native ingress');
      if (state.held !== id) return rejected('core_ingress_stale', 'This operation does not own the held Native ingress');
      if (!current()) return rejected('core_ingress_unsupported', 'A current Core Desktop provider must take over before ingress resumes');
      const queue = state.queue; state.queue = []; state.bytes = 0; state.held = null;
      for (const entry of queue) {
        if (!fresh(entry)) { reject(entry, fail('core_ingress_expired', 'Native request expired or retired during the Core update')); continue; }
        // Re-enter the stable wrapper. It consults the current owner each time,
        // including a synchronous new pause, and never an old provider closure.
        try { state.wrapper.call(entry.receiver, entry.message, ...entry.rest); }
        catch (error) { reject(entry, error); }
      }
      return {ok:true, resumed:true, documentEpoch:state.documentEpoch};
    },
    ingress(receiver, message, rest) {
      if (!request(message) || state.held === null || state.coreDispatch > 0)
        return (state.dispatch ?? state.original).call(receiver, message, ...rest);
      const pending = state.client.requestPromises.get(message.request.id);
      let bytes, captured;
      try {
        const text = JSON.stringify(message); bytes = text.length * 2;
        if (bytes > maxBytes) throw fail('core_ingress_limit', 'Native request exceeds the Core update queue budget');
        captured = JSON.parse(text);
      } catch (error) { reject({message, pending}, error); return; }
      const entry = {message:captured, receiver, rest, bytes, pending,
        expires:Math.min(Date.now() + 10000, Number.isFinite(message.expiresAtMs) ? message.expiresAtMs : Infinity)};
      if (!fresh(entry)) { reject(entry, fail('core_ingress_expired', 'Native request retired before update admission')); return; }
      if (state.queue.length >= maxCalls || state.bytes + bytes > maxBytes) { reject(entry, fail('core_ingress_limit', 'Native requests exceed the bounded Core update queue')); return; }
      if (state.queue.some(value => value.message.request.id === message.request.id && value.message.hostId === message.hostId)) {
        reject(entry, fail('core_ingress_duplicate', 'Native request identity is already queued')); return;
      }
      state.queue.push(entry); state.bytes += bytes;
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
      held:null, queue:[], bytes:0, documentEpoch:crypto.randomUUID(), epoch:0, handlers:null};
    state.wrapper = stableWrapper(state);
    state.api = stableApi(state);
    Object.defineProperty(global, OWNER, {value:state, configurable:true});
    Object.defineProperty(global, API, {value:state.api, configurable:true});
  }
  // New module generations replace the implementation while retaining only the
  // Native connection, queue, and stable forwarding closures in the registry.
  installHandlers(state);
  const owner = ++state.epoch; state.owner = owner; state.dispatch = dispatch; postbox.postMessage = state.wrapper;
  // Rust seeds the private Core admission lease in replacement/new documents.
  // A document that appeared after the coordinator captured its target set must
  // stay held too, even if its original transaction finishes with an unknown set.
  const coreAdmission = global[Symbol.for('codlet.core.renderer-admission.v1')];
  if (coreAdmission?.api === 1 && coreAdmission.operationId !== null && coreAdmission.operationId !== undefined) {
    const held = state.handlers.pause(coreAdmission.operationId);
    if (!held.ok) throw fail(held.code, held.message);
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
