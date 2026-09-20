import { CLIENT_PROFILES } from '../../../compatibility/client-profiles.js';
import { createThreadTransport } from './transport.js';
'use strict';

// All Desktop build details stay in this optional directory package. The Core
// knows only its declared capabilities, principal and renderer lifecycle.
const BUILDS = CLIENT_PROFILES;
const publicBuild = build => ({ appVersion: build.appVersion, buildNumber: build.buildNumber, appServerVersion: build.appServerVersion });
const API_SYMBOL = 'codlet.codex.desktop.v1';
const cap = name => Object.freeze({ name, api: 1, scope: 'target' });
const CAPS = Object.freeze({ compatibility: cap('codex.desktop.compatibility'), submit: cap('codex.ui.preSubmit'), read: cap('codex.backend.read'), write: cap('codex.backend.write'), events: cap('codex.backend.events'), transport: cap('codex.backend.transport') });
const fail = (code, message) => Object.assign(new Error(message), { code });
const str = (value, name, max = 512) => {
    if (typeof value !== 'string' || !value.length || value.length > max) throw fail('invalid_argument', `${name} must be a nonempty string of at most ${max} characters`);
    return value;
};
const obj = (value = {}) => {
    if (!value || typeof value !== 'object' || Array.isArray(value)) throw fail('invalid_argument', 'expected an object');
    return value;
};
const fields = (value, allowed) => {
    obj(value);
    if (Object.keys(value).some(key => !allowed.includes(key))) throw fail('invalid_argument', 'unsupported argument field');
    return value;
};
const bounded = (value, fallback, max) => {
    value ??= fallback;
    if (!Number.isSafeInteger(value) || value < 1 || value > max) throw fail('invalid_argument', `value must be an integer in 1..${max}`);
    return value;
};
const copy = value => JSON.parse(JSON.stringify(value));
const optionalText = (value, max = 8192) => typeof value === 'string' ? value.slice(0, max) : null;
const identity = (value, name) => str(value, name, 256);
const freeze = value => {
    if (value && typeof value === 'object') { Object.values(value).forEach(freeze); Object.freeze(value); }
    return value;
};

function locateScope(token) {
    const root = document.getElementById('root');
    const key = root && Object.keys(root).find(key => key.startsWith('__reactContainer$'));
    const container = key ? root[key] : null;
    const first = container?.stateNode?.current ?? container;
    const seen = new Set(), pending = first ? [first] : [];
    while (pending.length && seen.size < 4096) {
        const fiber = pending.pop();
        if (!fiber || seen.has(fiber)) continue;
        seen.add(fiber);
        const chain = fiber.memoizedProps?.value;
        if (chain instanceof Map && chain.has(token?.id)) {
            const node = chain.get(token.id);
            if (node?.token === token && node.store && node.familyBindings instanceof Map) return { chain, node };
        }
        if (fiber.sibling) pending.push(fiber.sibling);
        if (fiber.child) pending.push(fiber.child);
    }
    throw fail('desktop_scope_missing', 'Desktop AppScope is not mounted; reload the adapter after Desktop is ready');
}

function validateDesktopBuild(checkEntry = true) {
    const detected = globalThis.electronBridge?.getSentryInitOptions?.();
    const build = BUILDS.find(build => detected?.appVersion === build.appVersion && String(detected?.buildNumber) === build.buildNumber);
    if (location.origin !== 'app://-' || location.pathname !== '/index.html' ||
        !build || (checkEntry && !Array.from(document.scripts).some(script => script.src === build.entry))) {
        throw fail('desktop_build_drift', `Codex Desktop Adapter has no verified profile for ${optionalText(detected?.appVersion)} / ${optionalText(String(detected?.buildNumber))}`);
    }
    if (typeof globalThis.electronBridge?.sendMessageFromView !== 'function') throw fail('desktop_preload_missing', 'Desktop preload bridge is unavailable');
    return build;
}

function probeTick(signal, delay) {
    if (signal?.aborted) return Promise.reject(fail('adapter_deactivated', 'Desktop adapter was deactivated during initialization'));
    return new Promise((resolve, reject) => {
        let timer;
        const done = error => { clearTimeout(timer); signal?.removeEventListener('abort', abort); error ? reject(error) : resolve(); };
        const abort = () => done(fail('adapter_deactivated', 'Desktop adapter was deactivated during initialization'));
        signal?.addEventListener('abort', abort, { once: true }); timer = setTimeout(() => done(), delay);
    });
}

async function probeDesktop(loadModule = source => import(source), readyTimeoutMs = 3000, signal) {
    const build = validateDesktopBuild(false);
    const readyDeadline = Date.now() + readyTimeoutMs;
    while (!Array.from(document.scripts).some(script => script.src === build.entry)) {
        if (document.readyState === 'complete' || Date.now() >= readyDeadline) throw fail('desktop_build_drift', 'The Desktop entry resource does not match this adapter');
        await probeTick(signal, Math.min(50, readyDeadline - Date.now()));
    }
    // Import reuses the already loaded module and its existing app-host services.
    // Opening another connect-app-host port would replace the Desktop view.
    const module = await loadModule(build.module);
    const transportModule = build.postboxModule ? await loadModule(build.postboxModule) : module;
    let token, managerFamily, clientFamily, services, postbox, scope, manager, client;
    for (;;) {
        if (signal?.aborted) throw fail('adapter_deactivated', 'Desktop adapter was deactivated during initialization');
        try {
            // These are live exports initialized by Desktop's lazy bootstrap.
            // Snapshot them only once Desktop has mounted its own connection.
            token = module[build.exports.scope]; managerFamily = module[build.exports.manager]; clientFamily = module[build.exports.client];
            services = module[build.exports.services]; postbox = transportModule[build.exports.postbox];
            scope = locateScope(token);
            if (!scope.node.familyBindings.get(managerFamily)?.has('local') || !scope.node.familyBindings.get(clientFamily)?.has('local')) throw fail('desktop_connection_not_ready', 'Desktop has not initialized its own local connection');
            manager = managerFamily.read(scope.node, scope.chain, 'local');
            client = clientFamily.read(scope.node, scope.chain, 'local');
            if (!services || !manager || !client || !postbox || client.getAppServerVersion?.() == null) throw fail('desktop_connection_not_ready', 'Desktop connection is still initializing');
            break;
        } catch (error) {
            if (!['desktop_scope_missing', 'desktop_connection_not_ready'].includes(error.code) || Date.now() >= readyDeadline) throw error;
            // Only a bounded activation wait. Nothing polls after ready/failed.
            await probeTick(signal, Math.min(50, readyDeadline - Date.now()));
        }
    }
    if (manager.requestClient !== client || manager.getHostId?.() !== 'local' || client.getAppServerVersion() !== build.appServerVersion) throw fail('desktop_connection_drift', 'Existing Desktop connection identity or App Server schema does not match this adapter');
    for (const method of ['sendRequest', 'getConversation', 'getStreamRole', 'addNotificationCallback', 'addConversationStateCallback', 'replyWithCommandExecutionApprovalDecision', 'replyWithFileChangeApprovalDecision', 'replyWithPermissionsRequestApprovalResponse', 'replyWithUserInputResponse']) {
        if (typeof manager[method] !== 'function') throw fail('desktop_manager_drift', `Desktop manager lacks ${method}`);
    }
    if (typeof client.onError !== 'function' || !(client.requestPromises instanceof Map) || Object.getOwnPropertyDescriptor(postbox ?? {}, 'postMessage')?.writable !== true) throw fail('desktop_transport_drift', 'Desktop request transport cannot be safely intercepted');
    return {
        manager, client, postbox, build,
        check() {
            if (validateDesktopBuild() !== build) throw fail('desktop_build_drift', 'Desktop build changed after adapter initialization');
            const current = locateScope(token);
            if (current.node !== scope.node || module[build.exports.scope] !== token || module[build.exports.manager] !== managerFamily || module[build.exports.client] !== clientFamily || module[build.exports.services] !== services || transportModule[build.exports.postbox] !== postbox || !current.node.familyBindings.get(managerFamily)?.has('local') || !current.node.familyBindings.get(clientFamily)?.has('local') || managerFamily.read(current.node, current.chain, 'local') !== manager || clientFamily.read(current.node, current.chain, 'local') !== client || manager.requestClient !== client || client.getAppServerVersion() !== build.appServerVersion) throw fail('desktop_connection_replaced', 'Desktop connection changed; reload the adapter');
        }
    };
}

function itemDto(item) {
    obj(item);
    const kind = ({ userMessage: 'user', agentMessage: 'assistant', reasoning: 'reasoning', commandExecution: 'command', fileChange: 'fileChange', mcpToolCall: 'tool', dynamicToolCall: 'tool', plan: 'plan' })[item.type] ?? 'other';
    return {
        id: identity(item.id, 'item id'), kind,
        text: optionalText(item.text ?? item.aggregatedOutput ?? (Array.isArray(item.content) ? item.content.filter(part => part.type === 'text').map(part => part.text).join('\n') : null), 262144),
        status: optionalText(item.status, 64),
        ...(kind === 'command' ? { command: optionalText(item.command), cwd: optionalText(item.cwd), exitCode: Number.isInteger(item.exitCode) ? item.exitCode : null } : {}),
        ...(kind === 'tool' ? { name: optionalText(item.tool ?? item.name, 256) } : {})
    };
}
function turnDto(turn) {
    obj(turn);
    return { id: identity(turn.id, 'turn id'), status: str(turn.status, 'turn status', 64), items: Array.isArray(turn.items) ? turn.items.map(itemDto) : [], error: optionalText(turn.error?.message) };
}
function threadDto(thread) {
    obj(thread);
    return { id: identity(thread.id, 'thread id'), title: optionalText(thread.name ?? thread.title ?? thread.preview), cwd: optionalText(thread.cwd), provider: optionalText(thread.modelProvider, 256), createdAt: Number.isFinite(thread.createdAt) ? thread.createdAt : null, updatedAt: Number.isFinite(thread.updatedAt) ? thread.updatedAt : null, turns: Array.isArray(thread.turns) ? thread.turns.map(turnDto) : [] };
}

function permissionsDto(params) {
    const profile = params.permissions ?? {}, fs = profile.fileSystem ?? {};
    const known = (value, keys) => value && typeof value === 'object' && !Array.isArray(value) && Object.keys(value).every(key => keys.includes(key));
    const path = value => typeof value === 'string' && value.length > 0 && value.length <= 8192 && !value.includes('\0');
    const paths = key => Array.isArray(fs[key]) ? fs[key].filter(path) : [];
    const read = new Set(paths('read')), write = new Set(paths('write'));
    const entries = Array.isArray(fs.entries) ? fs.entries : [];
    let hasOtherPaths = fs.entries != null && !Array.isArray(fs.entries);
    for (const entry of entries) {
        const supported = known(entry, ['access', 'path']) && ['read', 'write'].includes(entry.access) &&
            known(entry.path, ['type', 'path']) && entry.path.type === 'path' && path(entry.path.path);
        if (supported) (entry.access === 'read' ? read : write).add(entry.path.path);
        else hasOtherPaths = true;
    }
    const canApprove = known(profile, ['network', 'fileSystem']) && known(profile.network ?? {}, ['enabled']) &&
        (profile.network?.enabled == null || typeof profile.network.enabled === 'boolean') &&
        known(fs, ['read', 'write', 'entries', 'globScanMaxDepth']) && !hasOtherPaths &&
        ['read', 'write'].every(key => fs[key] == null || (Array.isArray(fs[key]) && fs[key].every(path))) &&
        (fs.globScanMaxDepth == null || (Number.isSafeInteger(fs.globScanMaxDepth) && fs.globScanMaxDepth >= 1)) &&
        (params.environmentId == null || params.environmentId === 'local');
    return { canApprove: !!canApprove, permissions: { network: profile.network?.enabled === true, read: [...read], write: [...write], hasOtherPaths } };
}

function locateNavigator() {
    const root = document.getElementById('root');
    const key = root && Object.keys(root).find(key => key.startsWith('__reactContainer$'));
    const container = key ? root[key] : null;
    const pending = [container?.stateNode?.current ?? container], seen = new Set(), candidates = new Set();
    while (pending.length && seen.size < 4096) {
        const fiber = pending.pop();
        if (!fiber || seen.has(fiber)) continue;
        seen.add(fiber);
        for (const value of [fiber.memoizedProps, fiber.memoizedProps?.value]) if (value?.navigator) candidates.add(value.navigator);
        if (fiber.sibling) pending.push(fiber.sibling);
        if (fiber.child) pending.push(fiber.child);
    }
    if (pending.length || candidates.size !== 1) throw fail('desktop_navigation_unavailable', 'A unique Desktop memory router is required');
    const navigator = [...candidates][0];
    if (typeof navigator.location?.pathname !== 'string' || !navigator.location.pathname.startsWith('/') || navigator.location.pathname.startsWith('/avatar-overlay') || typeof navigator.listen !== 'function') throw fail('desktop_navigation_unavailable', 'Task navigation is unavailable in this Desktop window');
    return navigator;
}

// Project only turn identity/status from Native's canonical history and live tail.
// Items, messages and automation policy functions never enter this projection.
function activeTurnState(thread) {
    const unknown = { activeTurnId: null, activeTurnKnown: false };
    if (!thread || thread.resumeState !== 'resumed' || !Array.isArray(thread.turns)) return unknown;
    let history = [];
    if (thread.turnHistory?.kind === 'canonical') {
        const source = thread.turnHistory.history;
        if (!Array.isArray(source?.islands) || !source.entitiesByKey || typeof source.entitiesByKey !== 'object') return unknown;
        for (const island of source.islands) {
            if (!Array.isArray(island.entries) || history.length + island.entries.length > 4096) return unknown;
            for (const entry of island.entries) { const turn = source.entitiesByKey[entry.value]; if (!turn) return unknown; history.push(turn); }
        }
    } else if (thread.turnHistory != null && thread.turnHistory.kind !== 'legacy') return unknown;
    if (thread.turns.length > 4096) return unknown;
    const valid = turn => turn && (turn.turnId == null || typeof turn.turnId === 'string' && turn.turnId.length > 0 && turn.turnId.length <= 256) && ['inProgress', 'completed', 'interrupted', 'failed'].includes(turn.status);
    if (!history.every(valid) || !thread.turns.every(valid)) return unknown;
    const canonical = new Map(history.filter(turn => turn.turnId != null).map(turn => [turn.turnId, turn]));
    const live = new Map(thread.turns.filter(turn => turn.turnId != null).map(turn => [turn.turnId, turn]));
    const ordered = history.filter(turn => turn.turnId != null).map(turn => ({ id: turn.turnId, status: live.has(turn.turnId) ?
        turn.status !== 'inProgress' && live.get(turn.turnId).status === 'inProgress' && (turn.itemsPagination || live.get(turn.turnId).itemsPagination) ? turn.status : live.get(turn.turnId).status : turn.status }));
    let pending = [];
    for (const turn of thread.turns) {
        if (turn.turnId == null) continue;
        if (canonical.has(turn.turnId)) {
            const index = ordered.findIndex(value => value.id === turn.turnId);
            if (pending.length) { ordered.splice(index, 0, ...pending); pending = []; }
        } else pending.push({ id: turn.turnId, status: turn.status });
    }
    ordered.push(...pending);
    const current = ordered.at(-1);
    return { activeTurnId: current?.status === 'inProgress' ? current.id : null, activeTurnKnown: true };
}

function createNavigation(manager, changed, locate = locateNavigator) {
    const navigator = locate(), originals = new Map(), wrappers = new Map();
    let alive = true;
    const check = () => {
        if (!alive) throw fail('desktop_navigation_unavailable', 'Desktop navigation has retired');
        if (locate() !== navigator || [...wrappers].some(([method, wrapper]) => navigator[method] !== wrapper)) throw fail('desktop_navigation_drift', 'Desktop navigation ownership changed; reload the adapter');
    };
    const snapshot = () => {
        check();
        const path = navigator.location.pathname;
        const match = /^\/local\/([a-zA-Z0-9_-]{1,256})\/?$/.exec(path);
        const threadId = match?.[1] ?? null, thread = threadId ? manager.getConversation(threadId) : null;
        const role = threadId ? manager.getStreamRole(threadId)?.role : null;
        return { threadId, ...(threadId ? activeTurnState(thread) : { activeTurnId: null, activeTurnKnown: true }),
            resumeState: thread?.resumeState === 'resumed' ? 'resumed' : thread ? 'loading' : 'unloaded', streamRole: role === 'owner' || role === 'follower' ? role : 'none' };
    };
    const dispose = () => {
        if (!alive) return;
        alive = false; let lost = false;
        for (const [method, wrapper] of wrappers) { if (navigator[method] === wrapper) navigator[method] = originals.get(method); else lost = true; }
        if (lost) throw fail('desktop_navigation_drift', 'Another page patch replaced Desktop navigation');
    };
    try {
        for (const method of ['push', 'replace', 'go']) {
            if (typeof navigator[method] !== 'function' || Object.getOwnPropertyDescriptor(navigator, method)?.writable !== true) throw fail('desktop_navigation_unavailable', 'Desktop memory router cannot be observed safely');
            const original = navigator[method]; originals.set(method, original);
            const wrapper = function (...args) { const result = original.apply(this, args); if (alive) changed(); return result; };
            wrappers.set(method, wrapper); navigator[method] = wrapper;
        }
        snapshot();
        return { snapshot, stamp: () => { check(); return JSON.stringify(navigator.location); }, open: threadId => { check(); navigator.push(`/local/${threadId}`); }, dispose };
    } catch (error) { dispose(); throw error; }
}

function createAdapter(connection, context, { compatibilityProvided = false } = {}) {
    const { manager, client, postbox, build } = connection;
    if (!BUILDS.includes(build)) throw fail('desktop_build_drift', 'Connection has no verified Desktop build profile');
    const originalPost = postbox.postMessage;
    const symbol = Symbol.for(API_SYMBOL);
    if (globalThis[symbol] !== undefined) throw fail('desktop_adapter_conflict', 'Another Desktop adapter already owns this API');
    const instance = crypto.randomUUID();
    let alive = true, sequence = 0, eventBytes = 0, hookSequence = 0, reloadReason = null, unavailable = null;
    const hooks = new Map(), pendingSubmits = new Set(), events = [], waiters = new Set(), listeners = new Set(), cleanups = [], approvals = new Map(), retiredApprovals = new Map(), tickets = new Map(), submissions = new Map();
    let navigation = null, navigationFailure = null, lastSelection = null, opening = false;
    const check = () => {
        if (!alive) throw fail('adapter_deactivated', 'Desktop adapter was deactivated');
        if (unavailable) throw fail('capability_unavailable', `${unavailable.code}: ${unavailable.message}`);
        try { connection.check(); if (postbox.postMessage !== intercept) throw fail('desktop_patch_drift', 'Desktop request patch ownership changed; renderer reload required'); }
        catch (error) { markUnavailable(error); throw error; }
    };
    const status = () => ({ api: 1, initializing: false, available: unavailable === null, unavailable: unavailable ? { ...unavailable } : null, build: publicBuild(build), connection: 'existing-desktop-local', transport: 'existing-app-host-services-and-native-request-client', inputRewrite: true, contextInjection: true, presentationTransform: false, historyMutation: false, hooks: hooks.size, pendingSubmits: pendingSubmits.size, navigation: { available: navigation !== null && navigationFailure === null, unavailable: navigationFailure }, threadTransport: { ...threadTransport.probe(), available: unavailable === null && threadTransport.probe().available } });
    const emit = event => {
        if (!alive) return;
        const value = freeze({ ...copy(event), cursor: `${instance}:${++sequence}` });
        const bytes = JSON.stringify(value).length * 2;
        if (bytes > 600000) return;
        events.push({ value, bytes }); eventBytes += bytes;
        while (events.length > 256 || eventBytes > 1024 * 1024) eventBytes -= events.shift().bytes;
        for (const wake of [...waiters]) wake();
        for (const listener of [...listeners]) { try { listener(value); } catch {} }
    };
    function markUnavailable(error) {
        if (unavailable) return;
        unavailable = { code: error.code ?? 'desktop_schema_drift', message: optionalText(error.message) ?? 'Desktop schema changed; reload or update the adapter' };
        for (const capability of [CAPS.submit, CAPS.read, CAPS.write, CAPS.transport]) context.rpc.unavailable(capability, `${unavailable.code}: ${unavailable.message}`.slice(0, 1024));
        try { context.reportDiagnostic({ code: unavailable.code, message: unavailable.message }); } catch {}
        for (const pending of pendingSubmits) pending.controller.abort(fail('capability_unavailable', unavailable.message));
        threadTransport.cancel(fail('capability_unavailable', unavailable.message));
        emit({ type: 'adapter.drift', ...unavailable });
    }
    function mapped(convert) {
        try { return convert(); }
        catch (error) { const drift = fail('desktop_schema_drift', `Desktop response does not match the adapter schema: ${error.message}`); markUnavailable(drift); throw drift; }
    }
    const nativeRequest = async (method, params, signal) => {
        check();
        if (signal?.aborted) throw fail('invocation_cancelled', 'Request was cancelled before dispatch');
        const submissionId = method === 'turn/start' ? crypto.randomUUID() : null;
        if (submissionId) { params = { ...params, clientUserMessageId: submissionId }; submissions.set(submissionId, { signal }); }
        try {
            const result = await manager.sendRequest(method, params, { timeoutMs: 10000 });
            check();
            if (signal?.aborted) throw fail('outcome_unknown', 'Caller retired after dispatch; inspect the Desktop event stream before retrying a write');
            return result;
        } finally { if (submissionId) submissions.delete(submissionId); }
    };
    const loadedThread = id => {
        identity(id, 'threadId'); check();
        const thread = manager.getConversation(id);
        if (!thread || thread.resumeState !== 'resumed') throw fail('desktop_thread_not_loaded', 'Open this task in the current Desktop window before writing');
        const role = manager.getStreamRole(id)?.role;
        if (role !== 'owner') throw fail(role === 'follower' ? 'desktop_thread_follower' : 'desktop_stream_unavailable', 'Use the Desktop window that currently owns this task stream for writes');
        return thread;
    };
    const owner = (ctx, capability) => {
        if (!ctx || ctx.world !== 'main' || typeof ctx.onDeactivate !== 'function' || typeof ctx.pluginId !== 'string' || !Number.isSafeInteger(ctx.generation)) throw fail('invalid_owner', 'Callback registration requires its live main-world RendererContext');
        // Acquiring the API through Core RPC enforces the declaration. Main-world
        // plugins are high-trust code; this object does not claim an OS sandbox.
        return { pluginId: ctx.pluginId, generation: ctx.generation, capability };
    };
    const threadTransport = createThreadTransport({ check, owner, capability: CAPS.transport, client, build });

    function navigationUnavailable(error) {
        if (navigationFailure) return;
        navigationFailure = { code: error.code ?? 'desktop_navigation_unavailable', message: optionalText(error.message) ?? 'Desktop navigation is unavailable' };
        emit({ type: 'selection.unavailable', ...navigationFailure });
    }
    function selection() {
        if (!navigation || navigationFailure) throw fail(navigationFailure?.code ?? 'desktop_navigation_unavailable', navigationFailure?.message ?? 'Desktop navigation is unavailable');
        try { return navigation.snapshot(); } catch (error) { navigationUnavailable(error); throw error; }
    }
    function refreshSelection(threadId) {
        if (!alive || !navigation || navigationFailure || threadId != null && threadId !== lastSelection?.threadId) return;
        try {
            const current = selection();
            if (JSON.stringify(current) !== JSON.stringify(lastSelection)) { lastSelection = current; emit({ type: 'selection.changed', ...current }); }
        } catch (error) { navigationUnavailable(error); }
    }
    async function openThread(args, signal) {
        fields(args, ['threadId']);
        const threadId = identity(args.threadId, 'threadId');
        if (!/^[a-zA-Z0-9_-]+$/.test(threadId)) throw fail('invalid_argument', 'threadId must be a local task identity');
        const before = selection();
        if (signal?.aborted) throw fail('invocation_cancelled', 'Task navigation was cancelled before dispatch');
        if (before.threadId === threadId) return { ...before, status: before.resumeState === 'resumed' ? 'opened' : 'opening', alreadySelected: true };
        if (opening) throw fail('desktop_navigation_busy', 'Another task open request is still being validated');
        opening = true;
        try {
            const stamp = navigation.stamp();
            const metadata = await nativeRequest('thread/read', { threadId, includeTurns: false }, signal);
            if (metadata?.thread?.id !== threadId) throw fail('desktop_navigation_unavailable', 'Desktop did not confirm the requested task identity');
            selection();
            if (navigation.stamp() !== stamp) throw fail('desktop_navigation_superseded', 'The user navigated while this task was being checked');
            navigation.open(threadId);
            const current = selection();
            if (current.threadId !== threadId) throw fail('desktop_navigation_superseded', 'Desktop selected a different task during navigation');
            // Native's mounted task route owns cold resume, settings and stream ownership.
            return { ...current, status: current.resumeState === 'resumed' ? 'opened' : 'opening', alreadySelected: false };
        } finally { opening = false; }
    }

    const orderedHooks = () => [...hooks.values()].sort((a, b) => a.priority - b.priority || (a.pluginId < b.pluginId ? -1 : a.pluginId > b.pluginId ? 1 : 0) || a.order - b.order);
    const hookInfo = hook => ({ pluginId: hook.pluginId, generation: hook.generation, id: hook.name, priority: hook.priority, timeoutMs: hook.timeoutMs, enabled: hook.enabled, calls: hook.calls, failures: hook.failures, lastDurationMs: hook.lastDurationMs, totalDurationMs: hook.totalDurationMs, lastFailure: hook.lastFailure && { ...hook.lastFailure } });
    const listInterceptors = args => { check(); fields(args ?? {}, []); return { interceptors: orderedHooks().map(hookInfo) }; };

    function registerPreSubmit(ctx, options, handler) {
        check(); fields(options, ['id', 'priority', 'timeoutMs', 'enabled']);
        const principal = owner(ctx, CAPS.submit);
        const name = str(options.id, 'interceptor id', 128), key = `${principal.pluginId}:${principal.generation}:${name}`;
        if (hooks.has(key)) throw fail('duplicate_interceptor', 'Interceptor is already registered');
        if (hooks.size >= 32 || typeof handler !== 'function') throw fail('interceptor_limit', 'Expected a function and at most 32 interceptors');
        const priority = options.priority ?? 0;
        if (!Number.isSafeInteger(priority) || Math.abs(priority) > 1000) throw fail('invalid_argument', 'priority must be -1000..1000');
        if (options.enabled != null && typeof options.enabled !== 'boolean') throw fail('invalid_argument', 'enabled must be a boolean');
        const hook = { ...principal, key, name, handler, priority, order: ++hookSequence, timeoutMs: bounded(options.timeoutMs, 1000, 2000), active: true, enabled: options.enabled !== false, calls: 0, failures: 0, totalDurationMs: 0, lastDurationMs: null, lastFailure: null };
        hooks.set(key, hook);
        let release;
        const dispose = () => { if (!hook.active) return; hook.active = false; hooks.delete(key); release?.(); for (const pending of pendingSubmits) if (pending.hooks.includes(hook)) pending.controller.abort(fail('interceptor_deactivated', `${hook.pluginId}: interceptor was deactivated`)); };
        try { release = ctx.onDeactivate(dispose); } catch (error) { dispose(); throw error; }
        return Object.freeze(Object.assign(dispose, {
            setEnabled(enabled) {
                check(); if (!hook.active) throw fail('interceptor_retired', 'Interceptor has retired');
                if (typeof enabled !== 'boolean') throw fail('invalid_argument', 'enabled must be a boolean');
                hook.enabled = enabled;
                if (!enabled) for (const pending of pendingSubmits) if (pending.hooks.includes(hook)) pending.controller.abort(Object.assign(fail('interceptor_disabled', 'Interceptor was disabled before dispatch'), { pluginId: hook.pluginId, interceptorId: hook.name }));
            },
            inspect() { check(); if (!hook.active) throw fail('interceptor_retired', 'Interceptor has retired'); return hookInfo(hook); }
        }));
    }

    function intercept(message, ...rest) {
        if (alive && message?.type === 'mcp-request' && message.hostId === 'local' && ['thread/start', 'thread/resume'].includes(message.request?.method)) return threadTransport.intercept(message, next => originalPost.call(this, next, ...rest));
        if (!alive || message?.type !== 'mcp-request' || message.hostId !== 'local' || message.request?.method !== 'turn/start') return originalPost.call(this, message, ...rest);
        const submission = submissions.get(message.request.params?.clientUserMessageId);
        if (submission?.signal?.aborted || pendingSubmits.size >= 16) {
            client.onError(message.request.id, fail('submission_rejected', submission?.signal?.aborted ? 'Codlet submission was cancelled before dispatch' : 'Codlet has 16 pending submission interceptors'));
            return;
        }
        const selected = orderedHooks().filter(hook => hook.enabled);
        if (selected.length === 0) return originalPost.call(this, message, ...rest);
        const receiver = this;
        const pending = { hooks: selected, controller: new AbortController() };
        pendingSubmits.add(pending);
        const cancelSubmission = () => pending.controller.abort(fail('submission_cancelled', 'The calling plugin retired before dispatch'));
        submission?.signal?.addEventListener('abort', cancelSubmission, { once: true });
        // The Desktop method is synchronous. Report failures to its existing
        // pending request, never throw into a detached Promise or invent an id.
        runInterceptors(message, pending).then(next => {
            check();
            if (pending.controller.signal.aborted || !client.requestPromises.has(message.request.id)) throw fail('submission_retired', 'Desktop submission retired before dispatch');
            originalPost.call(receiver, next, ...rest);
        }).catch(error => {
            if (client.requestPromises.has(message.request.id)) client.onError(message.request.id, fail(error.code ?? 'interceptor_failed', `Codlet: ${error.message ?? String(error)}`));
            emit({ type: 'submission.blocked', threadId: optionalText(message.request.params?.threadId, 256), pluginId: error.pluginId ?? null, message: optionalText(error.message) });
        }).finally(() => { pendingSubmits.delete(pending); submission?.signal?.removeEventListener('abort', cancelSubmission); pending.controller.abort(); });
    }

    async function runInterceptors(message, pending) {
        check();
        const params = obj(message.request.params);
        if (!Array.isArray(params.input)) throw fail('desktop_input_drift', 'Desktop turn input is not an array');
        const next = { ...message, request: { ...message.request, params: { ...params, input: copy(params.input), additionalContext: { ...(params.additionalContext ?? {}) } } } };
        const deadline = Math.min(Date.now() + 5000, Number.isFinite(message.expiresAtMs) ? message.expiresAtMs : Infinity);
        for (const hook of pending.hooks) {
            let started = null;
            try {
                check();
                if (!hook.active || pending.controller.signal.aborted) throw pending.controller.signal.reason ?? fail('interceptor_deactivated', 'Interceptor was deactivated');
                const budget = Math.min(hook.timeoutMs, deadline - Date.now());
                if (budget < 1) throw fail('interceptor_timeout', 'Submission interceptor deadline expired');
                const texts = next.request.params.input.filter(part => part.type === 'text').map(part => { if (typeof part.text !== 'string' || part.text.length > 524288) throw fail('desktop_input_drift', 'Desktop text input is invalid or too large'); return part.text; });
                const draft = freeze({ threadId: identity(params.threadId, 'threadId'), text: texts.join('\n'), contextSources: Object.keys(next.request.params.additionalContext), source: 'turn.start' });
                let timer, onAbort;
                const signal = pending.controller.signal;
                started = Date.now(); hook.calls += 1;
                const result = await new Promise((resolve, reject) => {
                    onAbort = () => reject(signal.reason ?? fail('interceptor_deactivated', 'Interceptor was deactivated'));
                    signal.addEventListener('abort', onAbort, { once: true });
                    timer = setTimeout(() => reject(fail('interceptor_timeout', `Interceptor exceeded ${budget} ms`)), budget);
                    Promise.resolve().then(() => hook.handler(draft, Object.freeze({ signal }))).then(resolve, reject);
                }).finally(() => { clearTimeout(timer); signal.removeEventListener('abort', onAbort); });
                if (!hook.active || signal.aborted) throw signal.reason ?? fail('interceptor_deactivated', 'Interceptor was deactivated');
                if (result == null) continue;
                fields(result, ['text', 'context']);
                if (result.text !== undefined) {
                    const text = str(result.text, 'replacement text', 524288);
                    const index = next.request.params.input.findIndex(part => part.type === 'text');
                    next.request.params.input = next.request.params.input.filter(part => part.type !== 'text');
                    next.request.params.input.splice(index < 0 ? 0 : index, 0, { type: 'text', text, text_elements: [] });
                }
                if (result.context !== undefined) {
                    if (!Array.isArray(result.context) || result.context.length > 16) throw fail('invalid_argument', 'context must have at most 16 entries');
                    result.context.forEach((entry, index) => {
                        fields(entry, ['text', 'kind']);
                        const kind = entry.kind ?? 'untrusted';
                        if (kind !== 'untrusted' && kind !== 'application') throw fail('invalid_argument', 'unknown context kind');
                        next.request.params.additionalContext[`codlet:${hook.key}:${index}`] = { kind, value: str(entry.text, 'context text', 65536) };
                    });
                }
                if (JSON.stringify(next.request.params).length > 524288) throw fail('submission_too_large', 'Transformed submission exceeds the adapter limit');
            } catch (error) {
                if (started !== null) { hook.failures += 1; hook.lastFailure = { code: ['interceptor_timeout', 'interceptor_disabled', 'interceptor_deactivated', 'adapter_deactivated', 'submission_cancelled', 'invocation_cancelled', 'invalid_argument', 'desktop_input_drift', 'submission_too_large', 'desktop_build_drift', 'desktop_connection_replaced', 'capability_unavailable'].includes(error.code) ? error.code : 'interceptor_failed', at: Date.now() }; }
                pending.controller.abort(error);
                throw Object.assign(fail(error.code ?? 'interceptor_failed', `${error.pluginId ?? hook.pluginId}/${error.interceptorId ?? hook.name}: ${error.message ?? String(error)}`), { pluginId: error.pluginId ?? hook.pluginId });
            } finally {
                if (started !== null) { hook.lastDurationMs = Math.max(0, Date.now() - started); hook.totalDurationMs += hook.lastDurationMs; }
            }
        }
        return next;
    }

    const read = async (method, args = {}, signal) => {
        check(); obj(args);
        const pagination = () => ({ limit: bounded(args.limit, 20, 100), ...(args.cursor == null ? {} : { cursor: str(args.cursor, 'cursor', 4096) }) });
        switch (method) {
            case 'selection.get': fields(args, []); return selection();
            case 'threads.list': {
                fields(args, ['cursor', 'limit', 'archived']);
                if (args.archived !== undefined && typeof args.archived !== 'boolean') throw fail('invalid_argument', 'archived must be boolean');
                const result = await nativeRequest('thread/list', { ...pagination(), archived: args.archived ?? false, sortKey: 'updated_at' }, signal);
                return mapped(() => ({ threads: result.data.map(threadDto), cursor: optionalText(result.nextCursor, 4096) }));
            }
            case 'threads.get': {
                fields(args, ['threadId']);
                const result = await nativeRequest('thread/read', { threadId: identity(args.threadId, 'threadId'), includeTurns: false }, signal);
                return mapped(() => threadDto(result.thread));
            }
            case 'turns.list': {
                fields(args, ['threadId', 'cursor', 'limit']);
                const result = await nativeRequest('thread/turns/list', { ...pagination(), threadId: identity(args.threadId, 'threadId'), itemsView: 'notLoaded' }, signal);
                return mapped(() => ({ turns: result.data.map(turnDto), cursor: optionalText(result.nextCursor, 4096) }));
            }
            case 'items.list': {
                fields(args, ['threadId', 'turnId', 'cursor', 'limit']);
                const result = await nativeRequest('thread/items/list', { ...pagination(), threadId: identity(args.threadId, 'threadId'), ...(args.turnId == null ? {} : { turnId: identity(args.turnId, 'turnId') }) }, signal);
                return mapped(() => ({ items: result.data.map(entry => ({ turnId: identity(entry.turnId, 'turnId'), item: itemDto(entry.item) })), cursor: optionalText(result.nextCursor, 4096) }));
            }
            case 'models.list': {
                fields(args, ['cursor', 'limit']);
                const result = await nativeRequest('model/list', pagination(), signal);
                return mapped(() => ({ models: result.data.map(model => ({ id: str(model.id, 'model id'), model: str(model.model, 'model'), name: optionalText(model.displayName), description: optionalText(model.description), isDefault: model.isDefault === true, reasoningEfforts: (model.supportedReasoningEfforts ?? []).map(effort => str(effort.reasoningEffort, 'reasoning effort', 64)) })), cursor: optionalText(result.nextCursor, 4096) }));
            }
            case 'skills.list': {
                fields(args, ['cwd']);
                const result = await nativeRequest('skills/list', args.cwd == null ? {} : { cwds: [str(args.cwd, 'cwd', 8192)] }, signal);
                return mapped(() => ({ directories: result.data.map(directory => ({ cwd: optionalText(directory.cwd), skills: (directory.skills ?? []).map(skill => ({ name: str(skill.name, 'skill name'), description: optionalText(skill.description), path: optionalText(skill.path), enabled: skill.enabled === true })), errors: (directory.errors ?? []).map(error => ({ path: optionalText(error.path), message: optionalText(error.message) })) })) }));
            }
            case 'providers.list': {
                fields(args, []);
                const result = await nativeRequest('config/read', { includeLayers: false }, signal);
                const config = mapped(() => obj(result.config));
                // Credentials, URLs, environment mappings and raw config never
                // leave the adapter. Only provider identity/display names do.
                const selected = optionalText(config.model_provider, 256) ?? 'openai';
                const providers = new Map([[selected, { id: selected, name: selected, selected: true }]]);
                for (const [id, provider] of Object.entries(config.model_providers ?? {})) providers.set(id, { id, name: optionalText(provider?.name, 256) ?? id, selected: id === selected });
                return { providers: [...providers.values()] };
            }
            case 'approvals.list': {
                fields(args, ['threadId']);
                syncApprovals(identity(args.threadId, 'threadId'));
                return { requests: [...approvals.values()].filter(entry => entry.dto.threadId === args.threadId).map(entry => copy(entry.dto)) };
            }
            default: throw fail('method_not_found', 'Unknown Desktop read method');
        }
    };

    const write = async (method, args = {}, signal) => {
        check(); obj(args);
        if (method === 'approvals.respond') return respondApproval(args, signal);
        if (method === 'threads.open') return openThread(args, signal);
        fields(args, method === 'turns.start' ? ['threadId', 'text', 'model', 'effort'] : method === 'turns.steer' ? ['threadId', 'turnId', 'text'] : ['threadId', 'turnId']);
        loadedThread(args.threadId);
        if (method === 'turns.start') {
            const input = [{ type: 'text', text: str(args.text, 'text', 524288), text_elements: [] }];
            const result = await nativeRequest('turn/start', { threadId: args.threadId, input, ...(args.model === undefined ? {} : { model: str(args.model, 'model') }), ...(args.effort === undefined ? {} : { effort: str(args.effort, 'effort', 32) }) }, signal);
            return mapped(() => ({ threadId: args.threadId, turn: turnDto(result.turn) }));
        }
        if (method === 'turns.steer') {
            const result = await nativeRequest('turn/steer', { threadId: args.threadId, expectedTurnId: identity(args.turnId, 'turnId'), input: [{ type: 'text', text: str(args.text, 'text', 524288), text_elements: [] }] }, signal);
            return mapped(() => ({ threadId: args.threadId, turnId: identity(result.turnId, 'turnId') }));
        }
        if (method === 'turns.interrupt') {
            await nativeRequest('turn/interrupt', { threadId: args.threadId, turnId: identity(args.turnId, 'turnId') }, signal);
            return { threadId: args.threadId, turnId: args.turnId, status: 'submitted' };
        }
        throw fail('method_not_found', 'Unknown Desktop write method');
    };

    function approvalDto(threadId, request, token) {
        const params = obj(request.params);
        const kind = ({ 'item/commandExecution/requestApproval': 'command', 'item/fileChange/requestApproval': 'fileChange', 'item/permissions/requestApproval': 'permissions', 'item/tool/requestUserInput': 'userInput' })[request.method];
        if (!kind) return null;
        const dto = { token, kind, threadId, turnId: identity(params.turnId, 'turnId'), itemId: identity(params.itemId, 'itemId'), reason: optionalText(params.reason) };
        if (kind === 'command') Object.assign(dto, { command: optionalText(params.command), cwd: optionalText(params.cwd), canApprove: !Array.isArray(params.availableDecisions) || params.availableDecisions.includes('accept') });
        if (kind === 'permissions') {
            Object.assign(dto, permissionsDto(params));
        }
        if (kind === 'userInput') dto.questions = (params.questions ?? []).map(question => ({ id: identity(question.id, 'question id'), header: optionalText(question.header), question: str(question.question, 'question', 65536), secret: question.isSecret === true, options: question.options == null ? [] : question.options.map(option => ({ label: str(option.label, 'option'), description: optionalText(option.description) })) }));
        return dto;
    }
    function syncApprovals(threadId) {
        if (!alive || typeof threadId !== 'string') return;
        const requests = manager.getConversation(threadId)?.requests ?? [];
        const active = new Set();
        for (const [key, entry] of retiredApprovals) if (entry.retiredAt + 60000 < Date.now()) retiredApprovals.delete(key);
        for (const request of requests.slice(0, 128)) {
            const key = `${threadId}:${typeof request.id}:${request.id}`;
            active.add(key);
            const retired = retiredApprovals.get(key);
            if (retired?.resolved && retired.method === request.method && retired.turnId === request.params?.turnId && retired.itemId === request.params?.itemId) continue;
            retiredApprovals.delete(key);
            if (approvals.has(key)) continue;
            if (approvals.size >= 256) break;
            const token = crypto.randomUUID(), dto = approvalDto(threadId, request, token);
            if (dto) { approvals.set(key, { dto, id: request.id, method: request.method, submitted: false }); emit({ type: 'approval.requested', request: dto }); }
        }
        for (const [key, entry] of approvals) if (entry.dto.threadId === threadId && !active.has(key)) {
            approvals.delete(key);
            retireApproval(key, entry, false);
            emit({ type: 'approval.retired', token: entry.dto.token, threadId });
        }
        for (const [key, entry] of retiredApprovals) if (entry.threadId === threadId && entry.resolved && !active.has(key)) retiredApprovals.delete(key);
    }
    function retireApproval(key, entry, resolved) {
        const value = entry.dto ? { token: entry.dto.token, threadId: entry.dto.threadId, turnId: entry.dto.turnId, itemId: entry.dto.itemId, method: entry.method } : entry;
        retiredApprovals.set(key, { ...value, retiredAt: Date.now(), resolved });
        while (retiredApprovals.size > 256) retiredApprovals.delete(retiredApprovals.keys().next().value);
    }
    function resolveApproval(params) {
        const threadId = identity(params.threadId, 'threadId');
        if (!(typeof params.requestId === 'string' || Number.isSafeInteger(params.requestId))) throw fail('desktop_event_schema_drift', 'Invalid server-request resolution identity');
        const key = `${threadId}:${typeof params.requestId}:${params.requestId}`;
        const entry = approvals.get(key) ?? retiredApprovals.get(key);
        if (entry && !entry.resolved) {
            approvals.delete(key); retireApproval(key, entry, true);
            emit({ type: 'approval.resolved', threadId, token: entry.dto?.token ?? entry.token });
        }
    }
    function respondApproval(args, signal) {
        fields(args, ['token', 'decision', 'answers']);
        str(args.token, 'approval token', 128);
        const entry = [...approvals.values()].find(entry => entry.dto.token === args.token);
        if (!entry || entry.submitted) throw fail('approval_retired', 'Approval token is no longer pending');
        const thread = loadedThread(entry.dto.threadId);
        const request = thread.requests?.find(request => request.id === entry.id && request.method === entry.method);
        if (!request) { syncApprovals(entry.dto.threadId); throw fail('approval_retired', 'Desktop already resolved this request'); }
        if (signal?.aborted) throw fail('invocation_cancelled', 'Approval reply was cancelled before dispatch');
        const { kind, threadId } = entry.dto;
        if (kind === 'userInput') {
            if (args.decision !== undefined) throw fail('invalid_argument', 'User input requires answers');
            obj(args.answers);
            const answers = {};
            for (const [id, answer] of Object.entries(args.answers)) {
                if (!entry.dto.questions.some(question => question.id === id) || !Array.isArray(answer) || answer.length > 32 || answer.some(value => typeof value !== 'string' || value.length > 65536)) throw fail('invalid_argument', 'Invalid answer');
                answers[id] = { answers: [...answer] };
            }
            entry.submitted = true;
            manager.replyWithUserInputResponse(threadId, entry.id, { answers });
        } else {
            if (!['approve', 'decline'].includes(args.decision) || args.answers !== undefined) throw fail('invalid_argument', 'Expected approve or decline');
            if (kind === 'permissions' && args.decision === 'approve' && !approvalDto(threadId, request, entry.dto.token).canApprove) throw fail('unsupported_permissions', 'This request includes permission paths that require the Desktop approval UI');
            const choices = request.params.availableDecisions;
            if (kind === 'command' && args.decision === 'approve' && Array.isArray(choices) && !choices.includes('accept')) throw fail('approval_decision_unavailable', 'Desktop did not offer a one-time approval for this request');
            const nativeDecision = args.decision === 'approve' ? 'accept' : Array.isArray(choices) && !choices.includes('decline') && choices.includes('cancel') ? 'cancel' : 'decline';
            entry.submitted = true;
            if (kind === 'command') manager.replyWithCommandExecutionApprovalDecision(threadId, entry.id, nativeDecision);
            else if (kind === 'fileChange') manager.replyWithFileChangeApprovalDecision(threadId, entry.id, args.decision === 'approve' ? 'accept' : 'decline');
            else manager.replyWithPermissionsRequestApprovalResponse(threadId, entry.id, { permissions: args.decision === 'approve' ? copy(request.params.permissions) : {}, scope: 'turn' });
        }
        return { token: args.token, status: 'submitted' };
    }

    function eventBatch(args) {
        const limit = bounded(args.limit, 50, 100);
        let after = sequence;
        if (args.cursor != null) {
            str(args.cursor, 'cursor', 128);
            const prefix = `${instance}:`;
            if (!args.cursor.startsWith(prefix) || !/^\d+$/.test(args.cursor.slice(prefix.length))) throw fail('event_cursor_retired', 'Event cursor belongs to another adapter instance');
            after = Number(args.cursor.slice(prefix.length));
            if (!Number.isSafeInteger(after) || after < 0 || after > sequence) throw fail('invalid_argument', 'Invalid event cursor');
        }
        const earliest = events.length ? Number(events[0].value.cursor.split(':').at(-1)) : sequence + 1;
        const values = events.filter(entry => Number(entry.value.cursor.split(':').at(-1)) > after && (args.threadId == null || (entry.value.threadId ?? entry.value.request?.threadId ?? entry.value.thread?.id) === args.threadId)).slice(0, limit).map(entry => entry.value);
        return { events: copy(values), cursor: values.at(-1)?.cursor ?? `${instance}:${sequence}`, gap: after < earliest - 1 };
    }
    async function readEvents(args = {}, signal) {
        if (!alive) throw fail('adapter_deactivated', 'Desktop adapter was deactivated');
        if (!unavailable) { try { check(); } catch {} }
        fields(args, ['cursor', 'limit', 'threadId', 'waitMs']);
        if (args.threadId != null) identity(args.threadId, 'threadId');
        const batch = eventBatch(args);
        if (unavailable || args.waitMs === undefined || args.waitMs === 0 || batch.events.length || batch.gap) return batch;
        const waitMs = bounded(args.waitMs, 1000, 10000);
        if (waiters.size >= 16) throw fail('event_wait_limit', 'At most 16 event waits are supported');
        if (signal?.aborted) throw fail('invocation_cancelled', 'Event wait was cancelled');
        await new Promise((resolve, reject) => {
            let timer;
            const finish = error => { clearTimeout(timer); waiters.delete(wake); signal?.removeEventListener('abort', abort); error ? reject(error) : resolve(); };
            const wake = () => alive ? finish() : finish(fail('adapter_deactivated', 'Desktop adapter was deactivated'));
            const abort = () => finish(fail('invocation_cancelled', 'Event wait was cancelled'));
            waiters.add(wake); signal?.addEventListener('abort', abort, { once: true }); timer = setTimeout(() => finish(), waitMs);
        });
        if (!alive) throw fail('adapter_deactivated', 'Desktop adapter was deactivated');
        return eventBatch({ ...args, cursor: args.cursor ?? batch.cursor });
    }
    function onEvent(ctx, handler) {
        check(); owner(ctx, CAPS.events);
        if (typeof handler !== 'function' || listeners.size >= 64) throw fail('event_listener_limit', 'Expected a function and at most 64 listeners');
        listeners.add(handler);
        let release;
        const dispose = () => { listeners.delete(handler); release?.(); };
        try { release = ctx.onDeactivate(dispose); } catch (error) { dispose(); throw error; }
        return dispose;
    }
    function receive(notification) {
        try {
            check();
            const p = obj(notification.params), type = notification.method;
            if (type === 'thread/started') emit({ type: 'thread.started', thread: threadDto(p.thread) });
            else if (type === 'turn/started' || type === 'turn/completed') emit({ type: type === 'turn/started' ? 'turn.started' : 'turn.completed', threadId: identity(p.threadId, 'threadId'), turn: turnDto(p.turn) });
            else if (type === 'item/started' || type === 'item/completed') emit({ type: type === 'item/started' ? 'item.started' : 'item.completed', threadId: identity(p.threadId, 'threadId'), turnId: identity(p.turnId, 'turnId'), item: itemDto(p.item) });
            else if (type === 'item/agentMessage/delta' || type === 'item/commandExecution/outputDelta') { if (p.delta === '') return; emit({ type: type === 'item/agentMessage/delta' ? 'item.text.delta' : 'item.output.delta', threadId: identity(p.threadId, 'threadId'), turnId: identity(p.turnId, 'turnId'), itemId: identity(p.itemId, 'itemId'), delta: str(p.delta, 'delta', 262144) }); }
            else if (type === 'serverRequest/resolved') resolveApproval(p);
        } catch (error) { markUnavailable(fail(error.code ?? 'desktop_event_schema_drift', error.message)); }
    }

    function issueTicket(capability, invocation) {
        check();
        const caller = invocation.caller;
        if (!caller || typeof caller.pluginId !== 'string' || !Number.isSafeInteger(caller.generation)) throw fail('invalid_owner', 'API access requires a Core-authenticated caller');
        for (const [token, ticket] of tickets) if (ticket.expires < Date.now()) tickets.delete(token);
        if (tickets.size >= 64) throw fail('api_ticket_limit', 'At most 64 unclaimed API tickets are supported');
        const token = crypto.randomUUID();
        tickets.set(token, { capability, pluginId: caller.pluginId, generation: caller.generation, expires: Date.now() + 15000 });
        return { symbol: API_SYMBOL, api: 1, ticket: token };
    }
    function claimTicket(ctx, token, capability) {
        check(); owner(ctx, capability);
        const ticket = tickets.get(token);
        if (!ticket || ticket.expires < Date.now() || ticket.pluginId !== ctx.pluginId || ticket.generation !== ctx.generation || ticket.capability !== capability) throw fail('api_ticket_retired', 'API ticket is expired, already used, or belongs to another plugin/capability');
        tickets.delete(token);
    }
    const publicApi = Object.freeze({ api: 1,
        registerPreSubmit(ctx, ticket, options, handler) { claimTicket(ctx, ticket, CAPS.submit); return registerPreSubmit(ctx, options, handler); },
        registerThreadTransport(ctx, ticket, options, handler) { claimTicket(ctx, ticket, CAPS.transport); return threadTransport.register(ctx, options, handler); },
        onEvent(ctx, ticket, handler) { claimTicket(ctx, ticket, CAPS.events); return onEvent(ctx, handler); }
    });
    const api = Object.freeze({ api: 1, status: () => { check(); return status(); }, read, write, readEvents, onEvent, registerPreSubmit, listInterceptors, registerThreadTransport: threadTransport.register });
    function dispose() {
        if (!alive) return reloadReason ? { reloadRequired: true, reason: reloadReason } : undefined;
        alive = false;
        threadTransport.dispose();
        for (const pending of pendingSubmits) pending.controller.abort(fail('adapter_deactivated', 'Desktop adapter was deactivated'));
        for (const hook of hooks.values()) hook.active = false;
        hooks.clear(); listeners.clear(); approvals.clear(); retiredApprovals.clear(); tickets.clear(); events.length = 0; eventBytes = 0;
        for (const wake of [...waiters]) wake();
        for (const cleanup of cleanups.splice(0).reverse()) { try { cleanup(); } catch (error) { reloadReason ??= String(error.message ?? error); } }
        if (postbox.postMessage === intercept) postbox.postMessage = originalPost;
        else reloadReason ??= 'Another page patch replaced the Desktop submission hook';
        if (globalThis[symbol] === publicApi) delete globalThis[symbol];
        else reloadReason ??= 'Another page patch replaced the Desktop adapter API';
        return reloadReason ? { reloadRequired: true, reason: reloadReason } : undefined;
    }
    try {
        postbox.postMessage = intercept;
        Object.defineProperty(globalThis, symbol, { value: publicApi, configurable: true });
        cleanups.push(manager.addNotificationCallback(['thread/started', 'turn/started', 'turn/completed', 'item/started', 'item/completed', 'item/agentMessage/delta', 'item/commandExecution/outputDelta', 'serverRequest/resolved'], receive));
        cleanups.push(manager.addConversationStateCallback(threadId => { try { check(); syncApprovals(threadId); refreshSelection(threadId); } catch (error) { markUnavailable(fail(error.code ?? 'desktop_approval_schema_drift', error.message)); } }));
        try {
            if (!build.navigation) throw fail('desktop_navigation_unavailable', 'Task navigation has not been verified for this Desktop build');
            navigation = createNavigation(manager, () => refreshSelection(), connection.locateNavigator); cleanups.push(() => navigation.dispose());
        }
        catch (error) { navigationUnavailable(error); }
        cleanups.push(context.onDeactivate(dispose));
        const inspect = () => { if (!alive) throw fail('adapter_deactivated', 'Desktop adapter was deactivated'); try { check(); } catch {} return status(); };
        if (!compatibilityProvided) context.rpc.provide(CAPS.compatibility, 'probe', inspect);
        context.rpc.provide(CAPS.submit, 'getApi', (_args, invocation) => issueTicket(CAPS.submit, invocation));
        context.rpc.provide(CAPS.submit, 'interceptors.list', args => listInterceptors(args));
        context.rpc.provide(CAPS.transport, 'probe', args => { check(); fields(args ?? {}, []); return threadTransport.probe(); });
        context.rpc.provide(CAPS.transport, 'getApi', (_args, invocation) => issueTicket(CAPS.transport, invocation));
        context.rpc.provide(CAPS.transport, 'interceptors.list', args => threadTransport.list(args ?? {}));
        for (const method of ['selection.get', 'threads.list', 'threads.get', 'turns.list', 'items.list', 'models.list', 'skills.list', 'providers.list', 'approvals.list']) context.rpc.provide(CAPS.read, method, (args, invocation) => read(method, args ?? {}, invocation.signal));
        for (const method of ['threads.open', 'turns.start', 'turns.steer', 'turns.interrupt', 'approvals.respond']) context.rpc.provide(CAPS.write, method, (args, invocation) => write(method, args ?? {}, invocation.signal));
        context.rpc.provide(CAPS.events, 'read', (args, invocation) => readEvents(args ?? {}, invocation.signal));
        context.rpc.provide(CAPS.events, 'getApi', (_args, invocation) => issueTicket(CAPS.events, invocation));
        emit({ type: 'adapter.ready', connection: 'existing-desktop-local' });
        refreshSelection();
        return { api, dispose, probe: inspect };
    } catch (error) { dispose(); throw error; }
}

function startAdapter(context, probe = signal => probeDesktop(undefined, 30000, signal)) {
    let alive = true, inner, failure = null, settled = false;
    const controller = new AbortController(), waits = new Set();
    for (const capability of [CAPS.submit, CAPS.read, CAPS.write, CAPS.events, CAPS.transport]) context.rpc.unavailable(capability, 'Desktop adapter is waiting for the existing app-host services');
    const status = () => {
        if (!alive) throw fail('adapter_deactivated', 'Desktop adapter was deactivated');
        if (inner) return inner.probe();
        const detected = globalThis.electronBridge?.getSentryInitOptions?.();
        return { api: 1, initializing: !settled, available: false, unavailable: failure ?? { code: 'desktop_initializing', message: 'Waiting for the existing Desktop app-host services' }, build: { appVersion: optionalText(detected?.appVersion), buildNumber: optionalText(String(detected?.buildNumber ?? '')), appServerVersion: null }, connection: null, transport: null, inputRewrite: true, contextInjection: true, presentationTransform: false, historyMutation: false, hooks: 0, pendingSubmits: 0, navigation: { available: false, unavailable: failure } };
    };
    context.rpc.provide(CAPS.compatibility, 'probe', status);
    context.rpc.provide(CAPS.compatibility, 'waitReady', async (args, invocation) => {
        fields(args ?? {}, ['timeoutMs']);
        if (settled) return status();
        const timeout = bounded(args?.timeoutMs, 1000, 10000);
        if (waits.size >= 16) throw fail('readiness_wait_limit', 'At most 16 readiness waits are supported');
        if (invocation.signal.aborted) throw fail('invocation_cancelled', 'Readiness wait was cancelled');
        await new Promise((resolve, reject) => {
            let timer;
            const done = error => { clearTimeout(timer); waits.delete(wake); invocation.signal.removeEventListener('abort', abort); error ? reject(error) : resolve(); };
            const wake = () => alive ? done() : done(fail('adapter_deactivated', 'Desktop adapter was deactivated'));
            const abort = () => done(fail('invocation_cancelled', 'Readiness wait was cancelled'));
            waits.add(wake); invocation.signal.addEventListener('abort', abort, { once: true }); timer = setTimeout(() => done(), timeout);
        });
        return status();
    });
    const dispose = () => {
        if (alive) { alive = false; controller.abort(); for (const wake of [...waits]) wake(); }
        return inner?.dispose();
    };
    context.onDeactivate(dispose);
    Promise.resolve().then(() => probe(controller.signal)).then(connection => {
        if (!alive) return;
        inner = createAdapter(connection, context, { compatibilityProvided: true });
        try { context.reportDiagnostic({ code: 'desktop_adapter_ready', message: 'Existing Desktop services passed build and connection identity probes', level: 'info' }); } catch {}
    }).catch(error => {
        if (!alive) return;
        failure = { code: error.code ?? 'desktop_initialization_failed', message: optionalText(error.message) ?? 'Desktop adapter initialization failed' };
        for (const capability of [CAPS.submit, CAPS.read, CAPS.write, CAPS.events, CAPS.transport]) context.rpc.unavailable(capability, `${failure.code}: ${failure.message}`.slice(0, 1024));
        try { context.reportDiagnostic({ code: failure.code, message: failure.message }); } catch {}
    }).finally(() => { settled = true; for (const wake of [...waits]) wake(); });
    return { dispose, probe: status };
}

let active;
export function activate(context) {
        if (context.world !== 'main') throw fail('main_world_required', 'Codex Desktop Adapter requires the managed main-world ABI');
        if (typeof context.rpc.unavailable !== 'function' || typeof context.reportDiagnostic !== 'function') throw fail('renderer_abi_update_required', 'Update the Codlet managed renderer runtime before loading this adapter');
        validateDesktopBuild(false);
        active = startAdapter(context);
}
export function deactivate() { const current = active; active = undefined; return current?.dispose(); }
