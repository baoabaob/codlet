import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { randomUUID } from 'node:crypto';
import test from 'node:test';
import vm from 'node:vm';

const source = readFileSync(new URL('../bundled/codex-desktop-adapter/renderer.js', import.meta.url), 'utf8');
const plain = value => JSON.parse(JSON.stringify(value));
const tick = () => new Promise(resolve => setImmediate(resolve));

function fixture(t, supported = true) {
    const scope = vm.createContext({ module: { exports: {} }, setTimeout, clearTimeout, AbortController, URL, crypto: { randomUUID } });
    const create = vm.runInContext(source + '\ncreateAdapter', scope);
    const builds = vm.runInContext('BUILDS', scope), build = supported ? builds.at(-1) : builds[0];
    const sent = [], errors = [], endpoints = new Map();
    const client = { requestPromises: new Map(), onError(id, error) { errors.push({ id, code: error.code, message: error.message }); this.requestPromises.delete(id); } };
    const original = message => { sent.push(message); }, postbox = { postMessage: original };
    let drift = false;
    const manager = { addNotificationCallback: () => () => {}, addConversationStateCallback: () => () => {}, getConversation: () => null };
    const context = { reportDiagnostic() {}, onDeactivate: () => () => {}, rpc: { provide(capability, method, handler) { endpoints.set(`${capability.name}:${method}`, handler); }, unavailable() {} } };
    const adapter = create({ manager, client, postbox, build, check() { if (drift) throw Object.assign(new Error('connection changed'), { code: 'desktop_connection_replaced' }); } }, context);
    t.after(() => adapter.dispose());
    function owner(pluginId = 'channel-plugin', generation = 1) {
        const cleanup = new Set();
        return { ctx: { world: 'main', pluginId, generation, onDeactivate(fn) { cleanup.add(fn); return () => cleanup.delete(fn); } }, stop() { for (const fn of [...cleanup]) fn(); } };
    }
    function dispatch(method = 'thread/start', params = {}, hostId = 'local') {
        const id = randomUUID(), message = { type: 'mcp-request', hostId, request: { id, method, params } };
        client.requestPromises.set(id, {}); postbox.postMessage(message); return message;
    }
    return { ...adapter, scope, sent, errors, endpoints, owner, dispatch, client, postbox, original, drift() { drift = true; } };
}

test('thread attachment changes the actual Native request on its existing connection and preserves other settings', async t => {
    const f = fixture(t), drafts = [];
    const handle = f.api.registerThreadTransport(f.owner().ctx, { id: 'fixture' }, draft => { drafts.push(plain(draft)); assert.ok(Object.isFrozen(draft)); return { channel: { endpoint: 'http://127.0.0.1:32123/private-channel', protocols: ['http', 'websocket'] }, model: 'fixture-model' }; });
    for (const method of ['thread/start', 'thread/resume']) {
        const params = { ...(method === 'thread/resume' ? { threadId: 'saved-thread' } : {}), cwd: 'C:/fixture', model: 'native-model', modelProvider: 'openai', approvalPolicy: 'never', sandbox: 'read-only', config: { 'existing.setting': 123 } };
        const message = f.dispatch(method, params); await tick();
        const next = f.sent.at(-1);
        assert.equal(next.request.id, message.request.id);
        assert.equal(next.request.method, method);
        assert.equal(next.request.params.approvalPolicy, 'never');
        assert.equal(next.request.params.sandbox, 'read-only');
        assert.equal(next.request.params.model, 'fixture-model');
        assert.equal(next.request.params.config['existing.setting'], 123);
        assert.match(next.request.params.modelProvider, /^codlet_[a-f0-9]{32}$/);
        const provider = next.request.params.config[`model_providers.${next.request.params.modelProvider}`];
        assert.deepEqual(plain(provider), { name: 'Codlet channel-plugin', base_url: 'http://127.0.0.1:32123/private-channel/v1', wire_api: 'responses', requires_openai_auth: false, supports_websockets: true });
        assert.equal(params.modelProvider, 'openai');
        assert.deepEqual(params.config, { 'existing.setting': 123 });
    }
    assert.equal(drafts[0].source, 'thread.start'); assert.equal(drafts[0].threadId, null);
    assert.equal(drafts[1].source, 'thread.resume'); assert.equal(drafts[1].threadId, 'saved-thread');
    assert.equal(handle.inspect().applied, 2); assert.equal(f.errors.length, 0);
    const info = f.endpoints.get('codex.backend.transport:interceptors.list')({});
    assert.equal(JSON.stringify(info).includes('private-channel'), false);
    assert.deepEqual(plain(f.endpoints.get('codex.backend.transport:probe')({})).appliesAt, ['thread.start', 'thread.resume']);
});

test('no registration, remote hosts, turn calls and undefined selection preserve Native requests', async t => {
    const f = fixture(t);
    const first = f.dispatch(); assert.equal(f.sent[0], first);
    let calls = 0;
    f.api.registerThreadTransport(f.owner().ctx, { id: 'fixture' }, () => { calls++; });
    const remote = f.dispatch('thread/start', {}, 'remote'), turn = f.dispatch('turn/start', { threadId: 't', input: [] });
    assert.equal(f.sent[1], remote); assert.equal(f.sent[2], turn);
    const same = f.dispatch(); await tick(); assert.equal(f.sent[3], same); assert.equal(calls, 1);
});

test('competing channel selections fail without dispatching either route', async t => {
    const f = fixture(t);
    for (const id of ['a', 'b']) f.api.registerThreadTransport(f.owner(id).ctx, { id }, () => ({ channel: { endpoint: `http://127.0.0.1:32123/${id}`, protocols: ['http'] } }));
    const request = f.dispatch(); await tick();
    assert.equal(f.sent.length, 0); assert.equal(f.errors.length, 1);
    assert.equal(f.errors[0].id, request.request.id); assert.equal(f.errors[0].code, 'transport_conflict');
});

test('callback cancellation, disable, timeout and connection drift never dispatch late results', async t => {
    for (const mode of ['owner-stop', 'disable', 'adapter-stop', 'request-retired', 'timeout', 'connection-drift']) {
        const f = fixture(t), owner = f.owner(); let release, signal;
        const handle = f.api.registerThreadTransport(owner.ctx, { id: 'pending', timeoutMs: mode === 'timeout' ? 5 : 1000 }, (_draft, options) => { signal = options.signal; return new Promise(resolve => { release = resolve; }); });
        const request = f.dispatch(); await tick();
        if (mode === 'owner-stop') owner.stop();
        if (mode === 'disable') handle.setEnabled(false);
        if (mode === 'adapter-stop') f.dispose();
        if (mode === 'request-retired') f.client.requestPromises.delete(request.request.id);
        if (mode === 'timeout') await new Promise(resolve => setTimeout(resolve, 20));
        if (mode === 'connection-drift') f.drift();
        release({ channel: { endpoint: 'http://127.0.0.1:32123/late-secret', protocols: ['http'] } }); await tick();
        assert.equal(f.sent.length, 0, mode); assert.equal(signal.aborted, true, mode);
        assert.equal(f.errors.length, mode === 'request-retired' ? 0 : 1, mode);
    }
});

test('invalid destinations and callback errors are bounded and do not log channel secrets', async t => {
    for (const baseUrl of ['https://example.org/v1', 'http://localhost:32123/v1', 'http://127.0.0.1:32123/v1?secret=marker', 'http://user:secret@127.0.0.1:32123/v1', 'not-a-url']) {
        const f = fixture(t);
        f.api.registerThreadTransport(f.owner().ctx, { id: 'bad-url' }, () => ({ channel: { endpoint: baseUrl, protocols: ['http'] } }));
        f.dispatch(); await tick();
        assert.equal(f.sent.length, 0); assert.equal(f.errors[0].code, 'invalid_argument');
        assert.equal(JSON.stringify(f.errors).includes(baseUrl), false);
    }
    const f = fixture(t);
    f.api.registerThreadTransport(f.owner().ctx, { id: 'throws' }, () => { throw new Error('http://127.0.0.1:32123/private-token'); });
    f.dispatch(); await tick();
    assert.equal(f.errors[0].code, 'transport_callback_failed'); assert.equal(JSON.stringify(f.errors).includes('private-token'), false);
});

test('Core tickets bind transport callbacks to the caller generation and capability', t => {
    const f = fixture(t), consumer = f.owner(), api = f.scope[Symbol.for('codlet.codex.desktop.v1')];
    const issue = name => f.endpoints.get(`${name}:getApi`)({}, { caller: { pluginId: consumer.ctx.pluginId, generation: consumer.ctx.generation } });
    const submit = issue('codex.ui.preSubmit'), transport = issue('codex.backend.transport');
    assert.throws(() => api.registerThreadTransport(consumer.ctx, submit.ticket, { id: 'mismatch' }, () => {}), { code: 'api_ticket_retired' });
    assert.throws(() => api.registerThreadTransport(f.owner('other').ctx, transport.ticket, { id: 'mismatch' }, () => {}), { code: 'api_ticket_retired' });
    const handle = api.registerThreadTransport(consumer.ctx, transport.ticket, { id: 'channel' }, () => {});
    assert.throws(() => api.registerThreadTransport(consumer.ctx, transport.ticket, { id: 'reuse' }, () => {}), { code: 'api_ticket_retired' });
    consumer.stop(); assert.throws(() => handle.inspect(), { code: 'interceptor_retired' });
});

test('unverified client builds leave existing adapter functionality available', t => {
    const f = fixture(t, false);
    assert.equal(f.api.status().available, true); assert.equal(f.api.status().threadTransport.available, false);
    assert.throws(() => f.api.registerThreadTransport(f.owner().ctx, { id: 'no-profile' }, () => {}), { code: 'desktop_transport_unsupported' });
    const request = f.dispatch(); assert.equal(f.sent[0], request);
});

test('one unified channel descriptor selects HTTP or WebSocket without exposing Native provider switches', async t => {
    for (const protocols of [['http'], ['websocket'], ['http', 'websocket']]) {
        const f = fixture(t);
        f.api.registerThreadTransport(f.owner().ctx, { id: 'protocol' }, () => ({ channel: { endpoint: 'http://127.0.0.1:32123/token', protocols }, path: '/custom/api/' }));
        f.dispatch(); await tick();
        const params = f.sent[0].request.params, config = params.config[`model_providers.${params.modelProvider}`];
        assert.equal(config.supports_websockets, protocols.includes('websocket'));
        assert.equal(config.base_url, 'http://127.0.0.1:32123/token/custom/api');
    }
});
