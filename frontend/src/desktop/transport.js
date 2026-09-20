// Codex-specific attachment of an explicit HTTP/WebSocket channel. Forwarding and
// policy belong to the channel owner; this module only changes Native's thread
// configuration before it is sent on the existing Desktop connection.
const fail = (code, message) => Object.assign(new Error(message), { code });
const fields = (value, allowed) => {
    if (!value || typeof value !== 'object' || Array.isArray(value) || Object.keys(value).some(key => !allowed.includes(key))) throw fail('invalid_argument', 'Unexpected transport argument');
};
const text = (value, name, max = 256) => {
    if (typeof value !== 'string' || !value.length || value.length > max || /[\u0000-\u001f\u007f]/u.test(value)) throw fail('invalid_argument', `Invalid ${name}`);
    return value;
};
const optional = value => typeof value === 'string' ? value : null;

export function createThreadTransport({ check, owner, capability, client, build }) {
    const hooks = new Map(), pending = new Set();
    let alive = true, sequence = 0;
    const supported = build.threadTransport === true;
    const ordered = () => [...hooks.values()].sort((a, b) => a.priority - b.priority || a.pluginId.localeCompare(b.pluginId) || a.order - b.order);
    const inspect = hook => ({ pluginId: hook.pluginId, generation: hook.generation, id: hook.id, enabled: hook.enabled, priority: hook.priority, timeoutMs: hook.timeoutMs, calls: hook.calls, applied: hook.applied, failures: hook.failures });
    const probe = () => ({ available: alive && supported, protocol: 'responses', protocols: ['http', 'websocket'], appliesAt: ['thread.start', 'thread.resume'], activeTurns: false, existingLoadedThreads: false, officialOAuth: false, hooks: hooks.size, pending: pending.size, unavailable: supported ? null : { code: 'desktop_transport_unsupported', message: 'Channel attachment is not verified for this client build' } });
    const assertReady = () => {
        check();
        if (!alive) throw fail('adapter_deactivated', 'Thread transport was deactivated');
        if (!supported) throw fail('desktop_transport_unsupported', 'Channel attachment is not verified for this client build');
    };
    function cancel(reason = fail('adapter_deactivated', 'Thread transport was deactivated')) {
        for (const item of pending) item.controller.abort(reason);
    }
    function register(ctx, options, handler) {
        assertReady(); fields(options, ['id', 'priority', 'timeoutMs', 'enabled']);
        const principal = owner(ctx, capability), id = text(options.id, 'transport id', 128);
        const key = `${principal.pluginId}:${principal.generation}:${id}`;
        if (hooks.has(key)) throw fail('duplicate_interceptor', 'Thread transport is already registered');
        if (hooks.size >= 32 || typeof handler !== 'function') throw fail('interceptor_limit', 'Expected a callback and at most 32 thread transports');
        const priority = options.priority ?? 0, timeoutMs = options.timeoutMs ?? 1000;
        if (!Number.isSafeInteger(priority) || Math.abs(priority) > 1000 || !Number.isSafeInteger(timeoutMs) || timeoutMs < 1 || timeoutMs > 2000 || options.enabled !== undefined && typeof options.enabled !== 'boolean') throw fail('invalid_argument', 'Invalid thread transport limits');
        const hook = { ...principal, id, key, handler, priority, timeoutMs, order: ++sequence, providerId: `codlet_${crypto.randomUUID().replaceAll('-', '')}`, active: true, enabled: options.enabled !== false, calls: 0, applied: 0, failures: 0 };
        hooks.set(key, hook);
        let release;
        const cancelHook = () => { for (const item of pending) if (item.hooks.includes(hook)) item.controller.abort(fail('transport_retired', 'Thread transport retired before dispatch')); };
        const dispose = () => { if (!hook.active) return; hook.active = false; hooks.delete(key); cancelHook(); release?.(); };
        hook.dispose = dispose;
        try { release = ctx.onDeactivate(dispose); } catch (error) { dispose(); throw error; }
        return Object.freeze(Object.assign(dispose, {
            setEnabled(enabled) {
                assertReady();
                if (!hook.active) throw fail('interceptor_retired', 'Thread transport has retired');
                if (typeof enabled !== 'boolean') throw fail('invalid_argument', 'enabled must be boolean');
                hook.enabled = enabled; if (!enabled) cancelHook();
            },
            inspect() { assertReady(); if (!hook.active) throw fail('interceptor_retired', 'Thread transport has retired'); return inspect(hook); }
        }));
    }
    async function run(message, item) {
        const params = message.request.params;
        if (!params || typeof params !== 'object' || Array.isArray(params)) throw fail('desktop_transport_drift', 'Native thread parameters changed');
        const source = message.request.method === 'thread/start' ? 'thread.start' : 'thread.resume';
        if (source === 'thread.resume') text(params.threadId, 'threadId');
        const draft = Object.freeze({ source, threadId: source === 'thread.resume' ? params.threadId : null, cwd: optional(params.cwd), model: optional(params.model), provider: optional(params.modelProvider) });
        const deadline = Math.min(Date.now() + 5000, Number.isFinite(message.expiresAtMs) ? message.expiresAtMs : Infinity);
        let chosen = null;
        for (const hook of item.hooks) {
            assertReady();
            const signal = item.controller.signal;
            if (signal.aborted || !hook.active) throw signal.reason ?? fail('transport_retired', 'Thread transport retired before dispatch');
            const budget = Math.min(hook.timeoutMs, deadline - Date.now());
            if (budget < 1) throw fail('transport_timeout', 'Thread transport deadline expired');
            let timer, abort;
            hook.calls++;
            try {
                const result = await new Promise((resolve, reject) => {
                    abort = () => reject(signal.reason ?? fail('transport_retired', 'Thread transport retired'));
                    signal.addEventListener('abort', abort, { once: true });
                    timer = setTimeout(() => reject(fail('transport_timeout', 'Thread transport callback timed out')), budget);
                    Promise.resolve().then(() => hook.handler(draft, Object.freeze({ signal }))).then(resolve, reject);
                }).finally(() => { clearTimeout(timer); signal.removeEventListener('abort', abort); });
                if (signal.aborted || !hook.active) throw signal.reason ?? fail('transport_retired', 'Thread transport retired before dispatch');
                if (result == null) continue;
                fields(result, ['channel', 'path', 'model']);
                if (!result.channel || typeof result.channel !== 'object' || Array.isArray(result.channel)) throw fail('invalid_argument', 'Expected a channel descriptor');
                const baseUrl = text(result.channel.endpoint, 'channel endpoint', 4096);
                const protocols = result.channel.protocols;
                if (!Array.isArray(protocols) || protocols.length < 1 || protocols.length > 2 || new Set(protocols).size !== protocols.length || protocols.some(value => !['http', 'websocket'].includes(value))) throw fail('invalid_argument', 'A channel must declare HTTP and/or WebSocket support');
                let url;
                try { url = new URL(baseUrl); } catch { throw fail('invalid_argument', 'Invalid channel base URL'); }
                if (url.protocol !== 'http:' || !['127.0.0.1', '[::1]'].includes(url.hostname) || !url.port || url.username || url.password || url.hash || url.search) throw fail('invalid_argument', 'Thread transport requires an explicit loopback HTTP channel URL');
                const path = result.path ?? '/v1';
                if (typeof path !== 'string' || path.length > 256 || path !== '' && !/^\/(?:[A-Za-z0-9_-]+\/?)*$/.test(path)) throw fail('invalid_argument', 'Channel API path must be a plain absolute path');
                if (chosen) throw fail('transport_conflict', 'More than one plugin selected a channel for this thread request');
                chosen = { hook, baseUrl: url.href.replace(/\/$/, '') + path.replace(/\/$/, ''), webSocket: protocols.includes('websocket'), model: result.model === undefined ? undefined : text(result.model, 'model') };
            } catch (error) {
                hook.failures++;
                // Callback errors may contain URLs, tokens or response bodies.
                // Only our finite public failure codes enter Native diagnostics.
                const code = ['invalid_argument', 'transport_timeout', 'transport_retired', 'transport_conflict', 'adapter_deactivated', 'desktop_transport_unsupported'].includes(error?.code) ? error.code : 'transport_callback_failed';
                throw fail(code, `${hook.pluginId}/${hook.id}: ${code}`);
            }
        }
        if (!chosen) return message;
        const config = params.config ?? {};
        if (typeof config !== 'object' || Array.isArray(config)) throw fail('desktop_transport_drift', 'Native thread configuration changed');
        const providerKey = `model_providers.${chosen.hook.providerId}`;
        if (Object.prototype.hasOwnProperty.call(config, providerKey)) throw fail('transport_conflict', 'Native configuration already owns this channel provider');
        const next = { ...message, request: { ...message.request, params: { ...params, modelProvider: chosen.hook.providerId, config: { ...config, [providerKey]: { name: `Codlet ${chosen.hook.pluginId}`, base_url: chosen.baseUrl, wire_api: 'responses', requires_openai_auth: false, supports_websockets: chosen.webSocket } }, ...(chosen.model === undefined ? {} : { model: chosen.model }) } } };
        if (JSON.stringify(next).length > 524288) throw fail('transport_request_too_large', 'Native thread request exceeds the adapter limit');
        item.chosen = chosen.hook;
        return next;
    }
    function intercept(message, send) {
        const selected = ordered().filter(hook => hook.enabled);
        if (!alive || !selected.length) return send(message);
        if (pending.size >= 16) { client.onError(message.request.id, fail('transport_limit', 'Too many pending thread transports')); return; }
        const item = { hooks: selected, controller: new AbortController(), chosen: null };
        pending.add(item);
        run(message, item).then(next => {
            assertReady();
            if (item.controller.signal.aborted || !client.requestPromises.has(message.request.id)) throw fail('transport_retired', 'Native thread request retired before dispatch');
            send(next); if (item.chosen) item.chosen.applied++;
        }).catch(error => {
            if (client.requestPromises.has(message.request.id)) client.onError(message.request.id, fail(error.code ?? 'transport_failed', error.message ?? 'Thread transport failed'));
        }).finally(() => { pending.delete(item); item.controller.abort(); });
    }
    return {
        register, intercept, probe, cancel,
        list(args = {}) { assertReady(); fields(args, []); return { interceptors: ordered().map(inspect) }; },
        dispose() { if (!alive) return; alive = false; cancel(); for (const hook of [...hooks.values()]) hook.dispose(); hooks.clear(); }
    };
}
