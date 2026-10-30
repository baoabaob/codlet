import {awaitNativeInitialization,memoizeNativeLoad} from '../adapter/native-readiness.js';
import {peekConversation} from './native-manager-rpc.js';
const fail = (code, message) => Object.assign(new Error(message), {code});
const policyFields = ['approvalPolicy', 'approvalsReviewer', 'sandboxPolicy', 'permissions', 'runtimeWorkspaceRoots'];
const same = (a, b) => JSON.stringify(a) === JSON.stringify(b);
const clone = value => JSON.parse(JSON.stringify(value));
const ownerKey = value => `${value.pluginId}:${value.generation}`;

export function validatePermissionState(state) {
  if (!state || typeof state !== 'object' || Array.isArray(state) || Object.keys(state).some(key => key !== 'guards') ||
      !Array.isArray(state.guards) || state.guards.length > 256 || new Set(state.guards.map(value => value?.threadId)).size !== state.guards.length ||
      state.guards.some(value => !value || typeof value !== 'object' || Array.isArray(value) || Object.keys(value).length !== 3 ||
        Object.keys(value).some(key => !['threadId','pluginId','generation'].includes(key)) || typeof value.threadId !== 'string' || !/^[\w-]{1,256}$/.test(value.threadId) ||
        typeof value.pluginId !== 'string' || !value.pluginId.length || value.pluginId.length > 256 || /[\u0000-\u001f\u007f]/.test(value.pluginId) ||
        !Number.isSafeInteger(value.generation) || value.generation < 1)) throw fail('permissions_state_invalid', 'Permission state may contain only bounded logical thread and owner identities');
  return state;
}

// Registrations hold authenticated identities only. The one current snapshot is
// disposable; every submission rereads Native canonical settings at dispatch.
export function createPermissions({manager, client, check, selection, load, emit}) {
  let driver, alive = true, revision = 0, current, releaseNative;
  const controller=new AbortController();
  const owners = new Map(), registered = new Map(), pending = new Set(), dispatches = new Set();
  const nativeStamp = id => { const thread=peekConversation(manager,id),settings=thread?.latestThreadSettings;const values=[...policyFields.map(key=>settings?.[key]),settings?.activePermissionProfile,settings?.model,thread?.latestModel];return manager.rpc?values.map(value=>JSON.stringify(value)):values; };
  const ensure = memoizeNativeLoad(() => awaitNativeInitialization(async()=>{
    const value=await load();
    if(!alive){value?.dispose?.();controller.signal.throwIfAborted();}
    return value;
  },{signal:controller.signal}).then(value => {
    if (!alive) throw fail('adapter_deactivated', 'Permission provider retired');
    if (!value || typeof value.read !== 'function' || typeof value.convert !== 'function' ||
        typeof value.canonical !== 'function' || value.sendPathVerified !== true)
      throw fail('permissions_unsupported', 'Authoritative Native permission mapping and submission semantics are required');
    driver = value; releaseNative=value.subscribe?.(id=>changed(id)); return value;
  }));
  function validate(args, update = false) {
    if (!args || typeof args !== 'object' || Array.isArray(args) ||
        Object.keys(args).some(key => !(update ? ['threadId', 'hostId', 'selection', 'expectedRevision', 'confirmed'] : ['threadId', 'hostId']).includes(key)) ||
        typeof args.threadId !== 'string' || !/^[\w-]{1,256}$/.test(args.threadId) || (args.hostId ?? 'local') !== 'local')
      throw fail('invalid_argument', 'Invalid permission conversation');
    if (update && (!Number.isSafeInteger(args.expectedRevision) || args.expectedRevision < 0 || args.confirmed !== undefined && typeof args.confirmed !== 'boolean'))
      throw fail('invalid_argument', 'A permission revision and valid confirmation are required');
    check(); if (!alive) throw fail('adapter_deactivated', 'Permission provider retired');
    if (selection().threadId !== args.threadId) throw fail('permissions_not_selected', 'Permissions require the current confirmed Native conversation');
    return args.threadId;
  }
  function register(ctx) {
    check();
    if (!alive || ctx?.world !== 'main' || typeof ctx.onDeactivate !== 'function' || typeof ctx.pluginId !== 'string' || !Number.isSafeInteger(ctx.generation))
      throw fail('invalid_owner', 'Permission registration requires the live authenticated main-world context');
    const key = ownerKey(ctx);
    if (owners.has(key)) throw fail('duplicate_registration', 'Permission owner is already registered');
    if (owners.size >= 32) throw fail('resource_limit', 'Too many permission owners');
    const transfers = [...registered].filter(([, record]) => record.restored && record.pluginId === ctx.pluginId);
    if (transfers.some(([, record]) => ctx.generation <= record.generation)) throw fail('invalid_owner', 'A restored permission guard requires a fresh authenticated owner generation');
    const record = {active: true, pluginId: ctx.pluginId, generation: ctx.generation}; let release;
    const dispose = () => {
      if (!record.active) return; record.active = false; owners.delete(key);
      for (const [id, identity] of registered) if (identity === record) {registered.delete(id);changed(id);}
      release?.();
    };
    owners.set(key, record);
    try { release = ctx.onDeactivate(dispose); if (!record.active) throw fail('invalid_owner', 'Permission owner already retired'); }
    catch (error) { dispose(); throw error; }
    for (const [id] of transfers) { registered.set(id, record); changed(id); }
    record.dispose = dispose;
    return dispose;
  }
  function principalRecord(principal) {
    const record = principal && typeof principal.pluginId === 'string' && Number.isSafeInteger(principal.generation) && owners.get(ownerKey(principal));
    if (!record?.active) throw fail('invalid_owner', 'Permission update requires its authenticated live write owner');
    return record;
  }
  function publish(id, value) {
    const publicValue = {threadId: id, hostId: 'local', phase: value.phase, selection: value.selection ?? null, source: value.source ?? 'unknown', options: value.options ?? [], diagnostic: value.diagnostic ?? null};
    const signature = JSON.stringify(publicValue);
    if (current?.id === id && current.signature === signature) { current.nativeStamp=nativeStamp(id); return clone(current.snapshot); }
    const snapshot = {...clone(publicValue), revision: ++revision};
    current = {id, signature, snapshot, nativeStamp:nativeStamp(id)}; return clone(snapshot);
  }
  async function get(args) {
    const id = validate(args); let native;
    try { native = await ensure(); }
    catch (error) { validate(args); return publish(id, {phase: 'unsupported', options: [], diagnostic: {code: 'permissions_unsupported', message: error?.message ?? 'Native permission mapping is unavailable'}}); }
    validate(args); const value = await native.read(id,{canonical:registered.get(id)?.active===true}); validate(args);
    return publish(id, value);
  }
  function changed(id) {
    if (!alive || current?.id !== id) return;
    current = null;
    emit({type: 'permissions.changed', threadId: id, hostId: 'local', revision: ++revision});
  }
  function observe(id) {
    if(current?.id!==id)return;
    const next=nativeStamp(id);
    if(next.some((value,index)=>value!==current.nativeStamp[index]))changed(id);
  }
  async function update(args, signal, principal) {
    const id = validate(args, true), identity = principalRecord(principal);
    if (pending.has(id)) throw fail('permissions_busy', 'A permission update is pending');
    if (signal?.aborted) throw fail('invocation_cancelled', 'Permission update cancelled before dispatch');
    pending.add(id);
    let dispatched = false, confirmed = false, release;
    try {
      const snapshot = await get({threadId: id, hostId: 'local'});
      if (snapshot.revision !== args.expectedRevision) throw fail('permissions_stale', 'Permission options changed before dispatch');
      const option = snapshot.options.find(option => option.enabled && same(option.selection, args.selection));
      if (snapshot.phase !== 'ready' || !option) throw fail('permissions_unavailable', 'The selected permission is not currently allowed by Native');
      if (option.requiresConfirmation && args.confirmed !== true) throw fail('permissions_confirmation_required', 'Native requires confirmation for this permission choice');
      const settings = await driver.convert(id, args.selection); validate(args, true); principalRecord(principal);
      if (signal?.aborted) throw fail('invocation_cancelled', 'Permission update cancelled before dispatch');
      if (!settings || Object.keys(settings).some(key => !policyFields.includes(key))) throw fail('permissions_unsupported', 'Native permission conversion produced unsupported fields');
      if (typeof manager.updateThreadPermissions !== 'function' || !manager.rpc && typeof manager.waitForPendingThreadSettingsUpdate !== 'function' || typeof client.addRequestLifecycleListener !== 'function')
        throw fail('permissions_unsupported', 'Native per-thread permission lifecycle is unavailable');
      if ((await manager.getConversation(id))?.resumeState !== 'resumed' || (await manager.getStreamRole(id))?.role !== 'owner')
        throw fail('permissions_not_owner', 'Use the Native window owning this resumed conversation to change permissions');
      const latest = await get({threadId:id, hostId:'local'});
      if (latest.revision !== args.expectedRevision) throw fail('permissions_stale', 'Native permissions changed during conversion');
      validate(args, true); principalRecord(principal);
      if (signal?.aborted) throw fail('invocation_cancelled', 'Permission update cancelled before dispatch');
      if (!registered.has(id) && registered.size >= 256) throw fail('resource_limit', 'Too many registered permission conversations');
      const requestIds = new Set();
      release = client.addRequestLifecycleListener(event => {
        if (event.type === 'started' && event.method === 'thread/settings/update' && event.params?.threadId === id) requestIds.add(event.id);
        if (event.type === 'completed' && event.method === 'thread/settings/update' && requestIds.has(event.id) && event.error == null && Object.hasOwn(event, 'result') && event.result?.applied !== false) confirmed = true;
      });
      registered.set(id, identity); dispatched = true;
      await manager.updateThreadPermissions(id, settings); check();
      // The RPC facade's update Promise awaits runThreadSettingsUpdate itself.
      // It does not expose the legacy manager's separate pending-update method.
      if (manager.rpc) confirmed = true;
      else await manager.waitForPendingThreadSettingsUpdate(id);
      check(); principalRecord(principal);
      if (signal?.aborted) throw fail('outcome_unknown', 'Permission update may have applied after cancellation');
      changed(id); const after = await get({threadId: id, hostId: 'local'});
      if (after.phase !== 'ready' || !same(after.selection, args.selection)) throw fail('permissions_unconfirmed', 'Native did not confirm the selected thread permission');
      return Object.freeze({threadId: id, hostId: 'local', selection: clone(args.selection), status: confirmed ? 'confirmed' : 'staged', revision: after.revision});
    } catch (error) {
      if (dispatched) {
        changed(id);
        throw fail('outcome_unknown', 'Permission update may have applied; refresh its Native settings before retrying');
      }
      throw error;
    } finally { release?.(); pending.delete(id); }
  }
  function intercept(message, dispatch) {
    const request = message?.request, id = request?.params?.threadId, identity = registered.get(id);
    if (!alive || message?.type !== 'mcp-request' || message.hostId !== 'local' || !identity?.active || !['thread/resume', 'turn/start'].includes(request?.method)) return dispatch(message);
    const requestId = request.id;
    // Native may try to resume after ownership changes inside its own settings
    // update. Waiting for that update from its resume would wait on itself.
    if (request.method === 'thread/resume' && pending.has(id)) {
      if(client.requestPromises.has(requestId))client.onError(requestId,fail('permissions_busy','A permission update is pending; resume after it settles'));
      return;
    }
    const pendingRequest = client.requestPromises.get(requestId), operation = {};
    const ownsRequest = () => client.requestPromises.has(requestId) && client.requestPromises.get(requestId) === pendingRequest;
    dispatches.add(operation);
    Promise.resolve().then(async () => {
      check(); await ensure();
      if (manager.rpc) {
        const update = manager.pendingPermissionUpdate(id);
        if (update) await update;
        // An external Native update has no exposed manager queue receipt. Do
        // not claim it completed or dispatch against its in-flight settings.
        if ([...client.requestPromises.values()].some(value => value.conversationId === id && ['thread/settings/update','turn/settings/update'].includes(value.method)))
          throw fail('permissions_busy', 'Native thread settings are still updating');
      } else await manager.waitForPendingThreadSettingsUpdate(id);
      check();
      if (!alive || !ownsRequest()) throw fail('permissions_request_retired', 'Native permission request retired before dispatch');
      if (!identity.active || registered.get(id) !== identity) throw fail('permissions_owner_retired', 'Permission owner retired before dispatch');
      const settings = await driver.canonical(id); check();
      if (!alive || !ownsRequest()) throw fail('permissions_request_retired', 'Native permission request retired before dispatch');
      if (!identity.active || registered.get(id) !== identity) throw fail('permissions_owner_retired', 'Permission owner retired before dispatch');
      if (manager.rpc && [...client.requestPromises.values()].some(value => value.conversationId === id && ['thread/settings/update','turn/settings/update'].includes(value.method)))
        throw fail('permissions_busy', 'Native thread settings are still updating');
      if (!settings || !policyFields.some(key => settings[key] !== undefined)) throw fail('permissions_unconfirmed', 'Native canonical thread permissions are unavailable');
      const params = {...request.params};
      for (const key of policyFields) if (key !== 'runtimeWorkspaceRoots' || settings[key] !== undefined) delete params[key];
      for (const key of policyFields) if (settings[key] !== undefined) params[key] = clone(settings[key]);
      dispatch({...message, request: {...request, params}});
    }).catch(error => { if (ownsRequest()) client.onError(requestId, error); }).finally(() => dispatches.delete(operation));
  }
  function captureState() {
    check(); if (!alive) throw fail('adapter_deactivated', 'Permission provider retired');
    if (pending.size || dispatches.size) throw fail('permissions_busy', 'Canonical permission updates or Native dispatches must settle before state transfer');
    return {guards: [...registered].filter(([, record]) => record.active).map(([threadId, record]) => ({threadId, pluginId: record.pluginId, generation: record.generation}))};
  }
  async function restoreState(state) {
    validatePermissionState(state);
    check(); if (!alive) throw fail('adapter_deactivated', 'Permission provider retired');
    if (owners.size || registered.size || pending.size || dispatches.size) throw fail('permissions_state_conflict', 'Permission state can restore only into an empty provider generation');
    if (state.guards.length) await ensure();
    check(); if (!alive) throw fail('adapter_deactivated', 'Permission provider retired');
    if (owners.size || registered.size || pending.size || dispatches.size) throw fail('permissions_state_conflict', 'Permission owner changed during state restoration');
    for (const value of state.guards) registered.set(value.threadId, {...value, active: true, restored: true});
    current = null;
  }
  return {get, update, changed, observe, register, intercept, captureState, restoreState, dispose() {
    alive = false; controller.abort(); for (const record of [...owners.values()]) record.dispose();
    registered.clear(); pending.clear(); current = null; releaseNative?.(); driver?.dispose?.();
  }};
}
