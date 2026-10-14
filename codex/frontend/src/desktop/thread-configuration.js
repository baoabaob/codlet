// Task-local model and provider configuration on the existing Desktop connection.
// Traffic routing and credentials belong to the selected provider or its Host owner.
const fail = (code, message) => Object.assign(new Error(message), { code });
const fields = (value, allowed) => {
    if (!value || typeof value !== 'object' || Array.isArray(value) || Object.keys(value).some(key => !allowed.includes(key))) throw fail('invalid_argument', 'Unexpected task configuration field');
};
const text = (value, name, max = 256) => {
    if (typeof value !== 'string' || !value.length || value.length > max || /[\u0000-\u001f\u007f]/u.test(value)) throw fail('invalid_argument', `Invalid ${name}`);
    return value;
};
const providerId = value => {
    text(value, 'provider id', 128);
    if (!/^[A-Za-z0-9_-]+$/u.test(value)) throw fail('invalid_argument', 'Invalid provider id');
    return value;
};
const optional = value => typeof value === 'string' ? value : null;
const phases = Object.freeze(['thread.start', 'thread.resume', 'turn.start']);
const defaultPhases = Object.freeze(['thread.start', 'thread.resume']);

function privateBaseUrl(value) {
    let url;
    try { url = new URL(text(value, 'provider base URL', 4096)); }
    catch { throw fail('invalid_argument', 'Invalid provider base URL'); }
    if (url.protocol !== 'http:' || !['127.0.0.1', '[::1]'].includes(url.hostname) || !url.port || url.username || url.password || url.hash || url.search
        || !/^\/(?:[A-Za-z0-9_-]+\/?)*$/u.test(url.pathname)) throw fail('invalid_argument', 'A new provider requires a private loopback HTTP base URL');
    return url.href.replace(/\/$/u, '');
}

export function createThreadConfiguration({ check, owner, capability, client, build, restoration }) {
    const hooks = new Map(), pending = new Set();
    let alive = true, sequence = 0;
    const supported = build.threadConfiguration === true;
    const ordered = () => [...hooks.values()].sort((a, b) => a.priority - b.priority || a.pluginId.localeCompare(b.pluginId) || a.order - b.order);
    const inspect = hook => ({ pluginId: hook.pluginId, generation: hook.generation, id: hook.id, enabled: hook.enabled, priority: hook.priority, timeoutMs: hook.timeoutMs, appliesAt: [...hook.appliesAt], calls: hook.calls, applied: hook.applied, failures: hook.failures,
        ...(hook.restoreOnDeactivate ? { restoreOnDeactivate: true, restorations: restoration.inspect(hook.restorationOwner) } : {}) });
    const probe = () => ({ available: alive && supported, appliesAt: [...phases], existingLoadedThreads: true, hooks: hooks.size, pending: pending.size, restoration: restoration?.available() === true, restorationLeases: restoration?.pending() ?? 0,
        unavailable: supported ? null : { code: 'desktop_configuration_unsupported', message: 'Task configuration is not verified for this client build' } });
    const assertReady = () => {
        check();
        if (!alive) throw fail('adapter_deactivated', 'Task configuration was deactivated');
        if (!supported) throw fail('desktop_configuration_unsupported', 'Task configuration is not verified for this client build');
    };
    function cancel(reason = fail('adapter_deactivated', 'Task configuration was deactivated')) {
        for (const item of pending) item.controller.abort(reason);
    }
    function register(ctx, options, handler) {
        assertReady(); fields(options, ['id', 'priority', 'timeoutMs', 'enabled', 'appliesAt', 'restoreOnDeactivate']);
        const principal = owner(ctx, capability), id = text(options.id, 'configuration id', 128);
        const key = `${principal.pluginId}:${principal.generation}:${id}`;
        if (hooks.has(key)) throw fail('duplicate_interceptor', 'Task configuration is already registered');
        if (hooks.size >= 32 || typeof handler !== 'function') throw fail('interceptor_limit', 'Expected a callback and at most 32 task configurations');
        const priority = options.priority ?? 0, timeoutMs = options.timeoutMs ?? 1000;
        if (!Number.isSafeInteger(priority) || Math.abs(priority) > 1000 || !Number.isSafeInteger(timeoutMs) || timeoutMs < 1 || timeoutMs > 2000 || options.enabled !== undefined && typeof options.enabled !== 'boolean') throw fail('invalid_argument', 'Invalid task configuration limits');
        const appliesAt = options.appliesAt === undefined ? defaultPhases : options.appliesAt;
        if (!Array.isArray(appliesAt) || !appliesAt.length || appliesAt.some(phase => !phases.includes(phase)) || new Set(appliesAt).size !== appliesAt.length) throw fail('invalid_argument', 'Invalid task configuration phases');
        if (options.restoreOnDeactivate !== undefined && typeof options.restoreOnDeactivate !== 'boolean') throw fail('invalid_argument', 'restoreOnDeactivate must be boolean');
        if (options.restoreOnDeactivate && (typeof ctx.onCleanup !== 'function' || !restoration?.available() || !appliesAt.includes('thread.resume'))) throw fail('configuration_restore_unsupported', 'Restoration requires asynchronous Core cleanup, reviewed reconfiguration and a resume hook');
        const hook = { ...principal, id, key, handler, priority, timeoutMs, appliesAt: Object.freeze([...appliesAt]), order: ++sequence, providerId: `codlet_${crypto.randomUUID().replaceAll('-', '')}`, active: true, enabled: options.enabled !== false, calls: 0, applied: 0, failures: 0, restoreOnDeactivate: options.restoreOnDeactivate === true, controller: new AbortController(), restorationOwner: Object.freeze({ ...principal, id }) };
        hooks.set(key, hook);
        let release, releaseCleanup;
        const cancelHook = () => { for (const item of pending) if (item.hooks.includes(hook)) item.controller.abort(fail('configuration_retired', 'Task configuration retired before dispatch')); };
        const retire = () => { if (!hook.active) return; hook.active = false; hook.handler = null; hooks.delete(key); cancelHook(); hook.controller.abort(); release?.(); };
        const restore = async signal => {
            if (!hook.restoreOnDeactivate) throw fail('configuration_restore_unsupported', 'Opt in to restoration before applying a loaded-thread change');
            hook.enabled = false; cancelHook();
            const result = await restoration.restore(hook.restorationOwner, signal);
            if (!hook.active) releaseCleanup?.();
            return result;
        };
        let disposal;
        const dispose = () => {
            if (!hook.active) return disposal;
            retire(); disposal = hook.restoreOnDeactivate ? restore() : undefined;
            return disposal;
        };
        hook.dispose = retire;
        try {
            release = ctx.onDeactivate(retire);
            if (hook.restoreOnDeactivate) releaseCleanup = ctx.onCleanup(({ signal }) => restore(signal).then(() => undefined));
        } catch (error) { retire(); releaseCleanup?.(); throw error; }
        return Object.freeze(Object.assign(dispose, {
            reconfigure(args) {
                assertReady();
                if (!hook.active || !hook.enabled) throw fail('interceptor_retired', 'Enable the live configuration before applying it');
                if (!hook.restoreOnDeactivate) throw fail('configuration_restore_unsupported', 'Opt in to restoration before applying a loaded-thread change');
                return restoration.reconfigure(hook.restorationOwner, args, hook.controller.signal);
            },
            restore() { assertReady(); if (!hook.active) throw fail('interceptor_retired', 'Task configuration has retired'); return restore(); },
            setEnabled(enabled) {
                assertReady();
                if (!hook.active) throw fail('interceptor_retired', 'Task configuration has retired');
                if (typeof enabled !== 'boolean') throw fail('invalid_argument', 'enabled must be boolean');
                hook.enabled = enabled; if (!enabled) cancelHook();
            },
            inspect() { assertReady(); if (!hook.active) throw fail('interceptor_retired', 'Task configuration has retired'); return inspect(hook); }
        }));
    }
    async function run(message, item) {
        const params = message.request.params;
        if (!params || typeof params !== 'object' || Array.isArray(params)) throw fail('desktop_configuration_drift', 'Native task parameters changed');
        const source = message.request.method.replace('/', '.');
        if (source !== 'thread.start') text(params.threadId, 'threadId');
        const draft = Object.freeze({ source, threadId: source === 'thread.start' ? null : params.threadId, cwd: optional(params.cwd),
            model: optional(params.model) ?? (source === 'turn.start' ? optional(params.collaborationMode?.settings?.model) : null), provider: optional(params.modelProvider) });
        const deadline = Math.min(Date.now() + 5000, Number.isFinite(message.expiresAtMs) ? message.expiresAtMs : Infinity);
        let chosen = null;
        for (const hook of item.hooks) {
            assertReady();
            const signal = item.controller.signal;
            if (signal.aborted || !hook.active) throw signal.reason ?? fail('configuration_retired', 'Task configuration retired before dispatch');
            const budget = Math.min(hook.timeoutMs, deadline - Date.now());
            if (budget < 1) throw fail('configuration_timeout', 'Task configuration deadline expired');
            let timer, abort;
            hook.calls++;
            try {
                const result = await new Promise((resolve, reject) => {
                    abort = () => reject(signal.reason ?? fail('configuration_retired', 'Task configuration retired'));
                    signal.addEventListener('abort', abort, { once: true });
                    timer = setTimeout(() => reject(fail('configuration_timeout', 'Task configuration callback timed out')), budget);
                    Promise.resolve().then(() => {
                        if (signal.aborted || !hook.active) throw fail('configuration_retired', 'Task configuration retired before callback dispatch');
                        return hook.handler(draft, Object.freeze({ signal }));
                    }).then(resolve, reject);
                }).finally(() => { clearTimeout(timer); signal.removeEventListener('abort', abort); });
                if (signal.aborted || !hook.active) throw signal.reason ?? fail('configuration_retired', 'Task configuration retired before dispatch');
                if (result == null) continue;
                fields(result, ['model', 'modelProvider', 'provider']);
                if (!Object.keys(result).length || result.modelProvider !== undefined && result.provider !== undefined) throw fail('invalid_argument', 'Select an existing provider or define one new provider');
                if (source === 'turn.start' && (result.modelProvider !== undefined || result.provider !== undefined)) throw fail('configuration_turn_provider_unsupported', 'A turn may only select its model');
                if (source === 'turn.start' && result.model === undefined) throw fail('invalid_argument', 'A turn configuration requires a model');
                const change = { hook };
                if (result.model !== undefined) change.model = text(result.model, 'model');
                if (result.modelProvider !== undefined) change.modelProvider = providerId(result.modelProvider);
                if (result.provider !== undefined) {
                    fields(result.provider, ['id', 'baseUrl', 'name', 'supportsWebSockets']);
                    const id = result.provider.id === undefined ? hook.providerId : providerId(result.provider.id);
                    if (result.provider.supportsWebSockets !== undefined && typeof result.provider.supportsWebSockets !== 'boolean') throw fail('invalid_argument', 'supportsWebSockets must be boolean');
                    change.modelProvider = id;
                    change.provider = { name: result.provider.name === undefined ? `Codlet ${hook.pluginId}` : text(result.provider.name, 'provider name'),
                        base_url: privateBaseUrl(result.provider.baseUrl), wire_api: 'responses', requires_openai_auth: false,
                        supports_websockets: result.provider.supportsWebSockets === true };
                }
                if (chosen) throw fail('configuration_conflict', 'More than one plugin configured this task request');
                chosen = change;
            } catch (error) {
                hook.failures++;
                // Callback errors may contain credentials or private endpoints.
                const code = ['invalid_argument', 'configuration_turn_provider_unsupported', 'configuration_timeout', 'configuration_retired', 'configuration_conflict', 'adapter_deactivated', 'desktop_configuration_unsupported'].includes(error?.code) ? error.code : 'configuration_callback_failed';
                throw fail(code, `${hook.pluginId}/${hook.id}: ${code}`);
            }
        }
        if (!chosen) return message;
        if (source === 'turn.start') {
            const collaborationMode = params.collaborationMode;
            if (collaborationMode != null && (typeof collaborationMode !== 'object' || Array.isArray(collaborationMode) || !collaborationMode.settings || typeof collaborationMode.settings !== 'object' || Array.isArray(collaborationMode.settings))) throw fail('desktop_configuration_drift', 'Native collaboration mode changed');
            const next = { ...message, request: { ...message.request, params: { ...params, model: chosen.model,
                ...(collaborationMode == null ? {} : { collaborationMode: { ...collaborationMode, settings: { ...collaborationMode.settings, model: chosen.model } } }) } } };
            if (JSON.stringify(next).length > 524288) throw fail('configuration_request_too_large', 'Native turn request exceeds the adapter limit');
            item.chosen = chosen.hook;
            return next;
        }
        const config = params.config ?? {};
        if (typeof config !== 'object' || Array.isArray(config)) throw fail('desktop_configuration_drift', 'Native task configuration changed');
        const providerKey = chosen.provider ? `model_providers.${chosen.modelProvider}` : null;
        if (providerKey && Object.prototype.hasOwnProperty.call(config, providerKey)) throw fail('configuration_conflict', 'Native configuration already owns this provider');
        const next = { ...message, request: { ...message.request, params: { ...params,
            ...(chosen.modelProvider === undefined ? {} : { modelProvider: chosen.modelProvider }),
            ...(chosen.model === undefined ? {} : { model: chosen.model }),
            ...(providerKey ? { config: { ...config, [providerKey]: chosen.provider } } : {}) } } };
        if (JSON.stringify(next).length > 524288) throw fail('configuration_request_too_large', 'Native task request exceeds the adapter limit');
        item.chosen = chosen.hook;
        return next;
    }
    function intercept(message, send) {
        try { if (restoration?.intercept(message, send)) return; }
        catch (error) { client.onError(message.request.id, error); return; }
        const source = message.request.method.replace('/', '.');
        const selected = ordered().filter(hook => hook.enabled && hook.appliesAt.includes(source));
        if (!alive || !selected.length) return send(message);
        if (pending.size >= 16) { client.onError(message.request.id, fail('configuration_limit', 'Too many pending task configurations')); return; }
        const item = { hooks: selected, controller: new AbortController(), chosen: null };
        pending.add(item);
        run(message, item).then(next => {
            assertReady();
            if (item.controller.signal.aborted || !client.requestPromises.has(message.request.id)) throw fail('configuration_retired', 'Native task request retired before dispatch');
            restoration?.authorize(next, item.chosen?.restorationOwner);
            send(next); if (item.chosen) item.chosen.applied++;
        }).catch(error => {
            if (client.requestPromises.has(message.request.id)) client.onError(message.request.id, fail(error.code ?? 'configuration_failed', error.message ?? 'Task configuration failed'));
        }).finally(() => { pending.delete(item); item.controller.abort(); });
    }
    return {
        register, intercept, probe, cancel,
        list(args = {}) { assertReady(); fields(args, []); return { configurations: ordered().map(inspect), restorations: restoration?.list() ?? [] }; },
        dispose() { if (!alive) return; alive = false; cancel(); for (const hook of [...hooks.values()]) hook.dispose(); hooks.clear(); return restoration?.dispose(); }
    };
}
