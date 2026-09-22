// This small Script is the only permanent entry retained by a retired world.
// Its forwarding closures must not capture the SDK or the full runtime graph.
((options) => {
    let helpers = globalThis.__codletRendererHelpersV1;
    delete globalThis.__codletRendererHelpersV1;
    if (!helpers) return { ok: false, error: 'renderer helpers unavailable' };
    const state = { value: null };
    const publish = value => {
        state.value = value;
        const forward = method => (...args) => {
            if (state.value) return state.value[method](...args);
            if (method === 'status') return [];
            if (method === 'deactivate' || method === '__rpcClose') return { ok: true, inactive: true };
            return { ok: false, error: 'renderer generation has retired' };
        };
        const api = Object.freeze({abi: 1, world: options.world,
            activate: forward('activate'), deactivate: forward('deactivate'), status: forward('status'),
            __rpcInvoke: forward('__rpcInvoke'), __rpcCancel: forward('__rpcCancel'),
            __rpcReceive: forward('__rpcReceive'), __rpcClose: forward('__rpcClose')});
        Object.defineProperty(globalThis, '__codletRendererV1', {
            value: api, configurable: options.world === 'main', writable: false, enumerable: false
        });
        // Avoid retaining the initial argument in this callback's closure.
        value = null;
        return () => {
            state.value = null;
            if (options.world === 'main' && globalThis.__codletRendererV1 === api) delete globalThis.__codletRendererV1;
        };
    };
    try {
        const result = helpers.bootstrap(options, helpers.ui, helpers.i18n, helpers.services, helpers.dispose, helpers.page, publish);
        if (result.reused || !result.ok) helpers.dispose();
        return result;
    } finally { helpers = null; }
})
