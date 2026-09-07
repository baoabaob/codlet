module.exports = (() => {
    const HEADER_SELECTOR = 'header[data-app-shell-header-layout]';
    const SURFACE_SELECTOR = '[data-testid="app-shell-header-context-menu-surface"]';
    const CAPABILITY_TOKEN = 'codex.ui.titlebar.afterMenu@1';
    const CAPABILITY_ATTRIBUTE = 'data-codlet-capability';
    const PROVIDER_ATTRIBUTE = 'data-codlet-provider';
    const PROVIDER_ID = 'codex.ui.adapter';
    const STYLE_ATTRIBUTE = 'data-codlet-ui-adapter-style';
    const MOUNT_SELECTOR = `[${CAPABILITY_ATTRIBUTE}="${CAPABILITY_TOKEN}"][${PROVIDER_ATTRIBUTE}="${PROVIDER_ID}"]`;
    const STYLE_SELECTOR = `style[${STYLE_ATTRIBUTE}="${CAPABILITY_TOKEN}"]`;
    const MENU_IDS = ['file', 'edit', 'view', 'help'].map(name => `application-menu-trigger-${name}-menu`);
    const CAPABILITY = {
        name: 'codex.ui.titlebar.afterMenu',
        api: 1,
        scope: 'target'
    };

    let current = null;

    function waitForDocument(session) {
        if (document.documentElement && document.body) return Promise.resolve();
        return new Promise((resolve) => {
            const finish = () => {
                document.removeEventListener('DOMContentLoaded', finish);
                session.cancelReady = null;
                resolve();
            };
            session.cancelReady = finish;
            document.addEventListener('DOMContentLoaded', finish, { once: true });
        });
    }

    function findPlacement() {
        if (document.documentElement?.getAttribute('data-codex-window-chrome') === 'application-menu') {
            for (const menu of document.querySelectorAll('[role="menubar"]')) {
                const triggers = MENU_IDS.map(id => menu.querySelector(`[id="${id}"][role="menuitem"]`));
                if (!triggers.every(trigger => trigger?.parentElement === menu)) continue;
                const children = Array.from(menu.children);
                if (!triggers.every((trigger, index) => index === 0 ||
                    children.indexOf(triggers[index - 1]) < children.indexOf(trigger))) continue;
                // A sibling stays outside Radix's private collection and roving-focus ownership.
                return { parent: menu.parentElement, anchor: menu, name: 'application-menu' };
            }
        }
        for (const header of document.querySelectorAll(HEADER_SELECTOR)) {
            const surface = header.querySelector(SURFACE_SELECTOR);
            if (surface) return { parent: surface, anchor: null, name: 'legacy-header' };
        }
        return null;
    }

    function isPlaced(mount, placement) {
        return Boolean(mount?.isConnected && placement && mount.parentElement === placement.parent &&
            (placement.anchor ? mount.previousElementSibling === placement.anchor :
                placement.parent.firstElementChild === mount));
    }

    function ensureStyle(session) {
        if (!session.style) {
            session.style = document.createElement('style');
            session.style.setAttribute(STYLE_ATTRIBUTE, CAPABILITY_TOKEN);
            // Keep native variables in this adapter; CSS inheritance handles live theme/font changes.
            session.style.textContent = `
                ${MOUNT_SELECTOR}, [data-codlet-ui-theme="${CAPABILITY_TOKEN}"] {
                    --codlet-ui-bg: var(--color-background-application-menu, var(--color-background-elevated-primary, Canvas));
                    --codlet-ui-fg: var(--color-text, CanvasText);
                    --codlet-ui-muted: var(--color-text-tertiary, GrayText);
                    --codlet-ui-border: var(--color-border, ButtonBorder);
                    --codlet-ui-hover: var(--color-background-button-tertiary-hover, ButtonFace);
                    --codlet-ui-active: var(--color-codex-application-menu-selection, ButtonFace);
                    --codlet-ui-focus: var(--color-border-focus, Highlight);
                    --codlet-ui-font: var(--font-sans, system-ui, sans-serif);
                    --codlet-ui-font-size: var(--text-base, 14px);
                    --codlet-ui-menu-height: var(--height-toolbar-sm, 36px);
                    --codlet-ui-radius: var(--radius-md, 6px);
                }
                ${MOUNT_SELECTOR} {
                    display: inline-flex;
                    align-items: center;
                    align-self: center;
                    flex: 0 0 auto;
                    height: var(--codlet-ui-menu-height);
                    pointer-events: auto;
                    -webkit-app-region: no-drag;
                }
            `;
        }
        if (!session.style.isConnected) (document.head || document.body).appendChild(session.style);
    }

    function reconcile(session) {
        if (current !== session) return;
        for (const stale of document.querySelectorAll(MOUNT_SELECTOR)) {
            if (stale !== session.mount) stale.remove();
        }
        for (const stale of document.querySelectorAll(STYLE_SELECTOR)) {
            if (stale !== session.style) stale.remove();
        }
        ensureStyle(session);
        const placement = findPlacement();
        if (!placement) {
            // Retain consumers and listeners while the host temporarily removes the toolbar.
            if (session.mount?.parentElement) session.mount.remove();
            return;
        }
        if (!session.mount) {
            session.mount = document.createElement('span');
            session.mount.setAttribute(CAPABILITY_ATTRIBUTE, CAPABILITY_TOKEN);
            session.mount.setAttribute(PROVIDER_ATTRIBUTE, PROVIDER_ID);
            session.mount.setAttribute('data-codlet-generation', String(session.generation));
        }
        if (!isPlaced(session.mount, placement)) {
            placement.parent.insertBefore(session.mount, placement.anchor ?
                placement.anchor.nextSibling : placement.parent.firstChild);
        }
    }

    function schedule(session, records) {
        if (current !== session || session.pending) return;
        if (records.every(record => record.target === session.style || session.mount?.contains(record.target))) return;
        session.pending = true;
        queueMicrotask(() => {
            session.pending = false;
            reconcile(session);
        });
    }

    function stop() {
        const session = current;
        current = null;
        if (!session) return;
        session.cancelReady?.();
        session.observer?.disconnect();
        session.mount?.remove();
        session.style?.remove();
    }

    return {
        async activate(context) {
            stop();
            const session = { generation: context.generation, pending: false };
            current = session;
            context.rpc.provide(CAPABILITY, 'getMount', () => {
                const placement = current === session ? findPlacement() : null;
                const available = isPlaced(session.mount, placement);
                return { available, token: CAPABILITY_TOKEN, placement: available ? placement.name : null };
            });
            await waitForDocument(session);
            if (current !== session) return;
            session.observer = new MutationObserver(records => schedule(session, records));
            session.observer.observe(document.documentElement, {
                childList: true,
                subtree: true,
                attributes: true,
                attributeFilter: ['id', 'role', 'data-codex-window-chrome', 'data-app-shell-header-layout', 'data-testid']
            });
            reconcile(session);
        },
        deactivate: stop
    };
})();
