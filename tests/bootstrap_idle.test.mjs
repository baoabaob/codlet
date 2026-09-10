import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { Session } from 'node:inspector';
import test from 'node:test';
import vm from 'node:vm';

const source = readFileSync(new URL('../bundled/runtime/bootstrap.js', import.meta.url), 'utf8');
const capability = { name: 'idle.example', api: 1, scope: 'target' };

async function idleRenderer(t, { messageChannel = true } = {}) {
    const session = new Session();
    session.connect();
    const post = (method, params) => new Promise((resolve, reject) => {
        session.post(method, params, (error, reply) => error ? reject(error) : resolve(reply));
    });
    let contextId;
    session.on('Runtime.executionContextCreated', ({ params }) => {
        if (params.context.name === 'codlet-idle-regression') contextId = params.context.id;
    });
    await post('Runtime.enable');
    const timers = new Set();
    const messages = new Set();
    const requests = [];
    let context;
    let tasks = 0;
    let ports = 0;
    const browserTask = callback => {
        tasks++;
        callback();
        // Model HTML's checkpoint after a browser task. Inspector evaluations
        // deliberately do not run this checkpoint in an explicit V8 queue.
        vm.runInContext('void 0', context);
    };
    const browserTimers = {
        setTimeout(callback, delay) {
            const timer = setTimeout(() => { timers.delete(timer); browserTask(callback); }, delay);
            timers.add(timer);
            return timer;
        },
        clearTimeout(timer) { timers.delete(timer); clearTimeout(timer); }
    };
    class BrowserMessageChannel {
        constructor() {
            let receiving = true;
            let sending = true;
            ports += 2;
            this.port1 = { onmessage: null, close() { if (receiving) ports--; receiving = false; } };
            this.port2 = {
                close() { if (sending) ports--; sending = false; },
                postMessage: data => {
                    const handle = setImmediate(() => {
                        messages.delete(handle);
                        if (receiving) browserTask(() => this.port1.onmessage?.({ data }));
                    });
                    messages.add(handle);
                }
            };
        }
    }
    context = vm.createContext({
        ...browserTimers, TextEncoder, AbortController, performance,
        ...(messageChannel ? { MessageChannel: BrowserMessageChannel } : {}),
        bridge: payload => requests.push(JSON.parse(payload))
    }, { name: 'codlet-idle-regression', microtaskMode: 'afterEvaluate' });
    t.after(() => {
        vm.runInContext('void 0', context);
        for (const timer of timers) clearTimeout(timer);
        for (const handle of messages) clearImmediate(handle);
        session.disconnect();
    });
    assert.ok(contextId);
    async function evaluate(expression) {
        let deadline;
        try {
            const reply = await Promise.race([
                post('Runtime.evaluate', { expression, contextId, returnByValue: true, awaitPromise: true }),
                new Promise((_, reject) => {
                    deadline = setTimeout(() => reject(new Error('Inspector completion waited for external input')), 1000);
                })
            ]);
            assert.equal(reply.exceptionDetails, undefined);
            return reply.result.value;
        } finally { clearTimeout(deadline); }
    }
    assert.equal((await evaluate(source)).ok, true);
    return { context, requests, evaluate, tasks: () => tasks, ports: () => ports,
        timers: () => timers.size, messages: () => messages.size };
}

test('inspector RPC and lifecycle finish repeatedly in an idle renderer without input', async t => {
    const f = await idleRenderer(t);
    for (let generation = 1; generation <= 12; generation++) {
        const metadata = { id: 'idle-plugin', generation, binding: 'bridge', requires: [capability], provides: [capability] };
        const activated = await f.evaluate(`__codletRendererV1.activate(${JSON.stringify(metadata)}, {
            activate(ctx) {
                globalThis.pluginContext = ctx;
                ctx.rpc.provide(${JSON.stringify(capability)}, 'echo', value => value);
            },
            deactivate() {}
        })`);
        assert.equal(activated.ok, true);
        // A single initiating task, followed by three Core replies and no input.
        vm.runInContext(`globalThis.results = []; void (async () => {
            for (const method of ['prepare', 'submit', 'list']) {
                results.push(await pluginContext.rpc.request(method, null));
            }
        })();`, f.context);
        for (const method of ['prepare', 'submit', 'list']) {
            const request = f.requests.shift();
            assert.equal(request?.method, method);
            const response = { v: 1, type: 'response', id: request.id, ok: true, result: method };
            assert.equal((await f.evaluate(`__codletRendererV1.__rpcReceive('bridge', ${JSON.stringify(response)})`)).ok, true);
        }
        assert.deepEqual(Array.from(f.context.results), ['prepare', 'submit', 'list']);
        const invocation = { v: 1, type: 'request', pluginId: 'caller', generation: 1, id: generation,
            capability, method: 'echo', params: generation };
        assert.deepEqual(await f.evaluate(`__codletRendererV1.__rpcInvoke('bridge', ${JSON.stringify(invocation)})`),
            { ok: true, value: generation });
        assert.equal((await f.evaluate(`__codletRendererV1.deactivate('idle-plugin', ${generation})`)).ok, true);
        assert.deepEqual(await f.evaluate('__codletRendererV1.status()'), []);
        assert.equal(f.ports(), 0);
        assert.equal(f.messages(), 0);
        assert.equal(f.timers(), 0);
    }
    const tasks = f.tasks();
    await new Promise(resolve => setTimeout(resolve, 30));
    assert.equal(f.tasks(), tasks, 'an idle renderer must not keep posting wake tasks');
});

test('inspector wake tasks coalesce and the timer fallback also completes without input', async t => {
    for (const messageChannel of [true, false]) {
        await t.test(messageChannel ? 'MessageChannel' : 'timer fallback', async t => {
            const f = await idleRenderer(t, { messageChannel });
            const before = f.tasks();
            await f.evaluate(`for (let i = 0; i < 40; i++) __codletRendererV1.status(); ({ ok: true })`);
            assert.equal(f.tasks() - before, 1);
            assert.equal(f.ports(), 0);
            assert.equal(f.messages(), 0);
            assert.equal(f.timers(), 0);
        });
    }
});
