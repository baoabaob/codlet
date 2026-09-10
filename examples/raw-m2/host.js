'use strict';

// This example supplies its own page ABI. It uses only public raw CDP and has
// no dependency on Codlet's managed renderer, UI adapter or capability provider.
const MAX_TARGETS = 8;
const MAX_MESSAGE_BYTES = 8192;
let context, subscription, binding;
let stopping = false;
const targets = new Map();
const sessions = new Map();
const attaching = new Map();
const replies = new Set();

function pageBridge(bindingName, generation) {
    const key = '__codletRawM2';
    const kind = 'example.raw-m2';
    const prior = globalThis[key];
    if (prior?.kind === kind && typeof prior.dispose === 'function') prior.dispose();
    const documentToken = generation + ':' + Date.now() + ':' + Math.random().toString(36).slice(2);
    const pending = new Map();
    let serial = 0, closed = false;
    const api = Object.freeze({
        kind, generation, documentToken,
        request(value, options = {}) {
            if (closed) return Promise.reject(new Error('Raw page bridge closed'));
            if (pending.size >= 4 || serial >= 4096) return Promise.reject(new Error('Raw page bridge request limit'));
            const id = ++serial;
            const message = { v: 1, generation, documentToken, id, value, delayMs: Math.min(250, Math.max(0, Number(options.delayMs) || 0)) };
            const encoded = JSON.stringify(message);
            if (new TextEncoder().encode(encoded).length > 8192) return Promise.reject(new Error('Raw page bridge message too large'));
            return new Promise((resolve, reject) => {
                const timer = setTimeout(() => { pending.delete(id); reject(new Error('Raw page bridge deadline')); }, 2000);
                pending.set(id, { resolve, reject, timer });
                try { globalThis[bindingName](encoded); }
                catch (error) { clearTimeout(timer); pending.delete(id); reject(error); }
            });
        },
        deliver(message) {
            if (closed || message?.v !== 1 || message.generation !== generation || message.documentToken !== documentToken) return false;
            const request = pending.get(message.id);
            if (!request) return false;
            pending.delete(message.id);
            clearTimeout(request.timer);
            if (message.ok) request.resolve(message.value);
            else request.reject(new Error(message.error || 'Raw page request failed'));
            return true;
        },
        dispose() {
            if (closed) return;
            closed = true;
            for (const request of pending.values()) { clearTimeout(request.timer); request.reject(new Error('Raw page bridge closed')); }
            pending.clear();
            if (globalThis[key] === api) delete globalThis[key];
        },
    });
    Object.defineProperty(globalThis, key, { value: api, configurable: true, enumerable: true });
}

function active() { return !stopping && context && !context.signal.aborted; }
function delay(milliseconds) {
    if (!milliseconds || !active()) return Promise.resolve();
    return new Promise(resolve => {
        const done = () => { clearTimeout(timer); context.signal.removeEventListener('abort', done); resolve(); };
        const timer = setTimeout(done, milliseconds);
        context.signal.addEventListener('abort', done, { once: true });
    });
}
function warn(error) { if (active()) context.log.warn('raw example:', error.code || error.message || String(error)); }

async function attach(info) {
    if (!active() || info?.type !== 'page' || typeof info.targetId !== 'string' || targets.has(info.targetId)) return;
    if (attaching.has(info.targetId)) return attaching.get(info.targetId);
    if (targets.size + attaching.size >= MAX_TARGETS) return;
    const installing = (async () => {
        const attached = await context.cdp.request('Target.attachToTarget', { targetId: info.targetId, flatten: true });
        const record = { targetId: info.targetId, sessionId: attached.sessionId, scriptId: null };
        targets.set(info.targetId, record);
        sessions.set(record.sessionId, record);
        if (!active()) return;
        const options = { sessionId: record.sessionId };
        await context.cdp.request('Page.enable', {}, options);
        await context.cdp.request('Runtime.enable', {}, options);
        await context.cdp.request('Runtime.addBinding', { name: binding }, options);
        const source = '(' + pageBridge.toString() + ')(' + JSON.stringify(binding) + ',' + context.plugin.generation + ')';
        const script = await context.cdp.request('Page.addScriptToEvaluateOnNewDocument', { source }, options);
        record.scriptId = script.identifier;
        await context.cdp.request('Runtime.evaluate', { expression: source, returnByValue: true }, options);
    })();
    attaching.set(info.targetId, installing);
    try { await installing; } finally { attaching.delete(info.targetId); }
}

async function receive(event) {
    const record = sessions.get(event.sessionId);
    if (!active() || !record || event.params?.name !== binding || replies.size >= 4) return;
    const payload = event.params.payload;
    if (typeof payload !== 'string' || Buffer.byteLength(payload) > MAX_MESSAGE_BYTES) return;
    let message;
    try { message = JSON.parse(payload); } catch (_) { return; }
    const contextId = event.params.executionContextId;
    if (message?.v !== 1 || message.generation !== context.plugin.generation ||
        typeof message.documentToken !== 'string' || message.documentToken.length > 192 ||
        !Number.isSafeInteger(message.id) || message.id < 1 || message.id > 4096 ||
        !Number.isSafeInteger(contextId) || contextId < 1 ||
        !Number.isFinite(message.delayMs) || message.delayMs < 0 || message.delayMs > 250) return;
    const work = (async () => {
        await delay(message.delayMs);
        if (!active() || sessions.get(record.sessionId) !== record) return;
        const response = { v: 1, generation: context.plugin.generation, documentToken: message.documentToken,
            id: message.id, ok: true, value: { echo: message.value, targetId: record.targetId, generation: context.plugin.generation } };
        // The CDP event's actual execution context selects the recipient.
        // A late response cannot migrate to a new document with a reused JS ID.
        await context.cdp.request('Runtime.evaluate', {
            expression: 'globalThis.__codletRawM2?.deliver(' + JSON.stringify(response) + ')',
            contextId, returnByValue: true,
        }, { sessionId: record.sessionId, timeoutMs: 1000 });
    })();
    replies.add(work);
    try { await work; } catch (error) { warn(error); } finally { replies.delete(work); }
}

module.exports = {
    async activate(ctx) {
        context = ctx;
        stopping = false;
        binding = 'codlet_raw_m2_g' + ctx.plugin.generation;
        subscription = await ctx.cdp.subscribe({ scope: 'all', methods: [
            'Target.targetCreated', 'Target.targetInfoChanged', 'Target.targetDestroyed',
            'Target.detachedFromTarget', 'Runtime.bindingCalled',
        ] }, async event => {
            if (!active()) return;
            if (event.method === 'Target.targetCreated' || event.method === 'Target.targetInfoChanged') {
                try { await attach(event.params?.targetInfo); } catch (error) { warn(error); }
            } else if (event.method === 'Target.targetDestroyed') {
                const record = targets.get(event.params?.targetId);
                if (record) { targets.delete(record.targetId); sessions.delete(record.sessionId); }
            } else if (event.method === 'Target.detachedFromTarget') {
                const record = sessions.get(event.params?.sessionId);
                if (record) { sessions.delete(record.sessionId); targets.delete(record.targetId); }
            } else if (event.method === 'Runtime.bindingCalled') {
                await receive(event);
            }
        }, reason => {
            // Losing this bounded stream makes navigation/target ownership
            // unknowable to the example. Fail visibly so Core retires the owner.
            const failure = new Error('Raw CDP subscription ended: ' + JSON.stringify(reason));
            failure.code = 'raw_subscription_ended';
            throw failure;
        });
        await ctx.cdp.request('Target.setDiscoverTargets', { discover: true });
        const result = await ctx.cdp.request('Target.getTargets');
        for (const info of result.targetInfos) await attach(info);
    },
    async deactivate(cleanup) {
        stopping = true;
        // Core has already retired ordinary work and the subscription. Awaiting
        // the example's bounded continuations reveals any known partial sessions.
        await Promise.allSettled([...attaching.values(), ...replies]);
        for (const record of [...sessions.values()]) {
            const options = { sessionId: record.sessionId, timeoutMs: 500 };
            for (const [method, params] of [
                ['Runtime.evaluate', { expression: 'globalThis.__codletRawM2?.dispose()', returnByValue: true }],
                ['Runtime.removeBinding', { name: binding }],
                ...(record.scriptId ? [['Page.removeScriptToEvaluateOnNewDocument', { identifier: record.scriptId }]] : []),
            ]) {
                try { await cleanup.cdp.request(method, params, options); } catch (_) { /* target may have ended */ }
            }
            try { await cleanup.cdp.request('Target.detachFromTarget', { sessionId: record.sessionId }); } catch (_) { /* Core also retires owned sessions */ }
        }
        targets.clear(); sessions.clear(); attaching.clear(); replies.clear();
        subscription = null;
    },
};
