((context) => {
    'use strict';
    const listeners = new Set();
    // Codex publishes its resolved language (including its language override)
    // on the document root. Do not substitute the operating system's language.
    const language = () => /^zh(?:[-_]|$)/i.test(globalThis.document?.documentElement?.lang ?? '') ? 'zh' : 'en';
    let locale = language();
    let closed = false;
    let observer = null;
    context.onDeactivate(() => {
        closed = true;
        observer?.disconnect();
        listeners.clear();
    });
    const synchronize = () => {
        if (closed) return;
        const next = language();
        if (next === locale) return;
        locale = next;
        for (const listener of [...listeners]) {
            try { listener(locale); } catch { /* A subscriber cannot stop other plugins' language updates. */ }
        }
    };
    const root = globalThis.document?.documentElement;
    if (root && typeof globalThis.MutationObserver === 'function') {
        observer = new MutationObserver(synchronize);
        observer.observe(root, { attributes: true, attributeFilter: ['lang'] });
    }
    return Object.freeze({
        get locale() { synchronize(); return locale; },
        t(messages, key, values = {}) {
            synchronize();
            const translated = messages?.[locale]?.[key] ?? messages?.en?.[key] ?? key;
            return String(translated).replace(/\{([a-zA-Z0-9_]+)\}/g, (token, name) =>
                Object.prototype.hasOwnProperty.call(values, name) ? String(values[name]) : token);
        },
        onChange(listener) {
            if (closed) throw new Error('Plugin language context has retired.');
            if (typeof listener !== 'function') throw new TypeError('Language listener must be a function.');
            if (listeners.size >= 64) throw new Error('At most 64 language listeners per plugin.');
            listeners.add(listener);
            return () => listeners.delete(listener);
        }
    });
})
