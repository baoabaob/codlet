import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { randomUUID } from 'node:crypto';
import test from 'node:test';
import vm from 'node:vm';

const source = readFileSync(new URL('../bundled/codex-desktop-adapter/renderer.js', import.meta.url), 'utf8');
const plain = value => JSON.parse(JSON.stringify(value));
const tick = () => new Promise(resolve => setImmediate(resolve));

function fixture(buildIndex = 0, withNavigation = false) {
    const scope = vm.createContext({ module: { exports: {} }, setTimeout, clearTimeout, AbortController, URL, crypto: { randomUUID } });
    const create = vm.runInContext(source + '\ncreateAdapter', scope);
    const build = vm.runInContext('BUILDS', scope)[buildIndex];
    const endpoints = new Map(), cleanup = new Set(), sent = [], failures = [], callbacks = new Map(), approvals = [], requestCalls = [];
    const thread = { resumeState: 'resumed', requests: [], turns: [] }, threads = new Map([['thread-a', thread]]);
    const client = { requestPromises: new Map(), onError(id, error) { failures.push({ id, error }); this.requestPromises.delete(id); } };
    const original = message => { sent.push(message); };
    const postbox = { postMessage: original };
    const responses = new Map();
    const manager = {
        getConversation: id => threads.get(id) ?? null,
        getStreamRole: () => ({ role: 'owner' }),
        sendRequest: async (method, params) => { requestCalls.push({ method, params }); const result = responses.get(method); if (result instanceof Error) throw result; return typeof result === 'function' ? result(params) : result; },
        addNotificationCallback(methods, handler) { callbacks.set('notification', handler); return () => callbacks.delete('notification'); },
        addConversationStateCallback(handler) { callbacks.set('conversation', handler); return () => callbacks.delete('conversation'); },
        replyWithCommandExecutionApprovalDecision(...args) { approvals.push(['command', ...args]); },
        replyWithFileChangeApprovalDecision(...args) { approvals.push(['file', ...args]); },
        replyWithPermissionsRequestApprovalResponse(...args) { approvals.push(['permissions', ...args]); },
        replyWithUserInputResponse(...args) { approvals.push(['input', ...args]); }
    };
    const context = { world: 'main', pluginId: 'adapter', generation: 1, reportDiagnostic() {}, onDeactivate(fn) { cleanup.add(fn); return () => cleanup.delete(fn); }, rpc: { provide(cap, method, handler) { endpoints.set(cap.name + ':' + method, handler); }, unavailable(cap) { for (const key of endpoints.keys()) if (key.startsWith(cap.name + ':')) endpoints.delete(key); } } };
    let replaced = false;
    const navigationCalls = [];
    const navigator = {
        location: { pathname: '/local/thread-a', key: 'initial' },
        push(...args) { assert.equal(this, navigator); navigationCalls.push(['push', ...args]); this.location = { pathname: args[0], key: randomUUID() }; return 'native-push-result'; },
        replace(...args) { assert.equal(this, navigator); navigationCalls.push(['replace', ...args]); this.location = { pathname: args[0], key: randomUUID() }; return 'native-replace-result'; },
        go(...args) { assert.equal(this, navigator); navigationCalls.push(['go', ...args]); return 'native-go-result'; },
        listen() { assert.fail('Native router listener must not be replaced'); }
    };
    const nativeNavigation = { push: navigator.push, replace: navigator.replace, go: navigator.go, listen: navigator.listen };
    let currentNavigator = navigator;
    const adapter = create({ manager, client, postbox, build, ...(withNavigation ? { locateNavigator: () => currentNavigator } : {}), check() { if (replaced) throw Object.assign(new Error('connection replaced'), { code: 'desktop_connection_replaced' }); } }, context);
    const owners = [];
    function owner(id, generation = 1) {
        const disposers = new Set();
        const ctx = { world: 'main', pluginId: id, generation, onDeactivate(fn) { disposers.add(fn); return () => disposers.delete(fn); } };
        owners.push(disposers);
        return { ctx, stop() { for (const fn of [...disposers]) fn(); } };
    }
    function submit(text = 'original', options = {}) {
        const id = randomUUID(); client.requestPromises.set(id, {});
        const message = { type: 'mcp-request', hostId: 'local', request: { id, method: 'turn/start', params: { threadId: 'thread-a', input: [{ type: 'text', text, text_elements: [] }, { type: 'image', url: 'data:sample' }], additionalContext: { desktop: { kind: 'application', value: 'existing' } }, model: 'chosen-model', ...options } } };
        postbox.postMessage(message);
        return message;
    }
    return { ...adapter, context, scope, endpoints, cleanup, sent, failures, callbacks, approvals, requestCalls, client, postbox, original, thread, threads, navigator, nativeNavigation, navigationCalls, replaceNavigator(value) { currentNavigator = value; }, responses, owner, submit, connection: { manager, client, postbox, build, check() {} }, drift() { replaced = true; } };
}

test('ordered pre-submit rewrite/context preserves identities, attachment and Desktop options before dispatch', async () => {
    const f = fixture(), order = [];
    f.api.registerPreSubmit(f.owner('z-plugin').ctx, { id: 'last', priority: 1 }, draft => { order.push(['last', draft.text]); return { context: [{ text: 'plugin context' }] }; });
    f.api.registerPreSubmit(f.owner('b-plugin').ctx, { id: 'second' }, draft => { order.push(['second', draft.text]); return { text: draft.text + ' B' }; });
    f.api.registerPreSubmit(f.owner('a-plugin').ctx, { id: 'first' }, draft => { order.push(['first', draft.text]); assert.equal(Object.isFrozen(draft), true); return { text: draft.text + ' A' }; });
    const original = f.submit();
    assert.equal(f.sent.length, 0);
    await tick();
    assert.deepEqual(order, [['first', 'original'], ['second', 'original A'], ['last', 'original A B']]);
    assert.equal(f.sent.length, 1);
    const next = f.sent[0];
    assert.equal(next.request.id, original.request.id);
    assert.equal(next.request.params.threadId, 'thread-a');
    assert.equal(next.request.params.model, 'chosen-model');
    assert.equal(next.request.params.input[0].text, 'original A B');
    assert.deepEqual(plain(next.request.params.input[1]), { type: 'image', url: 'data:sample' });
    assert.deepEqual(plain(next.request.params.additionalContext.desktop), { kind: 'application', value: 'existing' });
    assert.equal(Object.values(next.request.params.additionalContext).at(-1).kind, 'untrusted');
    assert.equal(original.request.params.input[0].text, 'original');
    f.dispose();
});

test('failed, timed out and retired interceptors block the original UI request and identify the source', async () => {
    for (const mode of ['failure', 'timeout', 'retirement', 'adapter-retirement', 'request-retirement']) {
        const f = fixture(), owner = f.owner('source-plugin');
        let release, signal;
        f.api.registerPreSubmit(owner.ctx, { id: 'hook', timeoutMs: 10 }, (_draft, options) => {
            signal = options.signal;
            if (mode === 'failure') throw new Error('cannot prepare context');
            return new Promise(resolve => { release = resolve; });
        });
        const message = f.submit();
        await tick();
        if (mode === 'retirement') owner.stop();
        if (mode === 'adapter-retirement') f.dispose();
        if (mode === 'request-retirement') { f.client.requestPromises.delete(message.request.id); release({ text: 'late' }); }
        if (mode === 'timeout') await new Promise(resolve => setTimeout(resolve, 25));
        await tick();
        assert.equal(f.sent.length, 0, mode);
        if (mode !== 'request-retirement') {
            assert.equal(f.failures.length, 1, mode);
            assert.equal(f.failures[0].id, message.request.id);
            assert.match(f.failures[0].error.message, /source-plugin\/hook/);
        }
        if (mode !== 'request-retirement') assert.equal(signal.aborted, true);
        release?.({ text: 'must not send after retirement' }); await tick();
        assert.equal(f.sent.length, 0, mode);
        f.dispose();
    }
});

test('empty pipeline stays synchronous; lifecycle removes callbacks and reports lost patch ownership', async () => {
    const f = fixture();
    f.submit(); assert.equal(f.sent.length, 1);
    const owner = f.owner('consumer');
    f.api.registerPreSubmit(owner.ctx, { id: 'hook' }, () => undefined);
    f.api.onEvent(owner.ctx, () => assert.fail('retired listener ran'));
    owner.stop();
    assert.equal(f.api.status().hooks, 0);
    assert.equal(f.dispose(), undefined);
    assert.equal(f.postbox.postMessage, f.original);
    assert.equal(f.callbacks.size, 0);
    assert.equal(f.scope[Symbol.for('codlet.codex.desktop.v1')], undefined);
    assert.throws(() => f.api.status(), { code: 'adapter_deactivated' });
    const drift = fixture(); const patch = () => {}; drift.postbox.postMessage = patch;
    assert.equal(drift.dispose().reloadRequired, true);
    assert.equal(drift.postbox.postMessage, patch);
    assert.equal(drift.dispose().reloadRequired, true);
});

test('stable read DTOs keep Thread/Turn/Item identity and do not return provider secrets', async () => {
    const f = fixture();
    f.responses.set('thread/read', { thread: { id: 'thread-a', preview: 'task', modelProvider: 'p', cwd: 'C:/work', privateEnvelope: 'hidden' } });
    f.responses.set('thread/turns/list', { data: [{ id: 'turn-a', status: 'completed', items: [], privateField: true }], nextCursor: 'next' });
    f.responses.set('thread/items/list', { data: [{ turnId: 'turn-a', item: { id: 'item-a', type: 'agentMessage', text: 'answer', privateField: true } }] });
    f.responses.set('config/read', { config: { model_provider: 'private', model_providers: { private: { name: 'Provider', experimental_bearer_token: 'secret', http_headers: { authorization: 'secret' }, base_url: 'secret' } } }, origins: { credentials: 'secret' } });
    assert.equal((await f.api.read('threads.get', { threadId: 'thread-a' })).id, 'thread-a');
    assert.equal((await f.api.read('turns.list', { threadId: 'thread-a' })).turns[0].id, 'turn-a');
    const items = await f.api.read('items.list', { threadId: 'thread-a' });
    assert.equal(items.items[0].turnId, 'turn-a'); assert.equal(items.items[0].item.id, 'item-a');
    assert.equal(items.items[0].item.privateField, undefined);
    const providers = await f.api.read('providers.list');
    assert.deepEqual(plain(providers), { providers: [{ id: 'private', name: 'Provider', selected: true }] });
    await assert.rejects(f.api.read('ipc.send', { channel: 'arbitrary' }), { code: 'method_not_found' });
    await assert.rejects(f.api.read('threads.get', { threadId: 'thread-a', hostId: 'remote' }), { code: 'invalid_argument' });
    f.dispose();
});

test('writes use the existing request client, enforce loaded owner identity, and reject connection replacement', async () => {
    const f = fixture();
    f.responses.set('turn/start', { turn: { id: 'turn-a', status: 'inProgress', items: [] } });
    f.responses.set('turn/steer', { turnId: 'turn-a' });
    const result = await f.api.write('turns.start', { threadId: 'thread-a', text: 'hello' });
    assert.equal(result.turn.id, 'turn-a');
    assert.match(f.requestCalls[0].params.clientUserMessageId, /^[a-f0-9-]{36}$/);
    const { clientUserMessageId, ...params } = plain(f.requestCalls[0].params);
    assert.deepEqual(params, { threadId: 'thread-a', input: [{ type: 'text', text: 'hello', text_elements: [] }] });
    await f.api.write('turns.steer', { threadId: 'thread-a', turnId: 'turn-a', text: 'follow up' });
    assert.equal(f.requestCalls[1].params.expectedTurnId, 'turn-a');
    await f.api.write('turns.interrupt', { threadId: 'thread-a', turnId: 'turn-a' });
    assert.equal(f.requestCalls[2].params.turnId, 'turn-a');
    await assert.rejects(f.api.write('turns.start', { threadId: 'not-loaded', text: 'hello' }), { code: 'desktop_thread_not_loaded' });
    f.drift();
    await assert.rejects(f.api.write('turns.start', { threadId: 'thread-a', text: 'hello' }), { code: 'desktop_connection_replaced' });
    assert.equal(f.requestCalls.length, 3);
    f.dispose();
});

test('approval and server-request replies bind opaque handles to the pending Desktop request and retire once', async () => {
    const f = fixture();
    f.thread.requests.push({ id: 71, method: 'item/commandExecution/requestApproval', params: { threadId: 'thread-a', turnId: 'turn-a', itemId: 'command-a', command: 'echo sample', cwd: 'C:/sample' } });
    f.thread.requests.push({ id: 'input-id', method: 'item/tool/requestUserInput', params: { threadId: 'thread-a', turnId: 'turn-a', itemId: 'input-a', questions: [{ id: 'q1', header: 'Choice', question: 'Which?', options: [{ label: 'A', description: 'option A' }] }] } });
    f.callbacks.get('conversation')('thread-a');
    const requests = (await f.api.read('approvals.list', { threadId: 'thread-a' })).requests;
    assert.equal(requests.length, 2); assert.equal(requests[0].requestId, undefined);
    assert.equal((await f.api.write('approvals.respond', { token: requests[0].token, decision: 'decline' })).status, 'submitted');
    assert.deepEqual(f.approvals[0], ['command', 'thread-a', 71, 'decline']);
    await assert.rejects(f.api.write('approvals.respond', { token: requests[0].token, decision: 'approve' }), { code: 'approval_retired' });
    await f.api.write('approvals.respond', { token: requests[1].token, answers: { q1: ['A'] } });
    assert.deepEqual(plain(f.approvals[1]), ['input', 'thread-a', 'input-id', { answers: { q1: { answers: ['A'] } } }]);
    f.thread.requests = []; f.callbacks.get('conversation')('thread-a');
    assert.equal((await f.api.read('approvals.list', { threadId: 'thread-a' })).requests.length, 0);
    f.dispose();
});

test('bounded event stream preserves UI ids, reports overflow, cancels waits, and rejects old instance cursors', async () => {
    const f = fixture();
    const start = await f.api.readEvents();
    const controller = new AbortController();
    const waiting = f.api.readEvents({ cursor: start.cursor, waitMs: 1000 }, controller.signal);
    f.callbacks.get('notification')({ method: 'item/completed', params: { threadId: 'thread-a', turnId: 'turn-a', item: { id: 'item-a', type: 'agentMessage', text: 'answer' } } });
    const next = await waiting;
    assert.equal(next.events[0].threadId, 'thread-a'); assert.equal(next.events[0].turnId, 'turn-a'); assert.equal(next.events[0].item.id, 'item-a');
    for (let index = 0; index < 300; index++) f.callbacks.get('notification')({ method: 'item/agentMessage/delta', params: { threadId: 'thread-a', turnId: 'turn-a', itemId: 'item-a', delta: 'x' } });
    assert.equal((await f.api.readEvents({ cursor: start.cursor })).gap, true);
    const cursor = (await f.api.readEvents()).cursor;
    const aborted = f.api.readEvents({ cursor, waitMs: 1000 }, controller.signal);
    controller.abort(); await assert.rejects(aborted, { code: 'invocation_cancelled' });
    const retired = f.api.readEvents({ cursor, waitMs: 1000 });
    f.dispose(); await assert.rejects(retired, { code: 'adapter_deactivated' });
    const newer = fixture(); await assert.rejects(newer.api.readEvents({ cursor }), { code: 'event_cursor_retired' }); newer.dispose();
});

test('public page API exposes only callbacks and requires one-use tickets from the declared Core capability', () => {
    const f = fixture(), owner = f.owner('consumer'), other = f.owner('other');
    const exposed = f.scope[Symbol.for('codlet.codex.desktop.v1')];
    assert.deepEqual(Object.keys(exposed).sort(), ['api', 'onEvent', 'registerPreSubmit', 'registerThreadTransport']);
    const ticket = f.endpoints.get('codex.ui.preSubmit:getApi')({}, { caller: { pluginId: 'consumer', generation: 1 } }).ticket;
    assert.throws(() => exposed.registerPreSubmit(other.ctx, ticket, { id: 'test' }, () => {}), { code: 'api_ticket_retired' });
    assert.throws(() => exposed.onEvent(owner.ctx, ticket, () => {}), { code: 'api_ticket_retired' });
    exposed.registerPreSubmit(owner.ctx, ticket, { id: 'test' }, () => {});
    assert.throws(() => exposed.registerPreSubmit(owner.ctx, ticket, { id: 'again' }, () => {}), { code: 'api_ticket_retired' });
    owner.stop(); assert.equal(f.api.status().hooks, 0); f.dispose();
});

test('unknown builds and uninitialized Desktop state fail before a connection can be created', async () => {
    const scope = vm.createContext({ module: { exports: {} }, location: { origin: 'app://-', pathname: '/index.html' }, document: { scripts: [], getElementById: () => null }, electronBridge: { getSentryInitOptions: () => ({ appVersion: 'unknown', buildNumber: '0' }) } });
    const probe = vm.runInContext(source + '\nprobeDesktop', scope);
    let imports = 0;
    await assert.rejects(probe(async () => { imports++; }), { code: 'desktop_build_drift' });
    assert.equal(imports, 0);
    scope.electronBridge.getSentryInitOptions = () => ({ appVersion: '26.903.61454', buildNumber: '8378' });
    scope.electronBridge.sendMessageFromView = () => assert.fail('probing must not send preload messages');
    scope.document.scripts.push({ src: 'app://-/assets/index-71057a3aecef.js' });
    await assert.rejects(probe(async () => { imports++; return {}; }, 0), { code: 'desktop_scope_missing' });
    assert.equal(imports, 1);
});

test('permission approval with unmapped path kinds can only be declined through this SDK', async () => {
    const f = fixture();
    f.thread.requests.push({ id: 'permission-id', method: 'item/permissions/requestApproval', params: { threadId: 'thread-a', turnId: 'turn-a', itemId: 'permission-item', permissions: { fileSystem: { entries: [{ access: 'write', path: { type: 'special', value: { kind: 'root' } } }] } } } });
    const request = (await f.api.read('approvals.list', { threadId: 'thread-a' })).requests[0];
    assert.equal(request.canApprove, false); assert.equal(request.permissions.hasOtherPaths, true);
    await assert.rejects(f.api.write('approvals.respond', { token: request.token, decision: 'approve' }), { code: 'unsupported_permissions' });
    assert.equal(f.approvals.length, 0);
    await f.api.write('approvals.respond', { token: request.token, decision: 'decline' });
    assert.deepEqual(plain(f.approvals[0]), ['permissions', 'thread-a', 'permission-id', { permissions: {}, scope: 'turn' }]);
    f.dispose();
});

test('local literal-path permission entries expose every requested path and preserve the exact approved profile', async () => {
    for (const legacy of [false, true]) {
        const f = fixture();
        const permissions = { network: null, fileSystem: { entries: [{ access: 'write', path: { type: 'path', path: 'C:/lab/temp' } }], read: null, write: legacy ? ['C:/lab/temp'] : null } };
        f.thread.requests.push({ id: 'permission-id', method: 'item/permissions/requestApproval', params: { threadId: 'thread-a', turnId: 'turn-a', itemId: 'permission-item', environmentId: 'local', permissions } });
        const request = (await f.api.read('approvals.list', { threadId: 'thread-a' })).requests[0];
        assert.equal(request.canApprove, true);
        assert.deepEqual(plain(request.permissions), { network: false, read: [], write: ['C:/lab/temp'], hasOtherPaths: false });
        await f.api.write('approvals.respond', { token: request.token, decision: 'approve' });
        assert.deepEqual(plain(f.approvals[0]), ['permissions', 'thread-a', 'permission-id', { permissions, scope: 'turn' }]);
        f.dispose();
    }
    const scope = vm.createContext({ module: { exports: {} } });
    const project = vm.runInContext(source + '\npermissionsDto', scope);
    for (const params of [
        { environmentId: 'remote', permissions: {} },
        { permissions: { fileSystem: { entries: [{ access: 'deny', path: { type: 'path', path: 'C:/lab' } }] } } },
        { permissions: { fileSystem: { entries: [{ access: 'write', path: { type: 'glob_pattern', pattern: '**' } }] } } },
        { permissions: { fileSystem: { entries: 'changed' } } },
        { permissions: { fileSystem: { read: 'changed' } } },
        { permissions: { fileSystem: { globScanMaxDepth: 0 } } },
        { permissions: { network: { enabled: 'changed' } } },
    ]) assert.equal(project(params).canApprove, false);
});

test('schema or event identity drift closes semantic operations while diagnostics remain readable', async () => {
    for (const source of ['response', 'event']) {
        const f = fixture(), cursor = (await f.api.readEvents()).cursor;
        if (source === 'response') {
            f.responses.set('thread/read', { thread: { id: null } });
            await assert.rejects(f.api.read('threads.get', { threadId: 'thread-a' }), { code: 'desktop_schema_drift' });
        } else f.callbacks.get('notification')({ method: 'item/completed', params: { threadId: 'thread-a', turnId: null, item: { id: 'item-a', type: 'agentMessage', text: 'sample' } } });
        await assert.rejects(f.api.write('turns.start', { threadId: 'thread-a', text: 'must not dispatch' }), { code: 'capability_unavailable' });
        const diagnostics = f.endpoints.get('codex.desktop.compatibility:probe')();
        assert.equal(diagnostics.available, false); assert.ok(diagnostics.unavailable.message);
        const events = await f.api.readEvents({ cursor }); assert.equal(events.events.at(-1).type, 'adapter.drift');
        assert.equal(f.requestCalls.filter(request => request.method === 'turn/start').length, 0);
        f.dispose();
    }
});

test('approval resolution is confirmed by the server, separately from optimistic Desktop retirement', async () => {
    const f = fixture(), observed = [];
    f.api.onEvent(f.owner('consumer').ctx, event => observed.push(event));
    f.thread.requests.push({ id: 3, method: 'item/commandExecution/requestApproval', params: { threadId: 'thread-a', turnId: 'turn-a', itemId: 'item-a', availableDecisions: ['accept', 'cancel'] } });
    const request = (await f.api.read('approvals.list', { threadId: 'thread-a' })).requests[0];
    await f.api.write('approvals.respond', { token: request.token, decision: 'decline' });
    assert.equal(f.approvals[0].at(-1), 'cancel');
    f.thread.requests = []; f.callbacks.get('conversation')('thread-a');
    assert.equal(observed.at(-1).type, 'approval.retired');
    assert.equal(observed.some(event => event.type === 'approval.resolved'), false);
    f.callbacks.get('notification')({ method: 'serverRequest/resolved', params: { threadId: 'thread-a', requestId: 3 } });
    assert.equal(observed.at(-1).type, 'approval.resolved'); assert.equal(observed.at(-1).token, request.token);
    f.dispose();
});

test('slow Desktop readiness leaves semantic handlers unpublished and finishes without blocking plugin activation', async () => {
    const f = fixture(); f.dispose(); f.endpoints.clear();
    const start = vm.runInContext('startAdapter', f.scope);
    let complete;
    const connection = new Promise(resolve => { complete = resolve; });
    const pending = start(f.context, () => connection);
    assert.equal(pending.probe().initializing, true);
    assert.deepEqual([...f.endpoints.keys()].sort(), ['codex.desktop.compatibility:probe', 'codex.desktop.compatibility:waitReady']);
    const waiting = f.endpoints.get('codex.desktop.compatibility:waitReady')({ timeoutMs: 1000 }, { signal: new AbortController().signal });
    complete(f.connection);
    assert.equal((await waiting).available, true);
    assert.equal(pending.probe().initializing, false);
    assert.ok(f.endpoints.has('codex.backend.write:turns.start'));
    pending.dispose(); assert.equal(f.callbacks.size, 0);
});

test('retiring a pending initializer prevents late page patches; failed readiness remains diagnosable', async () => {
    for (const mode of ['cancel', 'failure']) {
        const f = fixture(); f.dispose(); f.endpoints.clear();
        const reported = []; f.context.reportDiagnostic = value => reported.push(value);
        const start = vm.runInContext('startAdapter', f.scope);
        let complete, reject;
        const connection = new Promise((resolve, fail) => { complete = resolve; reject = fail; });
        const pending = start(f.context, () => connection);
        if (mode === 'cancel') { pending.dispose(); complete(f.connection); }
        else reject(Object.assign(new Error('test schema mismatch'), { code: 'desktop_schema_drift' }));
        await tick();
        assert.equal(f.scope[Symbol.for('codlet.codex.desktop.v1')], undefined);
        assert.equal(f.postbox.postMessage, f.original);
        assert.equal(f.endpoints.has('codex.backend.read:threads.list'), false);
        if (mode === 'failure') { assert.equal(pending.probe().initializing, false); assert.equal(pending.probe().available, false); assert.equal(reported[0].code, 'desktop_schema_drift'); pending.dispose(); }
    }
});

test('probing a family descriptor never constructs a missing local manager or request client', async () => {
    const scope = vm.createContext({ module: { exports: {} }, location: { origin: 'app://-', pathname: '/index.html' }, electronBridge: { getSentryInitOptions: () => ({ appVersion: '26.903.61454', buildNumber: '8378' }), sendMessageFromView() {} } });
    vm.runInContext(source, scope);
    const module = vm.runInContext(`(() => {
        const token = { id: 'AppScope' }, manager = { read() { throw Error('must not construct manager'); } }, client = { read() { throw Error('must not construct client'); } };
        const node = { token, store: {}, familyBindings: new Map([[manager, new Map()], [client, new Map()]]) };
        const root = { __reactContainer$test: { memoizedProps: { value: new Map([[token.id, node]]) } } };
        globalThis.document = { scripts: [{ src: 'app://-/assets/index-71057a3aecef.js' }], getElementById: () => root };
        return { t3t: token, Mwt: manager, Nwt: client };
    })()`, scope);
    await assert.rejects(vm.runInContext('probeDesktop', scope)(async () => module, 0), { code: 'desktop_connection_not_ready' });
});

test('each reviewed profile waits for live exports, reuses its initialized connection and rejects build replacement', async () => {
    const versions = ['26.903.61454', '26.903.71938', '26.908.40834', '26.908.70816'];
    for (const buildIndex of [0, 1, 2, 3]) {
        const f = fixture(buildIndex);
        assert.deepEqual(Object.keys(plain(f.api.status().build)).sort(), ['appServerVersion', 'appVersion', 'buildNumber']);
        assert.equal(f.api.status().build.appVersion, versions[buildIndex]);
        f.dispose();
        const scope = vm.createContext({ module: { exports: {} }, setTimeout, clearTimeout, location: { origin: 'app://-', pathname: '/index.html' } });
        vm.runInContext(source, scope);
        scope.buildIndex = buildIndex;
        const module = vm.runInContext(`(() => {
            const build = BUILDS[buildIndex], token = { id: 'AppScope' };
            const client = { requestPromises: new Map(), getAppServerVersion: () => build.appServerVersion, onError() {} };
            const manager = { requestClient: client, getHostId: () => 'local' };
            for (const name of ['sendRequest', 'getConversation', 'getStreamRole', 'addNotificationCallback', 'addConversationStateCallback', 'replyWithCommandExecutionApprovalDecision', 'replyWithFileChangeApprovalDecision', 'replyWithPermissionsRequestApprovalResponse', 'replyWithUserInputResponse']) manager[name] = () => {};
            const managerFamily = { read: () => manager }, clientFamily = { read: () => client };
            const node = { token, store: {}, familyBindings: new Map([[managerFamily, new Map([['local', {}]])], [clientFamily, new Map([['local', {}]])]]) };
            const root = { __reactContainer$test: { memoizedProps: { value: new Map([[token.id, node]]) } } };
            globalThis.document = { scripts: [{ src: build.entry }], getElementById: () => root };
            globalThis.electronBridge = { getSentryInitOptions: () => build, sendMessageFromView() { throw Error('must not open another app-host port'); } };
            return { [build.exports.scope]: token, [build.exports.manager]: managerFamily, [build.exports.client]: clientFamily, [build.exports.services]: {}, [build.exports.postbox]: { postMessage() {} } };
        })()`, scope);
        const build = vm.runInContext('BUILDS[buildIndex]', scope);
        const delayed = {}, delayedTransport = {}, imports = [];
        const connection = await vm.runInContext('probeDesktop', scope)(async resource => {
            imports.push(resource);
            if (resource === build.module) {
                setTimeout(() => Object.assign(delayed, module), 1);
                return delayed;
            }
            assert.equal(resource, build.postboxModule);
            setTimeout(() => Object.assign(delayedTransport, { [build.exports.postbox]: module[build.exports.postbox] }), 75);
            return delayedTransport;
        }, 500);
        assert.deepEqual(imports, build.postboxModule ? [build.module, build.postboxModule] : [build.module]);
        connection.check();
        assert.equal(connection.build, build);
        scope.document.scripts[0].src = 'app://-/assets/unreviewed.js';
        assert.throws(() => connection.check(), { code: 'desktop_build_drift' });
        scope.document.scripts[0].src = build.entry;
        scope.electronBridge.getSentryInitOptions = () => ({ appVersion: build.appVersion, buildNumber: 'changed' });
        assert.throws(() => connection.check(), { code: 'desktop_build_drift' });
    }
});

function latestProbeFixture() {
    const scope = vm.createContext({ module: { exports: {} }, setTimeout, clearTimeout, location: { origin: 'app://-', pathname: '/index.html' } });
    vm.runInContext(source, scope);
    const native = vm.runInContext(`(() => {
        const build = BUILDS[2], token = { id: 'AppScope' }, accesses = [];
        const client = { requestPromises: new Map(), getAppServerVersion: () => '0.154.0-alpha.6.2', onError() {} };
        const manager = { requestClient: client, getHostId: () => 'local' };
        for (const name of ['sendRequest', 'getConversation', 'getStreamRole', 'addNotificationCallback', 'addConversationStateCallback', 'replyWithCommandExecutionApprovalDecision', 'replyWithFileChangeApprovalDecision', 'replyWithPermissionsRequestApprovalResponse', 'replyWithUserInputResponse']) manager[name] = () => {};
        const managerFamily = { read(node, chain, key) { accesses.push(['manager', key]); if (!node.familyBindings.get(this)?.has(key) || chain.get(token.id) !== node) throw Error('must reuse initialized AppScope'); return manager; } };
        const clientFamily = { read(node, chain, key) { accesses.push(['client', key]); if (!node.familyBindings.get(this)?.has(key) || chain.get(token.id) !== node) throw Error('must reuse initialized AppScope'); return client; } };
        const node = { token, store: {}, familyBindings: new Map([[managerFamily, new Map([['local', {}]])], [clientFamily, new Map([['local', {}]])]]) };
        const root = { __reactContainer$test: { memoizedProps: { value: new Map([[token.id, node]]) } } };
        globalThis.document = { scripts: [{ src: 'app://-/assets/index-cbd874f72008.js' }], getElementById: () => root };
        globalThis.electronBridge = { getSentryInitOptions: () => ({ appVersion: '26.908.40834', buildNumber: '8881' }), sendMessageFromView() { throw Error('probing must not send or create an app-host port'); } };
        const actualPostbox = { postMessage() {} }, decoyPostbox = { postMessage() { throw Error('retired re-export must not be patched'); } };
        return { build, manager, client, accesses, node, managerFamily, clientFamily, actualPostbox,
            appModule: { e6t: token, cDt: managerFamily, lDt: clientFamily, TW: {}, i: decoyPostbox, Emn: decoyPostbox },
            transportModule: { i: actualPostbox } };
    })()`, scope);
    const imports = [];
    const probe = vm.runInContext('probeDesktop', scope);
    const load = async resource => {
        imports.push(resource);
        if (resource === 'app://-/assets/app-initial-d9bed9d614d8.js') return native.appModule;
        assert.equal(resource, 'app://-/assets/get-trusted-message-for-view-eee599500f15.js');
        return native.transportModule;
    };
    return { scope, native, imports, probe: () => probe(load, 0) };
}

test('8881 uses the audited split postbox export and detects replacement without importing another connection', async () => {
    const f = latestProbeFixture(), connection = await f.probe();
    assert.equal(connection.postbox, f.native.actualPostbox);
    assert.deepEqual(f.imports, ['app://-/assets/app-initial-d9bed9d614d8.js', 'app://-/assets/get-trusted-message-for-view-eee599500f15.js']);
    assert.deepEqual(plain(f.native.accesses), [['manager', 'local'], ['client', 'local']]);
    f.native.appModule.i = {}; f.native.appModule.Emn = {};
    connection.check();
    f.native.transportModule.i = { postMessage() {} };
    assert.throws(() => connection.check(), { code: 'desktop_connection_replaced' });
    assert.equal(f.imports.length, 2);
});

test('8881 rejects unmatched entry, backend schema, manager ABI, and immutable transport before interception', async () => {
    for (const [change, code] of [
        [f => { f.scope.document.scripts[0].src = 'app://-/assets/index-5232d4cce9a2.js'; f.scope.document.readyState = 'complete'; }, 'desktop_build_drift'],
        [f => { f.scope.electronBridge.getSentryInitOptions = () => ({ appVersion: '26.908.40834', buildNumber: '8882' }); }, 'desktop_build_drift'],
        [f => { f.native.client.getAppServerVersion = () => '0.153.4'; }, 'desktop_connection_drift'],
        [f => { f.native.manager.sendRequest = undefined; }, 'desktop_manager_drift'],
        [f => { Object.defineProperty(f.native.actualPostbox, 'postMessage', { writable: false }); }, 'desktop_transport_drift'],
        [f => { delete f.native.transportModule.i; }, 'desktop_connection_not_ready'],
        [f => { f.native.node.familyBindings.get(f.native.clientFamily).delete('local'); }, 'desktop_connection_not_ready'],
    ]) {
        const f = latestProbeFixture(), original = f.native.actualPostbox.postMessage;
        change(f);
        await assert.rejects(f.probe(), { code });
        assert.equal(f.native.actualPostbox.postMessage, original);
        if (code === 'desktop_build_drift') assert.equal(f.imports.length, 0);
        if (code === 'desktop_connection_not_ready' && !f.native.node.familyBindings.get(f.native.clientFamily).has('local')) assert.equal(f.native.accesses.length, 0);
    }
});

test('8881 preserves reviewed turn identities, added Desktop options, history selection and one-use approval replies', async () => {
    const f = fixture(2, true);
    f.api.registerPreSubmit(f.owner('rewrite').ctx, { id: 'rewrite' }, draft => ({ text: draft.text + ' amended', context: [{ text: 'untrusted supplement' }] }));
    const submitted = f.submit('original', { serviceTierForTurn: 'default', environments: [{ environmentId: 'local', cwd: 'C:/fixture' }] });
    await tick();
    assert.equal(f.sent[0].request.id, submitted.request.id);
    assert.equal(f.sent[0].request.params.serviceTierForTurn, 'default');
    assert.deepEqual(plain(f.sent[0].request.params.environments), [{ environmentId: 'local', cwd: 'C:/fixture' }]);
    assert.equal(f.sent[0].request.params.input[0].text, 'original amended');
    assert.equal(Object.values(f.sent[0].request.params.additionalContext).at(-1).kind, 'untrusted');
    f.responses.set('turn/start', { turn: { id: 'turn-new', status: 'inProgress', items: [], itemsView: 'full', startedAt: 10 } });
    assert.equal((await f.api.write('turns.start', { threadId: 'thread-a', text: 'fixture text', effort: 'high' })).turn.id, 'turn-new');
    assert.match(f.requestCalls.at(-1).params.clientUserMessageId, /^[a-f0-9-]{36}$/);
    f.responses.set('turn/steer', { turnId: 'turn-new' });
    await f.api.write('turns.steer', { threadId: 'thread-a', turnId: 'turn-new', text: 'fixture follow-up' });
    assert.equal(f.requestCalls.at(-1).params.expectedTurnId, 'turn-new');
    f.thread.turnHistory = { kind: 'canonical', history: { islands: [{ entries: [{ value: 'old' }] }], entitiesByKey: { old: { turnId: 'turn-old', status: 'completed' } } } };
    f.thread.turns = [{ turnId: 'turn-new', status: 'inProgress' }];
    assert.equal((await f.api.read('selection.get')).activeTurnId, 'turn-new');
    f.thread.requests.push({ id: 71, method: 'item/tool/requestUserInput', params: { threadId: 'thread-a', turnId: 'turn-new', itemId: 'input-a', questions: [{ id: 'q', header: 'Choice', question: 'Choose', options: [] }] } });
    const request = (await f.api.read('approvals.list', { threadId: 'thread-a' })).requests[0];
    await f.api.write('approvals.respond', { token: request.token, answers: { q: ['fixture answer'] } });
    assert.deepEqual(plain(f.approvals[0]), ['input', 'thread-a', 71, { answers: { q: { answers: ['fixture answer'] } } }]);
    await assert.rejects(f.api.write('approvals.respond', { token: request.token, answers: { q: ['repeat'] } }), { code: 'approval_retired' });
    f.dispose();
    assert.equal(f.postbox.postMessage, f.original);
});

test('selection follows Native router operations and projects canonical history plus the live turn', async () => {
    const f = fixture(1, true), changes = [];
    f.api.onEvent(f.owner('observer').ctx, event => { if (event.type === 'selection.changed') changes.push(event); });
    assert.deepEqual(plain(await f.api.read('selection.get')), { threadId: 'thread-a', activeTurnId: null, activeTurnKnown: true, resumeState: 'resumed', streamRole: 'owner' });
    f.thread.turnHistory = { kind: 'canonical', history: { islands: [{ entries: [{ value: 'old' }] }], entitiesByKey: { old: { turnId: 'turn-old', status: 'completed' } } } };
    f.thread.turns = [{ turnId: 'turn-live', status: 'inProgress' }];
    f.callbacks.get('conversation')('thread-a');
    assert.equal(changes.at(-1).activeTurnId, 'turn-live');
    const count = changes.length; f.callbacks.get('conversation')('thread-a'); assert.equal(changes.length, count);
    f.thread.turns[0].status = 'completed'; f.callbacks.get('conversation')('thread-a');
    assert.equal(changes.at(-1).activeTurnId, null);
    assert.equal(f.navigator.replace('/settings', { native: 'state' }), 'native-replace-result');
    assert.equal(changes.at(-1).threadId, null);
    assert.equal(f.navigator.go(-1), 'native-go-result');
    assert.deepEqual(f.navigationCalls, [['replace', '/settings', { native: 'state' }], ['go', -1]]);
    assert.equal(f.navigator.listen, f.nativeNavigation.listen);
    f.dispose(); for (const key of Object.keys(f.nativeNavigation)) assert.equal(f.navigator[key], f.nativeNavigation[key]);
});

test('opening a cold task navigates once and lets Native publish resume and follower ownership', async () => {
    const f = fixture(1, true);
    f.responses.set('thread/read', { thread: { id: 'thread-cold' } });
    const result = await f.api.write('threads.open', { threadId: 'thread-cold' });
    assert.equal(result.status, 'opening'); assert.equal(result.activeTurnKnown, false);
    assert.deepEqual(f.navigationCalls, [['push', '/local/thread-cold']]);
    assert.deepEqual(plain(f.requestCalls), [{ method: 'thread/read', params: { threadId: 'thread-cold', includeTurns: false } }]);
    await assert.rejects(f.api.write('turns.start', { threadId: 'thread-cold', text: 'wait' }), { code: 'desktop_thread_not_loaded' });
    f.threads.set('thread-cold', { resumeState: 'resumed', requests: [], turns: [] });
    f.connection.manager.getStreamRole = () => ({ role: 'follower' }); f.callbacks.get('conversation')('thread-cold');
    const selected = await f.api.read('selection.get'); assert.equal(selected.resumeState, 'resumed'); assert.equal(selected.streamRole, 'follower');
    const again = await f.api.write('threads.open', { threadId: 'thread-cold' });
    assert.equal(again.status, 'opened'); assert.equal(again.alreadySelected, true); assert.equal(f.navigationCalls.length, 1);
    await assert.rejects(f.api.write('turns.start', { threadId: 'thread-cold', text: 'wait' }), { code: 'desktop_thread_follower' });
    f.dispose();
});

test('invalid, cancelled, concurrent and superseded open requests never replace a newer user route', async () => {
    const f = fixture(1, true);
    await assert.rejects(f.api.write('threads.open', { threadId: '../escape' }), { code: 'invalid_argument' });
    const signal = new AbortController(); signal.abort();
    await assert.rejects(f.api.write('threads.open', { threadId: 'cold' }, signal.signal), { code: 'invocation_cancelled' });
    let release; f.responses.set('thread/read', () => new Promise(resolve => { release = resolve; }));
    const pending = f.api.write('threads.open', { threadId: 'cold' });
    await assert.rejects(f.api.write('threads.open', { threadId: 'other' }), { code: 'desktop_navigation_busy' });
    f.navigator.push('/local/user-selected'); release({ thread: { id: 'cold' } });
    await assert.rejects(pending, { code: 'desktop_navigation_superseded' });
    assert.equal(f.navigator.location.pathname, '/local/user-selected'); assert.equal(f.navigationCalls.length, 1);
    f.responses.set('thread/read', { thread: { id: 'different' } });
    await assert.rejects(f.api.write('threads.open', { threadId: 'cold' }), { code: 'desktop_navigation_unavailable' });
    assert.equal(f.navigationCalls.length, 1); f.dispose();
});

test('navigation drift only disables selection and open, and preserves another patch on retirement', async () => {
    const f = fixture(1, true), replacement = () => {};
    f.navigator.push = replacement;
    await assert.rejects(f.api.read('selection.get'), { code: 'desktop_navigation_drift' });
    assert.equal(f.probe().available, true); assert.equal(f.probe().navigation.available, false);
    f.responses.set('thread/read', { thread: { id: 'thread-a' } });
    assert.equal((await f.api.read('threads.get', { threadId: 'thread-a' })).id, 'thread-a');
    assert.equal(f.dispose().reloadRequired, true); assert.equal(f.navigator.push, replacement);
    assert.equal(f.navigator.replace, f.nativeNavigation.replace);
    const old = fixture(0, true); assert.equal(old.probe().available, true); assert.equal(old.probe().navigation.available, false);
    await assert.rejects(old.api.read('selection.get'), { code: 'desktop_navigation_unavailable' }); old.dispose();
});

test('active turn projection preserves terminal snapshots and reports unsupported history as unknown', () => {
    const f = fixture(), project = vm.runInContext('activeTurnState', f.scope);
    const terminal = { turnId: 'turn-a', status: 'completed', itemsPagination: {} };
    const thread = { resumeState: 'resumed', turns: [{ turnId: 'turn-a', status: 'inProgress' }], turnHistory: { kind: 'canonical', history: { islands: [{ entries: [{ value: 'a' }] }], entitiesByKey: { a: terminal } } } };
    assert.deepEqual(plain(project(thread)), { activeTurnId: null, activeTurnKnown: true });
    delete terminal.itemsPagination; assert.equal(project(thread).activeTurnId, 'turn-a');
    terminal.status = 'future-status'; assert.equal(project(thread).activeTurnKnown, false);
    delete thread.turnHistory; thread.turns = []; assert.equal(project(thread).activeTurnKnown, true);
    thread.resumeState = 'loading'; assert.equal(project(thread).activeTurnKnown, false); f.dispose();
});

test('interceptor diagnostics preserve execution order and omit input, context and failure text', async () => {
    const f = fixture();
    const disabled = f.api.registerPreSubmit(f.owner('a').ctx, { id: 'off', enabled: false }, () => assert.fail('disabled hook ran'));
    const bad = f.api.registerPreSubmit(f.owner('b').ctx, { id: 'bad', priority: 1 }, () => { throw Object.assign(new Error('secret draft content'), { code: 'private_secret' }); });
    f.submit('sensitive input'); await tick();
    const list = f.endpoints.get('codex.ui.preSubmit:interceptors.list')({});
    assert.deepEqual(plain(list.interceptors).map(hook => hook.id), ['off', 'bad']);
    assert.equal(disabled.inspect().calls, 0); assert.equal(bad.inspect().calls, 1); assert.equal(bad.inspect().failures, 1);
    assert.equal(bad.inspect().lastFailure.code, 'interceptor_failed'); assert.ok(bad.inspect().lastDurationMs >= 0);
    assert.doesNotMatch(JSON.stringify(list), /sensitive|secret|draft|handler|context/);
    bad.setEnabled(false); f.submit(); assert.equal(f.sent.length, 1, 'all-disabled pipeline remains synchronous');
    bad(); assert.throws(() => bad.setEnabled(true), { code: 'interceptor_retired' }); f.dispose();
});

test('disabling a captured interceptor cancels pending dispatch and later reenabling retains its counters', async () => {
    const f = fixture(); let release;
    const handle = f.api.registerPreSubmit(f.owner('owner').ctx, { id: 'pending' }, () => new Promise(resolve => { release = resolve; }));
    f.submit(); await tick(); handle.setEnabled(false); await tick();
    assert.equal(f.sent.length, 0); assert.equal(f.failures[0].error.code, 'interceptor_disabled');
    assert.equal(handle.inspect().failures, 1); assert.equal(handle.inspect().lastFailure.code, 'interceptor_disabled');
    release({ text: 'late' }); await tick(); assert.equal(f.sent.length, 0);
    handle.setEnabled(true); assert.equal(handle.inspect().calls, 1); assert.equal(handle.inspect().enabled, true); f.dispose();
});
