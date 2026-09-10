((options = {}) => {
    const world = options.world ?? 'isolated';
    if (world !== 'isolated' && world !== 'main') return { ok: false, error: 'invalid renderer world' };
    const scheduleTimeout = globalThis.setTimeout.bind(globalThis);
    const cancelTimeout = globalThis.clearTimeout.bind(globalThis);
    const TaskChannel = globalThis.MessageChannel;
    let wakeQueued = false;

    function wakeEventLoop() {
        if (wakeQueued) return;
        wakeQueued = true;
        // Inspector evaluation can leave this world's Promise jobs queued until
        // the next browser task. Post one task so RPC/lifecycle completion does
        // not depend on keyboard, pointer or other incidental page activity.
        if (typeof TaskChannel === 'function') {
            const channel = new TaskChannel();
            channel.port1.onmessage = () => {
                channel.port1.close();
                channel.port2.close();
                wakeQueued = false;
            };
            channel.port2.postMessage(null);
        } else {
            scheduleTimeout(() => { wakeQueued = false; }, 0);
        }
    }

    wakeEventLoop();
    const key = '__codletRendererV1';
    const existing = globalThis[key];
    if (existing !== undefined) {
        return existing?.abi === 1 && existing.world === world
            ? { ok: true, reused: true }
            : { ok: false, error: 'renderer bootstrap ABI collision' };
    }

    const plugins = new Map();
    const activating = new Map();
    const stopping = new Set();
    const operations = new Map();
    const RPC_TIMEOUT_MS = 15000;
    const MAX_PENDING = 16;
    const MAX_ENDPOINTS = 256;
    const MAX_INVOCATIONS = 4;
    const now = () => globalThis.performance?.now?.() ?? Date.now();
    let nextRequestId = 1;

    const message = (error) => typeof error?.message === 'string' ? error.message : String(error);
    const rpcError = (code, text, data = null) => {
        const error = new Error(text);
        error.code = code;
        error.data = data;
        return error;
    };

    async function runExclusive(id, operation) {
        const previous = operations.get(id);
        let release;
        const gate = new Promise((resolve) => { release = resolve; });
        operations.set(id, gate);
        if (previous) await previous;
        try {
            return await operation();
        } finally {
            release();
            if (operations.get(id) === gate) operations.delete(id);
        }
    }

    function capabilityKey(capability) {
        if (!capability || typeof capability.name !== 'string' ||
            !Number.isSafeInteger(capability.api) || capability.api <= 0 ||
            typeof capability.scope !== 'string') {
            return null;
        }
        return `${capability.name}@${capability.api}[${capability.scope}]`;
    }

    function capabilityEquals(left, right) {
        return capabilityKey(left) !== null && capabilityKey(left) === capabilityKey(right);
    }

    function parseRequestArguments(record, capabilityOrMethod, methodOrParams, maybeParams) {
        if (typeof capabilityOrMethod === 'string') {
            if (record.requires.length !== 1) {
                throw rpcError('invalid_request', 'a capability descriptor is required');
            }
            return {
                capability: record.requires[0],
                method: capabilityOrMethod,
                params: methodOrParams === undefined ? null : methodOrParams
            };
        }
        return {
            capability: capabilityOrMethod,
            method: methodOrParams,
            params: maybeParams === undefined ? null : maybeParams
        };
    }

    function callBinding(record, envelope) {
        if (record.closed) throw rpcError('plugin_deactivated', 'renderer plugin was deactivated');
        const binding = globalThis[record.binding];
        if (typeof binding !== 'function') {
            throw rpcError('binding_unavailable', `renderer binding ${record.binding} is unavailable`);
        }
        const payload = JSON.stringify(envelope);
        if (new TextEncoder().encode(payload).byteLength > 1024 * 1024) throw rpcError('request_too_large', 'renderer RPC payload exceeds 1 MiB');
        binding(payload);
    }

    function createRpc(record, lineage) {
        const request = (capabilityOrMethod, methodOrParams, maybeParams, maybeOptions) => {
            let requestData;
            let options;
            let timeoutMs;
            try {
                if (lineage?.closed) throw rpcError('invocation_cancelled', 'the parent renderer invocation has retired');
                options = (typeof capabilityOrMethod === 'string' ? maybeParams : maybeOptions) ?? {};
                if (!options || typeof options !== 'object' || Array.isArray(options)) throw rpcError('invalid_request', 'RPC options must be an object');
                timeoutMs = options.timeoutMs ?? RPC_TIMEOUT_MS;
                if (!Number.isInteger(timeoutMs) || timeoutMs < 1 || timeoutMs > RPC_TIMEOUT_MS) throw rpcError('invalid_timeout', 'timeoutMs must be 1..15000');
                if (lineage) timeoutMs = Math.min(timeoutMs, Math.floor(lineage.deadline - now()));
                if (timeoutMs < 1) throw rpcError('request_timeout', 'the original invocation deadline expired');
                if (options.signal !== undefined && (typeof options.signal?.addEventListener !== 'function' || typeof options.signal?.removeEventListener !== 'function')) throw rpcError('invalid_signal', 'signal must be an AbortSignal');
                if (options.signal?.aborted) throw rpcError('invocation_cancelled', 'the caller already cancelled this request');
                if (record.pending.size >= MAX_PENDING) throw rpcError('request_limit', 'this renderer has 16 pending requests');
                requestData = parseRequestArguments(record, capabilityOrMethod, methodOrParams, maybeParams);
                if (typeof requestData.method !== 'string' || requestData.method.length === 0) {
                    throw rpcError('invalid_request', 'renderer RPC method must be a non-empty string');
                }
                if (capabilityKey(requestData.capability) === null) {
                    throw rpcError('invalid_request', 'renderer RPC capability descriptor is invalid');
                }
            } catch (error) {
                return Promise.reject(error);
            }

            if (!Number.isSafeInteger(nextRequestId)) {
                return Promise.reject(rpcError('request_id_exhausted', 'renderer RPC request id exhausted'));
            }
            const id = nextRequestId;
            nextRequestId += 1;
            const envelope = {
                v: 1, type: 'request', pluginId: record.id, generation: record.generation, id,
                capability: requestData.capability, method: requestData.method, params: requestData.params,
                ...(options.timeoutMs !== undefined || lineage ? { timeoutMs } : {}),
                ...(lineage?.token ? { parentToken: lineage.token } : {})
            };
            const pending = new Promise((resolve, reject) => {
                const timer = scheduleTimeout(() => {
                    const request = takePending(record, id);
                    request?.reject(rpcError('rpc_timeout', 'Plugin request timed out. Please retry.'));
                }, timeoutMs);
                const onAbort = () => {
                    const request = takePending(record, id);
                    if (!request) return;
                    try { callBinding(record, { ...envelope, type: 'cancel' }); } catch {}
                    request.reject(rpcError('invocation_cancelled', 'the caller cancelled this request'));
                };
                record.pending.set(id, { resolve, reject, timer, signal: options.signal, onAbort, lineage });
                options.signal?.addEventListener('abort', onAbort, { once: true });
            });
            try {
                callBinding(record, envelope);
            } catch (error) {
                const rejection = error instanceof Error ? error : rpcError('binding_error', message(error));
                takePending(record, id)?.reject(rejection);
            }
            return pending;
        };

        const notify = (capabilityOrMethod, methodOrParams, maybeParams) => {
            if (lineage?.closed) throw rpcError('invocation_cancelled', 'the parent renderer invocation has retired');
            const requestData = parseRequestArguments(record, capabilityOrMethod, methodOrParams, maybeParams);
            if (typeof requestData.method !== 'string' || requestData.method.length === 0) {
                throw rpcError('invalid_request', 'renderer RPC method must be a non-empty string');
            }
            if (capabilityKey(requestData.capability) === null) {
                throw rpcError('invalid_request', 'renderer RPC capability descriptor is invalid');
            }
            callBinding(record, {
                v: 1,
                type: 'notification',
                pluginId: record.id,
                generation: record.generation,
                capability: requestData.capability,
                method: requestData.method,
                params: requestData.params,
                ...(lineage?.token ? { parentToken: lineage.token, timeoutMs: Math.max(1, Math.floor(lineage.deadline - now())) } : {})
            });
        };

        const provide = (capability, method, handler) => {
            if (record.closed || stopping.has(record)) throw rpcError('plugin_deactivated', 'renderer plugin was deactivated');
            if (typeof method !== 'string' || method.length === 0 || typeof handler !== 'function') {
                throw rpcError('invalid_provider', 'renderer endpoint requires a method and function');
            }
            if (!record.provides.some((provided) => capabilityEquals(provided, capability))) {
                throw rpcError('invalid_provider', 'renderer endpoint is not declared by the plugin');
            }
            const key = `${capabilityKey(capability)}\u0000${method}`;
            if (record.endpoints.has(key)) {
                throw rpcError('invalid_provider', `renderer endpoint ${method} is already registered`);
            }
            if (record.endpoints.size >= MAX_ENDPOINTS) throw rpcError('request_limit', 'renderer endpoint registration limit reached');
            const declared = record.provides.find(provided => capabilityEquals(provided, capability));
            record.endpoints.set(key, { capability: Object.freeze({ name: declared.name, api: declared.api, scope: declared.scope }), handler });
            record.unavailable.delete(capabilityKey(capability));
            return { ok: true };
        };

        const unavailable = (capability, reason) => {
            if (record.closed || stopping.has(record)) throw rpcError('plugin_deactivated', 'renderer plugin was deactivated');
            if (!record.provides.some(provided => capabilityEquals(provided, capability)) || typeof reason !== 'string' || !reason.length || reason.length > 1024) throw rpcError('invalid_provider', 'unavailable requires an owned capability and a bounded reason');
            const prefix = `${capabilityKey(capability)}\u0000`;
            for (const key of record.endpoints.keys()) if (key.startsWith(prefix)) record.endpoints.delete(key);
            record.unavailable.set(capabilityKey(capability), reason);
        };

        const onNotification = (handler) => {
            if (typeof handler !== 'function') {
                throw rpcError('invalid_notification_handler', 'notification handler must be a function');
            }
            if (record.notifications.size >= 64) throw rpcError('request_limit', 'renderer notification listener limit reached');
            record.notifications.add(handler);
            return () => record.notifications.delete(handler);
        };

        return Object.freeze({ request, notify, provide, unavailable, onNotification });
    }

    function takePending(record, id) {
        const request = record.pending.get(id);
        if (!request) return null;
        record.pending.delete(id);
        cancelTimeout(request.timer);
        request.signal?.removeEventListener('abort', request.onAbort);
        return request;
    }

    function rejectPending(record, error) {
        for (const id of record.pending.keys()) takePending(record, id)?.reject(error);
    }

    function releaseEmptyRuntime() {
        if (world === 'main' && !plugins.size && !activating.size && !stopping.size && !operations.size && globalThis[key] === runtime) {
            delete globalThis[key];
        }
    }

    function closeRecord(record, error) {
        record.closed = true;
        disposeListeners(record);
        for (const invocation of record.invocations.values()) invocation.cancel(error);
        rejectPending(record, error);
        record.endpoints.clear();
        record.unavailable.clear();
        record.notifications.clear();
        if (plugins.get(record.id) === record) plugins.delete(record.id);
        if (activating.get(record.id) === record) activating.delete(record.id);
        stopping.delete(record);
    }

    function disposeListeners(record) {
        const listeners = [...record.disposers];
        record.disposers.clear();
        for (const listener of listeners) {
            try {
                const result = listener();
                if (typeof result?.then === 'function') {
                    Promise.resolve(result).catch(() => {});
                    throw rpcError('renderer_cleanup_failed', 'onDeactivate listeners must be synchronous');
                }
                if (result?.reloadRequired === true) record.disposeError ??= `Renderer reload required: ${result.reason ?? 'page changes could not be undone'}`;
            } catch (error) { record.disposeError ??= message(error); }
        }
    }

    async function cleanupRecord(record) {
        if (plugins.get(record.id) === record) plugins.delete(record.id);
        stopping.add(record);
        disposeListeners(record);
        try {
            const result = await record.definition.deactivate();
            if (result?.reloadRequired === true) {
                throw rpcError('renderer_reload_required', `Renderer reload required: ${typeof result.reason === 'string' ? result.reason : 'the plugin cannot undo its page changes'}`);
            }
            if (record.disposeError) throw rpcError('renderer_cleanup_failed', record.disposeError);
        } finally {
            closeRecord(record, rpcError('plugin_deactivated', 'renderer plugin was deactivated'));
        }
    }

    async function invokeProvider(record, request) {
        if (!request || request.v !== 1 ||
            (request.type !== 'request' && request.type !== 'notification') ||
            typeof request.pluginId !== 'string' || request.pluginId.length === 0 ||
            !Number.isSafeInteger(request.generation) || request.generation < 1 ||
            (request.type === 'request' && (!Number.isSafeInteger(request.id) || request.id < 1)) ||
            (request.type === 'notification' && request.id !== undefined) ||
            typeof request.method !== 'string' || request.method.length === 0 ||
            !Object.prototype.hasOwnProperty.call(request, 'params') ||
            capabilityKey(request.capability) === null) {
            return { ok: false, error: 'invalid provider request' };
        }
        const key = `${capabilityKey(request.capability)}\u0000${request.method}`;
        const endpoint = record.endpoints.get(key);
        if (!endpoint) return record.unavailable.has(capabilityKey(request.capability))
            ? { ok: false, code: 'capability_unavailable', error: record.unavailable.get(capabilityKey(request.capability)) }
            : { ok: false, code: 'method_not_found', error: 'renderer endpoint is not registered' };
        if (record.invocations.size >= MAX_INVOCATIONS) return { ok: false, code: 'request_limit', error: 'this renderer has four active invocations' };
        const core = request.coreInvocation;
        if (core !== undefined && (!core || typeof core.token !== 'string' || core.token.length > 128 || !Number.isInteger(core.remainingMs) || core.remainingMs < 1 || core.remainingMs > RPC_TIMEOUT_MS || !Number.isInteger(core.depth) || core.depth < 1 || core.depth > 8 || !core.caller || !core.scope)) return { ok: false, code: 'invalid_invocation', error: 'invalid Core invocation metadata' };
        const controller = new AbortController();
        const token = core?.token ?? Symbol('legacy-invocation');
        if (record.invocations.has(token)) return { ok: false, code: 'invalid_invocation', error: 'duplicate Core invocation token' };
        const lineage = { token: core?.token, deadline: now() + (core?.remainingMs ?? RPC_TIMEOUT_MS), closed: false };
        return new Promise(resolve => {
            let timer;
            const finish = (value, failure) => {
                if (lineage.closed) return;
                lineage.closed = true;
                cancelTimeout(timer);
                record.invocations.delete(token);
                const retired = failure ?? rpcError('invocation_cancelled', 'the renderer handler completed');
                controller.abort(retired);
                for (const [id, pending] of record.pending) if (pending.lineage === lineage) takePending(record, id)?.reject(retired);
                if (failure) resolve({ ok: false, code: failure.code ?? 'provider_error', error: message(failure) });
                else {
                    try {
                        const encoded = JSON.stringify(value === undefined ? null : value);
                        if (encoded === undefined || new TextEncoder().encode(encoded).byteLength > 1024 * 1024 - 4096) throw rpcError('response_too_large', 'renderer result exceeds the payload limit');
                        resolve({ ok: true, value: value === undefined ? null : value });
                    } catch (error) { resolve({ ok: false, code: error.code ?? 'provider_error', error: message(error) }); }
                }
            };
            record.invocations.set(token, { cancel: reason => finish(null, reason) });
            timer = scheduleTimeout(() => finish(null, rpcError('request_timeout', 'the original renderer invocation deadline expired')), core?.remainingMs ?? RPC_TIMEOUT_MS);
            const invocation = Object.freeze({
                pluginId: record.id, generation: record.generation, capability: endpoint.capability, method: request.method,
                ...(core ? { caller: Object.freeze({ ...core.caller }), scope: Object.freeze({ ...core.scope }), depth: core.depth } : {}),
                signal: controller.signal, remainingMs: () => Math.max(0, Math.floor(lineage.deadline - now())), rpc: createRpc(record, lineage)
            });
            Promise.resolve().then(() => endpoint.handler(request.params, invocation)).then(value => finish(value), failure => finish(null, failure));
        });
    }

    const runtime = {
        abi: 1,
        world,
        async activate(metadata, definition) {
            wakeEventLoop();
            if (!metadata || typeof metadata.id !== 'string' || metadata.id.length === 0 ||
                !Number.isSafeInteger(metadata.generation) || metadata.generation < 1) {
                return { ok: false, error: 'invalid plugin metadata' };
            }
            if (metadata.binding !== undefined &&
                (typeof metadata.binding !== 'string' || metadata.binding.length === 0)) {
                return { ok: false, error: 'invalid renderer binding metadata' };
            }
            if (!definition || typeof definition.activate !== 'function' || typeof definition.deactivate !== 'function') {
                return { ok: false, error: 'renderer entry must export activate and deactivate functions' };
            }
            return runExclusive(metadata.id, async () => {
                const current = plugins.get(metadata.id);
                if (current?.generation === metadata.generation) {
                    return { ok: true, id: metadata.id, generation: metadata.generation, reused: true };
                }
                if (current && current.generation > metadata.generation) {
                    return { ok: false, error: 'stale plugin generation' };
                }

                const record = {
                    id: metadata.id,
                    version: metadata.version,
                    generation: metadata.generation,
                    binding: metadata.binding,
                    provides: Array.isArray(metadata.provides) ? metadata.provides.slice() : [],
                    requires: Array.isArray(metadata.requires) ? metadata.requires.slice() : [],
                    pending: new Map(),
                    endpoints: new Map(),
                    unavailable: new Map(),
                    invocations: new Map(),
                    notifications: new Set(),
                    disposers: new Set(),
                    disposeError: null,
                    diagnosticCount: 0,
                    closed: false,
                    definition
                };
                const context = Object.freeze({
                    pluginId: metadata.id,
                    version: metadata.version,
                    generation: metadata.generation,
                    world,
                    reportDiagnostic(diagnostic) {
                        if (!diagnostic || typeof diagnostic.code !== 'string' || !/^[a-zA-Z0-9_.-]{1,64}$/.test(diagnostic.code) || typeof diagnostic.message !== 'string' || new TextEncoder().encode(diagnostic.message).byteLength > 4096 || !['info', 'error'].includes(diagnostic.level ?? 'error')) throw rpcError('invalid_diagnostic', 'expected a bounded diagnostic code, message and level');
                        if (record.diagnosticCount >= 32) throw rpcError('diagnostic_limit', 'at most 32 diagnostics per renderer generation');
                        callBinding(record, { v: 1, type: 'diagnostic', pluginId: record.id, generation: record.generation, code: diagnostic.code, message: diagnostic.message, level: diagnostic.level ?? 'error' });
                        record.diagnosticCount++;
                    },
                    onDeactivate(listener) {
                        if (typeof listener !== 'function') throw rpcError('invalid_listener', 'onDeactivate requires a synchronous function');
                        if (record.closed || stopping.has(record)) throw rpcError('plugin_deactivated', 'renderer plugin was deactivated');
                        if (record.disposers.size >= 64) throw rpcError('request_limit', 'renderer cleanup listener limit reached');
                        record.disposers.add(listener);
                        return () => record.disposers.delete(listener);
                    },
                    rpc: createRpc(record)
                });
                activating.set(metadata.id, record);
                try {
                    await definition.activate(context);
                    if (record.closed) throw rpcError('activation_cancelled', 'renderer activation was cancelled');
                } catch (error) {
                    activating.delete(metadata.id);
                    let cleanupError = null;
                    try {
                        await cleanupRecord(record);
                    } catch (cleanup) {
                        cleanupError = message(cleanup);
                    }
                    rejectPending(record, rpcError('activation_failed', message(error)));
                    return {
                        ok: false,
                        error: message(error),
                        cleanupError
                    };
                }
                activating.delete(metadata.id);
                plugins.set(metadata.id, record);

                let cleanupError = null;
                if (current) {
                    try {
                        await cleanupRecord(current);
                    } catch (error) {
                        cleanupError = message(error);
                    }
                    rejectPending(current, rpcError('generation_replaced', 'renderer plugin generation was replaced'));
                }
                return {
                    ok: true,
                    id: metadata.id,
                    generation: metadata.generation,
                    reused: false,
                    cleanupError
                };
            }).finally(releaseEmptyRuntime);
        },
        async deactivate(id, generation) {
            wakeEventLoop();
            return runExclusive(id, async () => {
                const current = plugins.get(id);
                if (!current) return { ok: true, id, generation, inactive: true };
                if (current.generation !== generation) {
                    return { ok: false, error: 'plugin generation mismatch' };
                }
                plugins.delete(id);
                try {
                    await cleanupRecord(current);
                    return { ok: true, id, generation, inactive: true };
                } catch (error) {
                    return { ok: false, error: message(error) };
                }
            }).finally(releaseEmptyRuntime);
        },
        async __rpcInvoke(binding, request) {
            wakeEventLoop();
            const current = Array.from(plugins.values()).find((record) => record.binding === binding);
            if (!current) return { ok: false, error: 'renderer binding is not active' };
            return invokeProvider(current, request);
        },
        __rpcCancel(binding, token) {
            wakeEventLoop();
            const current = Array.from(plugins.values()).find(record => record.binding === binding);
            current?.invocations.get(token)?.cancel(rpcError('invocation_cancelled', 'Core retired the caller invocation'));
            return { ok: true };
        },
        __rpcReceive(binding, response) {
            wakeEventLoop();
            const current = Array.from(plugins.values()).find((record) => record.binding === binding)
                ?? Array.from(activating.values()).find((record) => record.binding === binding)
                ?? Array.from(stopping).find((record) => record.binding === binding);
            if (!current || !response || response.v !== 1 || response.type !== 'response') {
                return { ok: false, error: 'renderer binding response is not recognized' };
            }
            const pending = takePending(current, response.id);
            if (!pending) return { ok: false, error: 'renderer RPC response id is not pending' };
            if (response.ok === true) {
                pending.resolve(response.result === undefined ? null : response.result);
            } else {
                const detail = response.error && typeof response.error === 'object'
                    ? response.error
                    : { code: 'remote_error', message: 'renderer RPC request was rejected' };
                pending.reject(rpcError(
                    typeof detail.code === 'string' ? detail.code : 'remote_error',
                    typeof detail.message === 'string' ? detail.message : String(detail.message),
                    detail.data ?? null
                ));
            }
            return { ok: true };
        },
        __rpcClose(binding) {
            wakeEventLoop();
            const failures = [];
            for (const record of [...plugins.values(), ...activating.values(), ...stopping]) {
                if (record.binding === binding) {
                    closeRecord(record, rpcError('plugin_deactivated', 'renderer plugin was retired by the host'));
                    if (record.disposeError) failures.push(record.disposeError);
                }
            }
            releaseEmptyRuntime();
            return failures.length ? { ok: false, error: failures.join('; ') } : { ok: true };
        },
        status() {
            wakeEventLoop();
            return Array.from(plugins, ([id, value]) => ({ id, generation: value.generation }));
        }
    };

    Object.defineProperty(globalThis, key, {
        value: Object.freeze(runtime),
        configurable: world === 'main',
        enumerable: false,
        writable: false
    });
    return { ok: true, reused: false };
})
