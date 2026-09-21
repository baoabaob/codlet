((loadUI, createI18n = null, createServices = null) => {
    const channels = new Set();
    const NativeChannel = globalThis.MessageChannel;
    let disposed = false;
    // Shadow only the bundled SDK's free MessageChannel identifier. The native
    // client's React scheduler and the page's global constructor stay untouched.
    const OwnedChannel = typeof NativeChannel === 'function' ? function () {
        if (disposed) throw new Error('renderer helpers have retired');
        const channel = new NativeChannel();
        channels.add(channel);
        return channel;
    } : undefined;
    const helpers = Object.freeze({
        ui() {
            if (disposed) throw new Error('renderer helpers have retired');
            return loadUI(OwnedChannel);
        },
        i18n: createI18n,
        services: createServices,
        dispose() {
            if (disposed) return;
            disposed = true;
            const errors = [];
            for (const channel of channels) for (const port of [channel.port1, channel.port2]) {
                try { port.onmessage = null; port.onmessageerror = null; port.close(); }
                catch (error) { errors.push(error); }
            }
            channels.clear();
            if (errors.length) throw new AggregateError(errors, 'UI scheduler channel cleanup failed');
        }
    });
    Object.defineProperty(globalThis, '__codletRendererHelpersV1', { value: helpers, configurable: true });
    return { ok: true };
})
