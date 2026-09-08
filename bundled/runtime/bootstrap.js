(() => {
    const key = '__codletRendererV1';
    const existing = globalThis[key];
    if (existing !== undefined) {
        return existing?.abi === 1
            ? { ok: true, reused: true }
            : { ok: false, error: 'renderer bootstrap ABI collision' };
    }

    const plugins = new Map();
    const activating = new Map();
    const stopping = new Set();
    const operations = new Map();
    const RPC_TIMEOUT_MS = 15000;
    const scheduleTimeout = globalThis.setTimeout.bind(globalThis);
    const cancelTimeout = globalThis.clearTimeout.bind(globalThis);
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
        binding(JSON.stringify(envelope));
    }

    function createRpc(record) {
        const request = (capabilityOrMethod, methodOrParams, maybeParams) => {
            let requestData;
            try {
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
            const pending = new Promise((resolve, reject) => {
                const timer = scheduleTimeout(() => {
                    const request = takePending(record, id);
                    request?.reject(rpcError('rpc_timeout', 'Plugin request timed out. Please retry.'));
                }, RPC_TIMEOUT_MS);
                record.pending.set(id, { resolve, reject, timer });
            });
            try {
                callBinding(record, {
                    v: 1,
                    type: 'request',
                    pluginId: record.id,
                    generation: record.generation,
                    id,
                    capability: requestData.capability,
                    method: requestData.method,
                    params: requestData.params
                });
            } catch (error) {
                const rejection = error instanceof Error ? error : rpcError('binding_error', message(error));
                takePending(record, id)?.reject(rejection);
            }
            return pending;
        };

        const notify = (capabilityOrMethod, methodOrParams, maybeParams) => {
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
                params: requestData.params
            });
        };

        const provide = (capability, method, handler) => {
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
            record.endpoints.set(key, { capability, handler });
            return { ok: true };
        };

        const onNotification = (handler) => {
            if (typeof handler !== 'function') {
                throw rpcError('invalid_notification_handler', 'notification handler must be a function');
            }
            record.notifications.add(handler);
            return () => record.notifications.delete(handler);
        };

        return Object.freeze({ request, notify, provide, onNotification });
    }

    function takePending(record, id) {
        const request = record.pending.get(id);
        if (!request) return null;
        record.pending.delete(id);
        cancelTimeout(request.timer);
        return request;
    }

    function rejectPending(record, error) {
        for (const { reject, timer } of record.pending.values()) {
            cancelTimeout(timer);
            reject(error);
        }
        record.pending.clear();
    }

    function closeRecord(record, error) {
        record.closed = true;
        rejectPending(record, error);
        record.endpoints.clear();
        record.notifications.clear();
        if (plugins.get(record.id) === record) plugins.delete(record.id);
        if (activating.get(record.id) === record) activating.delete(record.id);
        stopping.delete(record);
    }

    async function cleanupRecord(record) {
        if (plugins.get(record.id) === record) plugins.delete(record.id);
        stopping.add(record);
        try {
            await record.definition.deactivate();
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
        if (!endpoint) return { ok: false, error: 'renderer endpoint is not registered' };
        try {
            const value = await endpoint.handler(request.params, Object.freeze({
                pluginId: record.id,
                generation: record.generation,
                capability: endpoint.capability,
                method: request.method
            }));
            return { ok: true, value: value === undefined ? null : value };
        } catch (error) {
            return { ok: false, error: message(error) };
        }
    }

    const runtime = {
        abi: 1,
        async activate(metadata, definition) {
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
                    notifications: new Set(),
                    closed: false,
                    definition
                };
                const context = Object.freeze({
                    pluginId: metadata.id,
                    version: metadata.version,
                    generation: metadata.generation,
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
            });
        },
        async deactivate(id, generation) {
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
            });
        },
        async __rpcInvoke(binding, request) {
            const current = Array.from(plugins.values()).find((record) => record.binding === binding);
            if (!current) return { ok: false, error: 'renderer binding is not active' };
            return invokeProvider(current, request);
        },
        __rpcReceive(binding, response) {
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
            for (const record of [...plugins.values(), ...activating.values(), ...stopping]) {
                if (record.binding === binding) closeRecord(record, rpcError('plugin_deactivated', 'renderer plugin was retired by the host'));
            }
            return { ok: true };
        },
        status() {
            return Array.from(plugins, ([id, value]) => ({ id, generation: value.generation }));
        }
    };

    Object.defineProperty(globalThis, key, {
        value: Object.freeze(runtime),
        configurable: false,
        enumerable: false,
        writable: false
    });
    return { ok: true, reused: false };
})()
