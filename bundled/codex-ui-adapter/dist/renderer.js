module.exports = (() => {
    const HEADER_SELECTOR = 'header[data-app-shell-header-layout]';
    const SURFACE_SELECTOR = '[data-testid="app-shell-header-context-menu-surface"]';
    const CAPABILITY_TOKEN = 'codex.ui.titlebar.afterMenu@1';
    const CAPABILITY_ATTRIBUTE = 'data-codlet-capability';
    const CAPABILITY = {
        name: 'codex.ui.titlebar.afterMenu',
        api: 1,
        scope: 'target'
    };

    let mount = null;
    let observer = null;

    function waitForDocument() {
        if (document.documentElement && document.body) return Promise.resolve();
        return new Promise((resolve) => {
            document.addEventListener('DOMContentLoaded', resolve, { once: true });
        });
    }

    function ensureMount(generation) {
        const header = document.querySelector(HEADER_SELECTOR);
        const surface = header?.querySelector(SURFACE_SELECTOR);
        if (!surface) return false;
        if (mount?.isConnected && mount.parentElement === surface) return true;

        mount?.remove();
        const stale = surface.querySelector(`[${CAPABILITY_ATTRIBUTE}="${CAPABILITY_TOKEN}"]`);
        stale?.remove();

        mount = document.createElement('span');
        mount.setAttribute(CAPABILITY_ATTRIBUTE, CAPABILITY_TOKEN);
        mount.setAttribute('data-codlet-provider', 'codex.ui.adapter');
        mount.setAttribute('data-codlet-generation', String(generation));
        mount.style.display = 'flex';
        mount.style.alignItems = 'center';
        mount.style.flex = '0 0 auto';
        mount.style.order = '-2147483647';
        surface.prepend(mount);
        return true;
    }

    return {
        async activate(context) {
            context.rpc.provide(CAPABILITY, 'getMount', () => {
                const available = Boolean(document.querySelector(
                    `header[data-app-shell-header-layout] [data-testid="app-shell-header-context-menu-surface"] [${CAPABILITY_ATTRIBUTE}="${CAPABILITY_TOKEN}"]`
                ));
                return { available, token: CAPABILITY_TOKEN };
            });
            await waitForDocument();
            ensureMount(context.generation);
            observer = new MutationObserver(() => ensureMount(context.generation));
            observer.observe(document.documentElement, { childList: true, subtree: true });
        },
        deactivate() {
            observer?.disconnect();
            mount?.remove();
            observer = null;
            mount = null;
        }
    };
})();
