// Core semantic Codex facade. Native discovery lives in codex/, and local
// callback/DOM handles keep their original generation-scoped capability tickets.
((context, admission = null) => {
    const capability = name => Object.freeze({ name, api: 1, scope: 'target' });
    const caps = Object.freeze({ navigation: capability('codex.ui.navigation.page'), composer: capability('codex.ui.composer.action'), workspace: capability('codex.ui.workspace'), compatibility: capability('codex.desktop.compatibility'), submissions: capability('codex.ui.preSubmit'), read: capability('codex.backend.read'), write: capability('codex.backend.write'), events: capability('codex.backend.events') });
    const fail = (code, message) => Object.assign(new Error(message), { code });
    let alive = true;
    context.onDeactivate(() => { alive = false; });
    const check = () => { if (!alive) throw fail('plugin_deactivated', 'Codex SDK owner has retired'); };
    const pure = new Set(['getSnapshot', 'getSurface', 'resolveThreadReference', 'resolveThreadInteraction', 'hasBlockingOverlay', 'getScrollPosition', 'exportState', 'inspect']);
    const cleanup = new Set(['dispose', 'close', 'deactivate']);
    const wrapped = new WeakMap();
    const run = (operation, cleaning = false) => { if (!cleaning) check(); return admission ? admission.run(operation, cleaning) : operation(); };
    // Clone only the SDK handle shell. Native elements, callbacks and snapshot
    // data keep their identity; promised ready/executed/committed work is counted
    // until it settles, and all later handle writes need a fresh admission.
    function handle(value) {
        if (!admission) return value;
        const callable = typeof value === 'function';
        if (!value || !callable && typeof value !== 'object') return value;
        if (typeof value.then === 'function') {
            const completion = Promise.resolve(value).then(handle);
            admission?.track(completion);
            return completion;
        }
        if (wrapped.has(value)) return wrapped.get(value);
        const descriptors = Object.getOwnPropertyDescriptors(value);
        if (!callable && !Object.values(descriptors).some(item => typeof item.value === 'function') && !['ready', 'executed', 'committed'].some(key => key in descriptors)) return value;
        const shell = callable ? (...args) => run(() => handle(value(...args)), true) : {}; wrapped.set(value, shell);
        for (const [name, descriptor] of Object.entries(descriptors)) {
            if (callable && ['name', 'length', 'prototype', 'caller', 'arguments'].includes(name)) continue;
            if (typeof descriptor.value === 'function') descriptor.value = (...args) => {
                if (!cleanup.has(name)) check();
                const operation = () => handle(value[name](...args));
                return pure.has(name) ? operation() : run(operation, cleanup.has(name));
            };
            else if (['ready', 'executed', 'committed'].includes(name)) {
                if (descriptor.get) { const get = descriptor.get; descriptor.get = () => { const result = get.call(value); admission?.track(result); return result; }; }
                else admission?.track(descriptor.value);
            }
            Object.defineProperty(shell, name, descriptor);
        }
        return Object.freeze(shell);
    }
    const request = (cap, method, params = {}, options) => { check(); return context.rpc.request(cap, method, params, options); };
    const read = (method, params = {}, options) => request(caps.read, method, params, options);
    const write = (method, params = {}, options) => request(caps.write, method, params, options);
    async function local(cap, symbol, method, args = [], options) { return run(async () => {
        check();
        if (context.world !== 'main') throw fail('main_world_required', 'This Codex callback or DOM handle requires a main-world renderer');
        const descriptor = await request(cap, 'getApi', {}, options);
        check();
        if (descriptor?.api !== 1 || descriptor.symbol !== symbol || typeof descriptor.ticket !== 'string') throw fail('codex_api_invalid', 'Core returned an invalid Codex API ticket');
        const api = globalThis[Symbol.for(symbol)];
        if (api?.api !== 1 || typeof api[method] !== 'function') throw fail('capability_unavailable', 'This Codex capability is unavailable in the current document');
        return handle(api[method](context, descriptor.ticket, ...args));
    }); }
    async function registerAction(options, handler) { return run(async () => {
        check();
        if (typeof handler !== 'function') throw fail('invalid_argument', 'Composer action requires a callback');
        if (!options || typeof options.label !== 'string' || Object.keys(options).some(key => !['label', 'token'].includes(key))) throw fail('invalid_argument', 'Composer action expects label and optional token');
        const token = options.token ?? crypto.randomUUID();
        const lease = document.createElement('span');
        lease.hidden = true;
        Object.assign(lease.dataset, { codletComposerActionLease: token, codletComposerActionOwner: context.pluginId, codletGeneration: String(context.generation) });
        let live = true, release;
        const dispose = () => { if (!live) return; live = false; lease.removeEventListener('codlet:composer-action', clicked); lease.remove(); release?.(); };
        const clicked = event => {
            if (!live || !alive) return;
            let detail; try { detail = JSON.parse(event.detail); } catch { return; }
            if (detail?.api !== 1 || detail.token !== token || typeof detail.instance !== 'string') return;
            const anchor = [...document.querySelectorAll('[data-codlet-composer-action-instance-id]')].find(node => node.dataset.codletComposerActionInstanceId === detail.instance && node.dataset.codletComposerActionOwner === context.pluginId && node.dataset.codletGeneration === String(context.generation)) ?? null;
            try { Promise.resolve(run(() => handler(Object.freeze({ ...detail, anchor })))).catch(error => context.reportDiagnostic?.({ code: 'codex_callback_failed', message: String(error?.message ?? error).slice(0, 3000) })); }
            catch (error) { context.reportDiagnostic?.({ code: 'codex_callback_failed', message: String(error?.message ?? error).slice(0, 3000) }); }
        };
        try {
            release = context.onDeactivate(dispose);
            lease.addEventListener('codlet:composer-action', clicked);
            if (!document.body) await new Promise((resolve, reject) => {
                const ready = () => { document.removeEventListener('DOMContentLoaded', ready); releaseReady(); live && alive ? resolve() : reject(fail('plugin_deactivated', 'Composer action owner retired')); };
                const releaseReady = context.onDeactivate(() => { document.removeEventListener('DOMContentLoaded', ready); reject(fail('plugin_deactivated', 'Composer action owner retired')); });
                document.addEventListener('DOMContentLoaded', ready, { once: true });
            });
            check(); document.body.appendChild(lease);
            const registration = await request(caps.composer, 'register', { label: options.label, token });
            check();
            if (!live) throw fail('plugin_deactivated', 'Composer action owner retired');
            if (registration?.api !== 1 || registration.token !== token) throw fail('codex_api_invalid', 'Core returned an invalid composer registration');
            if (registration.available === false) dispose();
            return handle(Object.freeze({ registration: Object.freeze({ ...registration }), status: () => { if (!live) throw fail('plugin_deactivated', 'Composer action has retired'); return request(caps.composer, 'status', { token }); }, async unregister() { if (!live) return { removed: false }; try { return await request(caps.composer, 'unregister', { token }); } finally { dispose(); } }, dispose }));
        } catch (error) { dispose(); throw error; }
    }); }
    const group = (methods, call) => Object.freeze(Object.fromEntries(Object.entries(methods).map(([name, method]) => [name, (params = {}, options) => call(method, params, options)])));
    return Object.freeze({
        api: 1, capabilities: caps,
        navigation: Object.freeze({ page(options) { check(); if (typeof context.ui?.page !== 'function') throw fail('capability_unavailable', 'Core page SDK is unavailable'); return context.ui.page(options); }, newTaskDraft: (params, options) => request(caps.navigation, 'newTaskDraft', params, options) }),
        composer: Object.freeze({ registerAction }),
        workspace: Object.freeze({ connect: options => local(caps.workspace, 'codlet.codex.ui.workspace.v1', 'connect', [], options) }),
        compatibility: Object.freeze({ probe: (params = {}, options) => request(caps.compatibility, 'probe', params, options), waitReady: (params = {}, options) => request(caps.compatibility, 'waitReady', params, options) }),
        backend: Object.freeze({ read, write }),
        selection: group({ get: 'selection.get' }, read),
        threads: Object.freeze({ ...group({ list: 'threads.list', loaded: 'threads.loaded', get: 'threads.get', configuration: 'threads.configuration' }, read), ...group({ open: 'threads.open', reconfigure: 'threads.reconfigure' }, write) }),
        turns: Object.freeze({ ...group({ list: 'turns.list' }, read), ...group({ start: 'turns.start', steer: 'turns.steer', interrupt: 'turns.interrupt' }, write) }),
        items: group({ list: 'items.list' }, read), models: group({ list: 'models.list' }, read), skills: group({ list: 'skills.list' }, read), providers: group({ list: 'providers.list' }, read),
        approvals: Object.freeze({ ...group({ list: 'approvals.list' }, read), ...group({ respond: 'approvals.respond' }, write) }),
        permissions: Object.freeze({ ...group({ get: 'permissions.get' }, read), ...group({ update: 'permissions.update' }, write), register: options => local(caps.write, 'codlet.codex.desktop.v1', 'registerPermissions', [], options) }),
        events: Object.freeze({ read: (params = {}, options) => request(caps.events, 'read', params, options), onEvent: (handler, options) => local(caps.events, 'codlet.codex.desktop.v1', 'onEvent', [handler], options) }),
        submissions: Object.freeze({ register: (options, handler, invocation) => local(caps.submissions, 'codlet.codex.desktop.v1', 'registerPreSubmit', [options, handler], invocation), list: (params = {}, options) => request(caps.submissions, 'interceptors.list', params, options) }),
        configuration: Object.freeze({ register: (options, handler, invocation) => local(caps.write, 'codlet.codex.desktop.v1', 'registerThreadConfiguration', [options, handler], invocation), list: (params = {}, options) => request(caps.write, 'configurations.list', params, options) }),
    });
})
