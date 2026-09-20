import assert from 'node:assert/strict';
import test from 'node:test';
import { spawn } from 'node:child_process';
import { createServer } from 'node:http';
import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { createInterface } from 'node:readline';
import { once } from 'node:events';
import { createRequire } from 'node:module';
import { WebSocketServer } from '../frontend/node_modules/ws/wrapper.mjs';
import { createThreadTransport } from '../frontend/src/desktop/transport.js';
const { createTrafficRuntime } = createRequire(import.meta.url)('../runtime/host-traffic-bundle.cjs');

// Opt-in native acceptance: isolated home, synthetic prompt, loopback Responses
// fixture only. No user auth file or actual model endpoint is used.
const cli = process.env.CODLET_TEST_OFFICIAL_CLI;
for (const mode of ['http', 'websocket']) test(`official AppServer starts and resumes real ${mode} traffic through the Adapter-selected channel`, { skip: !cli, timeout: 40000 }, async t => {
    const root = await mkdtemp(path.join(tmpdir(), 'codlet-transport-native-'));
    const requests = [], sockets = new Set();
    let responseSequence = 0;
    async function respond(send) {
        const sequence = ++responseSequence;
        const message = { id: `msg_fixture_${sequence}`, type: 'message', role: 'assistant', status: 'completed', content: [{ type: 'output_text', text: 'Local transport fixture passed', annotations: [] }] };
        send('response.created', { response: { id: `resp_fixture_${sequence}`, status: 'in_progress', output: [] } });
        send('response.output_item.added', { output_index: 0, item: { ...message, status: 'in_progress', content: [] } });
        send('response.content_part.added', { item_id: message.id, output_index: 0, content_index: 0, part: { type: 'output_text', text: '', annotations: [] } });
        send('response.output_text.delta', { item_id: message.id, output_index: 0, content_index: 0, delta: message.content[0].text });
        // A real chunk reaches AppServer before completion; nothing waits for a
        // remote provider and no fixture asks the model to execute a tool.
        await new Promise(resolve => setTimeout(resolve, 30));
        send('response.output_text.done', { item_id: message.id, output_index: 0, content_index: 0, text: message.content[0].text });
        send('response.content_part.done', { item_id: message.id, output_index: 0, content_index: 0, part: message.content[0] });
        send('response.output_item.done', { output_index: 0, item: message });
        send('response.completed', { response: { id: `resp_fixture_${sequence}`, status: 'completed', model: 'codlet-fixture', output: [message], usage: { input_tokens: 1, output_tokens: 1, total_tokens: 2, input_tokens_details: { cached_tokens: 0 }, output_tokens_details: { reasoning_tokens: 0 } } } });
    }
    const server = createServer(async (req, res) => {
        let raw = '';
        for await (const chunk of req) { raw += chunk; if (raw.length > 2 * 1024 * 1024) { req.destroy(); return; } }
        requests.push({ method: req.method, url: req.url, headers: req.headers, body: JSON.parse(raw), transport: 'http' });
        res.writeHead(200, { 'Content-Type': 'text/event-stream', 'Cache-Control': 'no-cache' });
        await respond((type, data) => res.write(`event: ${type}\ndata: ${JSON.stringify({ type, ...data })}\n\n`));
        res.end();
    });
    const webSockets = new WebSocketServer({ noServer: true, maxPayload: 2 * 1024 * 1024 });
    server.on('upgrade', (req, socket, head) => {
        if (mode !== 'websocket') { socket.destroy(); return; }
        webSockets.handleUpgrade(req, socket, head, ws => {
            ws.on('message', raw => {
                const body = JSON.parse(raw.toString());
                requests.push({ method: 'GET', url: req.url, headers: req.headers, body, transport: 'websocket' });
                void respond((type, data) => ws.send(JSON.stringify({ type, ...data })));
            });
        });
    });
    server.on('connection', socket => { sockets.add(socket); socket.on('close', () => sockets.delete(socket)); });
    await new Promise(resolve => server.listen(0, '127.0.0.1', resolve));
    const upstreamOrigin = `http://127.0.0.1:${server.address().port}`;
    const trafficAbort = new AbortController();
    const managed = createTrafficRuntime({ rootSignal: trafficAbort.signal, makeError: (code, message) => Object.assign(new Error(message), { code }), async coreRequest(method, params, signal) {
        if (signal.aborted) throw signal.reason;
        if (method === 'host.network.authorizeChannel') return {};
        assert.equal(method, 'host.network.authorizeForward');
        const destination = new URL(params.url), origin = new URL(destination);
        if (origin.protocol === 'ws:') origin.protocol = 'http:';
        assert.equal(origin.origin, upstreamOrigin, 'fixture must only contact its owned loopback server');
        return { url: destination.href, origin: origin.origin };
    } });
    const channel = await managed.api.openChannel({}, {
        ...(mode === 'http' ? { http: (incoming, exchange) => exchange.forward({ url: upstreamOrigin + incoming.path, method: incoming.method, headers: [['content-type', 'application/json']], body: incoming.body }) } : {}),
        ...(mode === 'websocket' ? { webSocket: (incoming, exchange) => exchange.forward({ url: upstreamOrigin.replace('http:', 'ws:') + incoming.path, protocols: incoming.protocols }) } : {})
    });
    const env = { ...process.env, CODEX_HOME: root };
    for (const key of Object.keys(env)) if (/(?:API_KEY|ACCESS_TOKEN|AUTH_TOKEN|BEARER_TOKEN|HTTP_PROXY|HTTPS_PROXY|ALL_PROXY)$/i.test(key)) delete env[key];
    const pending = new Map(), notifications = [];
    let nextId = 0, notify, child, closed, reader;
    const request = (method, params) => new Promise((resolve, reject) => {
        const id = ++nextId, timer = setTimeout(() => { pending.delete(id); reject(new Error(`${method} timed out`)); }, 10000);
        pending.set(id, { resolve, reject, timer }); child.stdin.write(JSON.stringify({ id, method, params }) + '\n');
    });
    async function stopNative() {
        if (!child) return;
        for (const entry of pending.values()) { clearTimeout(entry.timer); entry.reject(new Error('fixture closed')); }
        pending.clear();
        child.stdin.end();
        const kill = setTimeout(() => child.kill(), 1500);
        await closed; clearTimeout(kill); reader.close(); child = null;
    }
    async function startNative() {
        notifications.length = 0;
        child = spawn(cli, ['app-server', '--listen', 'stdio://'], { cwd: root, env, windowsHide: true, stdio: ['pipe', 'pipe', 'pipe'] });
        closed = once(child, 'close');
        child.stderr.on('data', () => {});
        reader = createInterface({ input: child.stdout });
        reader.on('line', line => {
            let message; try { message = JSON.parse(line); } catch { return; }
            if (message.id != null && pending.has(message.id)) {
                const entry = pending.get(message.id); pending.delete(message.id); clearTimeout(entry.timer);
                if (message.error) entry.reject(new Error(message.error.message)); else entry.resolve(message.result);
            } else if (message.method) { notifications.push(message); notify?.(); }
        });
        await request('initialize', { clientInfo: { name: 'codlet-transport-fixture', version: '0.1.0' }, capabilities: { experimentalApi: true } });
        child.stdin.write(JSON.stringify({ method: 'initialized' }) + '\n');
    }
    t.after(async () => {
        await stopNative();
        trafficAbort.abort(); await channel.close(); managed.closeAll();
        for (const socket of sockets) socket.destroy();
        await new Promise(resolve => webSockets.close(resolve));
        await new Promise(resolve => server.close(resolve));
        assert.equal(path.dirname(path.resolve(root)), path.resolve(tmpdir()));
        assert.ok(path.basename(root).startsWith('codlet-transport-native-'));
        await rm(root, { recursive: true, force: true, maxRetries: 10, retryDelay: 100 });
    });
    await startNative();
    const attached = createThreadTransport({ check() {}, owner: ctx => ({ pluginId: ctx.pluginId, generation: 1 }), capability: {}, build: { threadTransport: true }, client: { requestPromises: new Map([['fixture-thread', {}]]), onError(_id, error) { throw error; } } });
    t.after(() => attached.dispose());
    attached.register({ pluginId: 'fixture', onDeactivate: () => () => {} }, { id: 'channel' }, () => ({ channel, model: 'codlet-fixture' }));
    const routed = await new Promise(resolve => attached.intercept({ type: 'mcp-request', hostId: 'local', request: { id: 'fixture-thread', method: 'thread/start', params: { ephemeral: false, cwd: root, approvalPolicy: 'never', sandbox: 'read-only' } } }, resolve));
    const started = await request('thread/start', routed.request.params);
    const threadId = started.thread.id;
    assert.match(started.modelProvider, /^codlet_/);
    const waitFor = (predicate, label) => {
        const existing = notifications.find(predicate); if (existing) return Promise.resolve(existing);
        return new Promise((resolve, reject) => {
            const timer = setTimeout(() => { notify = null; reject(new Error(`Native ${label} timed out`)); }, 10000);
            notify = () => { const result = notifications.find(predicate); if (result) { clearTimeout(timer); notify = null; resolve(result); } };
        });
    };
    async function runTurn() {
        const turn = await request('turn/start', { threadId, input: [{ type: 'text', text: 'Return the local fixture response', text_elements: [] }] });
        const complete = await waitFor(value => value.method === 'turn/completed' && value.params.threadId === threadId && value.params.turn.id === turn.turn.id, 'turn completion');
        assert.equal(complete.params.turn.status, 'completed');
    }
    await runTurn();
    // A new isolated backend guarantees cold state; unsubscribe alone only
    // detaches the client and does not guarantee eviction of the loaded thread.
    await stopNative(); await startNative();
    const unloaded = await request('thread/read', { threadId, includeTurns: false });
    assert.equal(unloaded.thread.status.type, 'notLoaded');
    const resumedRequest = await new Promise(resolve => attached.intercept({ type: 'mcp-request', hostId: 'local', request: { id: 'fixture-thread', method: 'thread/resume', params: { threadId, cwd: root, modelProvider: 'openai', approvalPolicy: 'never', sandbox: 'read-only' } } }, resolve));
    const resumed = await request('thread/resume', resumedRequest.request.params);
    assert.equal(resumed.modelProvider, started.modelProvider);
    await runTurn();
    const generations = requests.filter(value => value.body.generate !== false);
    assert.equal(generations.length, 2, JSON.stringify(requests.map(value => ({ transport: value.transport, type: value.body.type, generate: value.body.generate }))));
    assert.ok(requests.every(value => value.transport === mode));
    assert.equal(generations[0].method, mode === 'websocket' ? 'GET' : 'POST');
    assert.equal(generations[0].url, '/v1/responses');
    assert.equal(generations[0].body.model, 'codlet-fixture');
    assert.equal(generations[0].headers.authorization, undefined);
    assert.ok(notifications.some(value => value.method === 'item/agentMessage/delta' && value.params.delta.includes('Local transport fixture passed')));
});
