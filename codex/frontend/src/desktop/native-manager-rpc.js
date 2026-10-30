const fail = (code, message) => Object.assign(new Error(message), { code });
const threadId = value => {
  if (typeof value !== 'string' || !/^[\w-]{1,256}$/.test(value)) throw fail('invalid_argument', 'Invalid Native thread identity');
  return value;
};

// The capability and request client remain Native-owned. Only subscriptions and
// snapshots created here belong to this driver. A snapshot is a DTO, never an
// identity proof for a Native conversation object.
export function createNativeManagerRpc({ rpc, client, check, report = () => {} }) {
  let alive = true, failure = null, knownWatching = false, knownReading = null, knownDirty = 0;
  let knownIds = new Set();
  const subscriptions = new Set(), threads = new Map(), stateListeners = new Set(), pendingSettings = new Map(), errorListeners = new Set();
  const fault = error => { if (!alive) return; failure ??= error; report(error); for (const listener of [...errorListeners]) { try { listener(error); } catch {} } };
  const assert = () => {
    if (!alive) throw fail('desktop_connection_replaced', 'Native manager RPC owner retired');
    if (failure) throw failure;
    try { check(); } catch (error) { dispose(); throw error; }
  };
  const call = async (method, ...args) => {
    assert();
    const result = await rpc[method](...args);
    assert();
    return result;
  };
  const releaseHandle = async handle => {
    if (!handle) return;
    try { await handle.unsubscribe(); }
    finally { handle[Symbol.dispose]?.(); }
  };
  function subscribe(spec, listener) {
    assert();
    const record = { active: true, handle: null, operation: null, released: null };
    subscriptions.add(record);
    let resolveReady, rejectReady;
    const ready = new Promise((resolve, reject) => { resolveReady = resolve; rejectReady = reject; });
    ready.catch(error => { if (record.active && alive) fault(error); });
    const release = () => {
      if (record.released) return record.released;
      record.active = false; subscriptions.delete(record);
      record.released = ready.then(() => releaseHandle(record.handle)).finally(() => {
        record.handle = null;
        record.operation?.[Symbol.dispose]?.();
      });
      record.released.catch(report);
      return record.released;
    };
    record.release = release;
    const callback = (...args) => {
      if (!record.active || !alive) return;
      try { assert(); listener(...args); } catch (error) { report(error); }
    };
    // Keep the original operation so retirement can release its capability;
    // never dispose the existing HostClient.rpc itself.
    try { record.operation = rpc.subscribe({ ...spec, key: { hostId: 'local', ...spec.key }, listener: callback }); }
    catch (error) { record.active = false; subscriptions.delete(record); rejectReady(error); throw error; }
    const broken = error => { if (record.active && alive) { fault(error ?? fail('desktop_manager_rpc_broken', 'Native manager subscription broke')); release(); } };
    Promise.resolve(record.operation).then(async handle => {
      if (!record.active || !alive) { await releaseHandle(handle); return; }
      try { assert(); handle.onRpcBroken?.(broken); record.handle = handle; }
      catch (error) { await releaseHandle(handle); throw error; }
    }).then(resolveReady, rejectReady);
    try { record.operation.onRpcBroken?.(broken); }
    catch (error) { broken(error); }
    return { ready, dispose: release };
  }
  const emit = id => { for (const listener of [...stateListeners]) { try { listener(id); } catch (error) { report(error); } } };
  function refresh(record) {
    if (record.reading) return record.reading;
    const dirty = record.dirty, epoch = record.epoch;
    record.reading = (async () => {
      assert();
      if (threads.get(record.id) !== record) throw fail('desktop_thread_retired', 'Native thread observation retired');
      const [conversation, role] = await Promise.all([call('getConversation', record.id), call('getStreamRole', record.id)]);
      if (threads.get(record.id) !== record || epoch !== record.epoch) throw fail('desktop_thread_retired', 'Native thread observation retired');
      // Reads are serialized. A notification dirties the next read but cannot
      // prevent this ordered snapshot from preparing a continuously streaming
      // view. Owner retirement/removal still invalidates every pending result.
      record.conversation = conversation; record.role = role; record.prepared = true;
      emit(record.id); return conversation;
    })().finally(() => {
      record.reading = null;
      if (alive && threads.get(record.id) === record && record.dirty !== dirty)
        queueMicrotask(() => refresh(record).catch(error => { if (alive && threads.get(record.id) === record) fault(error); }));
    });
    return record.reading;
  }
  function observeThread(id, listener = () => {}) {
    id = threadId(id); assert();
    let record = threads.get(id);
    if (!record) {
      record = { id, epoch: 0, dirty: 0, refs: 0, prepared: false, conversation: null, role: null, reading: null, subscriptions: [] };
      threads.set(id, record);
      const changed = () => {
        if (threads.get(id) !== record) return;
        record.dirty++;
        refresh(record).catch(error => { if (alive && threads.get(id) === record) fault(error); });
      };
      try {
        record.subscriptions.push(subscribe({ type: 'thread', key: { threadId: id }, field: 'metadata' }, changed));
        record.subscriptions.push(subscribe({ type: 'event', event: 'stream-role-changed' }, value => { if (value?.conversationId === id) changed(); }));
        record.subscriptions.push(subscribe({ type: 'event', event: 'conversation-removed' }, removed => { if (removed === id) retireThread(record); }));
      } catch (error) { retireThread(record); throw error; }
    }
    record.refs++;
    const changed = changedId => { if (changedId === id) listener(); };
    stateListeners.add(changed);
    const ready = Promise.all(record.subscriptions.map(value => value.ready)).then(() => refresh(record));
    let active = true;
    return { ready, dispose() {
      if (!active) return; active = false; stateListeners.delete(changed);
      if (--record.refs === 0) return retireThread(record);
    } };
  }
  function retireThread(record) {
    if (threads.get(record.id) !== record) return;
    threads.delete(record.id); record.epoch++;
    const completion = Promise.allSettled(record.subscriptions.map(value => value.dispose()));
    emit(record.id); return completion;
  }
  function dispose() {
    if (!alive) return;
    alive = false;
    for (const record of threads.values()) record.epoch++;
    threads.clear(); knownIds.clear(); stateListeners.clear(); errorListeners.clear();
    return Promise.allSettled([...subscriptions].map(record => record.release()));
  }
  function readKnownIds() {
    if (knownReading) return knownReading;
    const dirty = knownDirty;
    knownReading = call('getCachedThreadIds').then(ids => {
      if (!Array.isArray(ids) || ids.some(id => typeof id !== 'string' || !id)) throw fail('desktop_summary_drift', 'Native cached thread identities changed');
      knownIds = new Set(ids); return ids;
    }).finally(() => {
      knownReading = null;
      if (alive && dirty !== knownDirty) queueMicrotask(() => readKnownIds().catch(fault));
    });
    return knownReading;
  }
  const manager = {
    rpc: true, requestClient: client, check: assert,
    get error() { return failure; },
    onError(listener) { errorListeners.add(listener); if (failure) listener(failure); return () => errorListeners.delete(listener); },
    ready: call('getHostId').then(value => { if (value !== 'local') throw fail('desktop_connection_drift', 'Native manager RPC host differs'); return readKnownIds(); }).then(() => undefined),
    subscribe, observeThread,
    peekConversation(id) { assert(); return threads.get(id)?.conversation ?? null; },
    peekStreamRole(id) { assert(); return threads.get(id)?.role ?? null; },
    getConversation: id => call('getConversation', threadId(id)),
    getStreamRole: id => call('getStreamRole', threadId(id)),
    hasKnownThread(id) {
      assert();
      if (!knownWatching) {
        knownWatching = true;
        subscribe({type:'event',event:'thread-list-invalidated'}, () => { knownDirty++; readKnownIds().catch(fault); });
        subscribe({type:'event',event:'conversation-removed'}, removed => { knownIds.delete(removed); knownDirty++; readKnownIds().catch(fault); });
      }
      return knownIds.has(id) || threads.get(id)?.conversation?.id === id;
    },
    async readLoadedThreadMetadata(requestedIds) {
      const ids = requestedIds ?? await readKnownIds();
      if (!Array.isArray(ids) || ids.some(id => typeof id !== 'string' || !id)) throw fail('desktop_summary_drift', 'Native cached thread identities changed');
      // Native's metadata endpoint deliberately excludes turns and previews.
      return ids.length ? call('getCachedThreadMetadata', ids) : [];
    },
    addConversationStateCallback(listener) { stateListeners.add(listener); return () => stateListeners.delete(listener); },
    addNotificationCallback(methods, listener) {
      const subscription = subscribe({ type: 'notification', methods }, listener);
      const release = () => subscription.dispose(); release.ready = subscription.ready; return release;
    },
    addConversationRemovedCallback(listener) {
      const subscription = subscribe({ type: 'event', event: 'conversation-removed' }, id => {
        const record = threads.get(id);
        if (record) retireThread(record);
        listener(id);
      });
      const release = () => subscription.dispose(); release.ready = subscription.ready; return release;
    },
    async updateThreadPermissions(id, settings, activeTurn) {
      id = threadId(id); assert();
      if (pendingSettings.has(id)) throw fail('permissions_busy', 'A Native permission update is pending');
      const operation = call('updateThreadPermissions', id, settings, activeTurn);
      pendingSettings.set(id, operation);
      try { return await operation; } finally {
        if (pendingSettings.get(id) === operation) pendingSettings.delete(id);
        const record = threads.get(id); if (record) { record.dirty++; refresh(record).catch(report); }
      }
    },
    pendingPermissionUpdate: id => pendingSettings.get(id),
    async sendRequest(...args) {
      assert();
      // The reviewed facade delegates this to the same AppScope request client.
      // Keep dispatch on this stack so ingress admission remains synchronous.
      const result = await client.sendRequest(...args); assert(); return result;
    },
    dispose,
  };
  manager.ready.catch(fault);
  for (const method of ['resumeConversation', 'unsubscribeInactiveConversation', 'getThreadWritableRoots',
    'loadBackgroundThreadHistoryPage', 'loadRemainingTurnItems',
    'replyWithCommandExecutionApprovalDecision', 'replyWithFileChangeApprovalDecision',
    'replyWithPermissionsRequestApprovalResponse', 'replyWithUserInputResponse']) manager[method] = (...args) => call(method, ...args);
  return manager;
}

export const peekConversation = (manager, id) => manager.rpc ? manager.peekConversation(id) : manager.getConversation(id);
export const peekStreamRole = (manager, id) => manager.rpc ? manager.peekStreamRole(id) : manager.getStreamRole?.(id);
