module.exports = (() => {
    const HEADER_SELECTOR = 'header[data-app-shell-header-layout]';
    const SURFACE_SELECTOR = '[data-testid="app-shell-header-context-menu-surface"]';
    const CAPABILITY_TOKEN = 'codex.ui.titlebar.afterMenu@1';
    const APPEARANCE_TOKEN = 'codex.ui.appearance@1';
    const APPEARANCE = Object.freeze({ name: 'codex.ui.appearance', api: 1, scope: 'target' });
    const ROLES = Object.freeze({ button: ['default', 'primary', 'danger', 'icon', 'close', 'menu'], switch: ['default'], section: ['default'], row: ['default'], copy: ['default'], label: ['default'], description: ['default'], actions: ['default'], dialog: ['settings', 'confirmation'], dialogHeader: ['default'], dialogBody: ['default'], dialogActions: ['default'], heading: ['default'], status: ['default', 'error', 'success'] });
    const CAPABILITY_ATTRIBUTE = 'data-codlet-capability';
    const PROVIDER_ATTRIBUTE = 'data-codlet-provider';
    const PROVIDER_ID = 'codex.ui.adapter';
    const STYLE_ATTRIBUTE = 'data-codlet-ui-adapter-style';
    const MOUNT_SELECTOR = `[${CAPABILITY_ATTRIBUTE}="${CAPABILITY_TOKEN}"][${PROVIDER_ATTRIBUTE}="${PROVIDER_ID}"]`;
    const THEME_SELECTOR = `:is([data-codlet-ui-theme="${CAPABILITY_TOKEN}"], [data-codlet-ui-theme="${APPEARANCE_TOKEN}"])`;
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
                ${MOUNT_SELECTOR}, ${THEME_SELECTOR} {
                    --codlet-ui-bg: var(--color-background-application-menu, var(--color-background-elevated-primary, Canvas));
                    --codlet-ui-fg: var(--color-text, CanvasText);
                    --codlet-ui-muted: var(--color-text-tertiary, GrayText);
                    --codlet-ui-border: var(--color-border, ButtonBorder);
                    --codlet-ui-hover: var(--color-background-button-tertiary-hover, ButtonFace);
                    --codlet-ui-active: var(--color-codex-application-menu-selection, ButtonFace);
                    --codlet-ui-focus: var(--color-border-focus, Highlight);
                    --codlet-ui-font: var(--font-sans, system-ui, sans-serif);
                    --codlet-ui-font-size: var(--text-base, 14px);
                    --codlet-ui-font-weight-normal: var(--font-weight-normal, 400);
                    --codlet-ui-font-weight-medium: var(--font-weight-medium, 500);
                    --codlet-ui-menu-fg: var(--color-text-tertiary, GrayText);
                    --codlet-ui-menu-hover-fg: var(--color-codex-description, GrayText);
                    --codlet-ui-menu-hover-bg: color-mix(in oklab, var(--color-text, CanvasText) 5%, transparent);
                    --codlet-ui-menu-active-fg: var(--color-text, CanvasText);
                    --codlet-ui-cursor: var(--cursor-interaction, default);
                    --codlet-ui-motion-duration: var(--transition-duration-basic, 150ms);
                    --codlet-ui-menu-height: var(--height-toolbar-sm, 36px);
                    --codlet-ui-radius: var(--radius-md, 6px);
                    --codlet-ui-surface: var(--color-surface, Canvas);
                    --codlet-ui-surface-raised: var(--color-surface-elevated-secondary, Canvas);
                    --codlet-ui-surface-group: var(--color-background-panel, var(--color-background-primary-soft-alpha, Canvas));
                    --codlet-ui-secondary: var(--color-text-secondary, GrayText);
                    --codlet-ui-accent: var(--color-chart-blue, Highlight);
                    --codlet-ui-on-accent: var(--gray-0, HighlightText);
                    --codlet-ui-font-small: var(--text-sm, 13px);
                    --codlet-ui-font-caption: var(--text-xs, 12px);
                    --codlet-ui-font-heading: var(--text-heading-md, 20px);
                    --codlet-ui-dialog-radius: var(--radius-3xl, 20px);
                    --codlet-ui-group-radius: var(--radius-2xl, 16px);
                    --codlet-ui-dialog-shadow: var(--shadow-lg, 0px 4px 8px -2px rgb(0 0 0 / 10%));
                    --codlet-ui-backdrop: #00000022;
                    --codlet-ui-danger-bg: color-mix(in oklab, var(--color-chart-red, CanvasText) 10%, transparent);
                    --codlet-ui-danger-hover: color-mix(in oklab, var(--color-chart-red, CanvasText) 20%, transparent);
                    --codlet-ui-danger-fg: var(--color-chart-red, CanvasText);
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
                ${THEME_SELECTOR}::backdrop {
                    --codlet-ui-backdrop: #00000022;
                }
                :root[data-reduced-motion="true"] :is(${MOUNT_SELECTOR}, ${THEME_SELECTOR}) {
                    --codlet-ui-motion-duration: 0ms;
                }
                @media (prefers-reduced-motion: reduce) {
                    :root:not([data-reduced-motion]) :is(${MOUNT_SELECTOR}, ${THEME_SELECTOR}) {
                        --codlet-ui-motion-duration: 0ms;
                    }
                }
            ` + appearanceStyle();
        }
        if (!session.style.isConnected) (document.head || document.body).appendChild(session.style);
    }

    function appearanceStyle() {
        const scope = `:is([data-codlet-ui-theme="${APPEARANCE_TOKEN}"], [data-codlet-ui-theme="${APPEARANCE_TOKEN}"] *)`;
        const r = name => `${scope}[data-codlet-ui-role="${name}"]`;
        const v = (name, variant) => `${r(name)}[data-codlet-ui-variant="${variant}"]`;
        return `
            ${scope}[data-codlet-ui-owner] { box-sizing: border-box; color: var(--codlet-ui-fg, CanvasText); font-family: var(--codlet-ui-font, system-ui, sans-serif); font-size: var(--codlet-ui-font-size, 14px); letter-spacing: 0; line-height: 1.45; }
            ${scope}[data-codlet-ui-owner][hidden], ${r('dialog')}:not([open]) { display: none; }
            ${scope}:focus-visible { outline: 2px solid var(--codlet-ui-focus, Highlight); outline-offset: 2px; }
            ${r('button')} { appearance: none; -webkit-app-region: no-drag; border: 1px solid transparent; margin: 0; border-radius: 999px; min-height: 28px; padding: 4px 8px; background: transparent; color: inherit; font: inherit; cursor: var(--codlet-ui-cursor, default); }
            ${r('button')}:hover:not(:disabled) { background: var(--codlet-ui-hover, ButtonFace); }
            ${r('button')}:active:not(:disabled) { background: var(--codlet-ui-active, ButtonFace); }
            ${r('button')}:disabled, ${r('switch')}:disabled { opacity: .4; }
            ${v('button','primary')}, ${v('button','danger')} { min-height: 36px; padding: 6px 16px; font-size: var(--codlet-ui-font-small,13px); line-height:calc(var(--codlet-ui-font-small,13px) * 18 / 13); font-weight: var(--codlet-ui-font-weight-medium,500); }
            ${v('button','primary')} { background: var(--codlet-ui-accent,Highlight); color: var(--codlet-ui-on-accent,HighlightText); }
            ${v('button','primary')}:hover:not(:disabled) { background: color-mix(in oklab,var(--codlet-ui-accent,Highlight) 90%,CanvasText); }
            ${v('button','danger')} { background: var(--codlet-ui-danger-bg,Highlight); color: var(--codlet-ui-danger-fg,HighlightText); }
            ${v('button','danger')}:hover:not(:disabled) { background: var(--codlet-ui-danger-hover,Highlight); }
            ${v('button','icon')}, ${v('button','close')} { display:inline-flex; align-items:center; justify-content:center; flex:0 0 24px; width:24px; height:24px; min-height:24px; padding:0; }
            ${v('button','close')} { position:absolute; top:16px; right:16px; border-radius:4px; }
            ${v('button','menu')} { flex:0 0 auto; min-height:0; padding:4px 10px; border-radius:var(--codlet-ui-radius,4px); line-height:1; white-space:nowrap; color:var(--codlet-ui-menu-fg,GrayText); cursor:default; }
            ${v('button','menu')}:hover, ${v('button','menu')}:focus-visible { color:var(--codlet-ui-menu-hover-fg,GrayText); background:var(--codlet-ui-menu-hover-bg,ButtonFace); }
            ${v('button','menu')}[aria-expanded="true"] { color:var(--codlet-ui-menu-active-fg,CanvasText); background:var(--codlet-ui-active,ButtonFace); }
            ${r('switch')} { appearance:none; position:relative; flex:0 0 32px; width:32px; height:20px; margin:0; padding:0; border:0; border-radius:999px; background:color-mix(in oklab,var(--codlet-ui-fg,CanvasText) 10%,transparent); color:var(--codlet-ui-on-accent,HighlightText); cursor:var(--codlet-ui-cursor,default); transition:background-color var(--codlet-ui-motion-duration,150ms) ease-out; }
            ${r('switch')}::before { content:''; position:absolute; top:2px; left:2px; width:16px; height:16px; border-radius:50%; background:currentColor; transition:left var(--codlet-ui-motion-duration,150ms) ease-out; }
            ${r('switch')}:checked { background:var(--codlet-ui-accent,Highlight); }
            ${r('switch')}:checked::before { left:14px; }
            ${r('section')} { overflow:hidden; border:1px solid var(--codlet-ui-border,ButtonBorder); border-radius:var(--codlet-ui-group-radius,16px); background:var(--codlet-ui-surface-group,Canvas); }
            ${r('row')} { position:relative; display:grid; grid-template-columns:minmax(0,1fr) auto; align-items:center; gap:12px 24px; padding:12px 16px; }
            ${r('row')}:not(:last-child)::after { content:''; position:absolute; pointer-events:none; left:16px; right:16px; bottom:0; height:.5px; background:var(--codlet-ui-border,ButtonBorder); }
            ${r('copy')} { min-width:0; }
            ${r('label')} { font-size:var(--codlet-ui-font-small,13px); line-height:calc(var(--codlet-ui-font-small,13px) * 18 / 13); font-weight:var(--codlet-ui-font-weight-medium,500); }
            ${r('description')} { margin-top:2px; font-size:var(--codlet-ui-font-caption,12px); line-height:calc(var(--codlet-ui-font-caption,12px) * 4 / 3); color:var(--codlet-ui-secondary,GrayText); overflow-wrap:anywhere; }
            ${r('actions')} { display:flex; align-items:center; gap:8px; flex:0 0 auto; }
            ${r('dialog')} { position:fixed; inset:0; display:flex; flex-direction:column; width:600px; max-width:92vw; max-height:90dvh; min-height:0; margin:auto; padding:0; border:0; border-radius:var(--codlet-ui-dialog-radius,20px); background:color-mix(in srgb,var(--codlet-ui-surface-raised,Canvas) 90%,transparent); box-shadow:0 0 0 .5px var(--codlet-ui-border,ButtonBorder),var(--codlet-ui-dialog-shadow); backdrop-filter:blur(24px); overflow-wrap:anywhere; overflow:hidden; -webkit-app-region:no-drag; }
            ${v('dialog','confirmation')} { width:420px; }
            ${r('dialog')}::backdrop { background:var(--codlet-ui-backdrop,#00000022); }
            ${r('dialogHeader')} { display:flex; align-items:center; gap:16px; flex:0 0 auto; padding:20px 56px 0 20px; }
            ${r('heading')} { flex:1; min-width:0; margin:0; font-size:var(--codlet-ui-font-heading,20px); line-height:calc(var(--codlet-ui-font-heading,20px) * 1.4); font-weight:var(--codlet-ui-font-weight-medium,500); }
            ${r('dialogBody')} { min-height:0; overflow:auto; overscroll-behavior:contain; padding:12px 20px 20px; scrollbar-gutter:stable; }
            ${r('dialogActions')} { display:flex; flex-wrap:wrap; gap:12px; justify-content:end; padding-top:12px; }
            ${r('dialogActions')} > ${r('button')} { min-height:36px; padding:6px 16px; font-size:var(--codlet-ui-font-small,13px); line-height:calc(var(--codlet-ui-font-small,13px) * 18 / 13); font-weight:var(--codlet-ui-font-weight-medium,500); }
            ${r('dialogActions')} > ${v('button','default')} { background:color-mix(in oklab,var(--codlet-ui-fg,CanvasText) 5%,transparent); }
            ${r('status')} { margin:8px 0; color:var(--codlet-ui-secondary,GrayText); overflow-wrap:anywhere; }
            ${v('status','error')} { color:var(--codlet-ui-danger-fg,CanvasText); }
            @media (max-width:420px) { ${r('row')} { column-gap:12px; } ${r('actions')} { flex-wrap:wrap; justify-content:end; } }
            @media (forced-colors:active) { ${r('switch')} { appearance:auto; } ${r('switch')}::before { display:none; } }
        `;
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
            context.rpc.provide(APPEARANCE, 'describe', args => {
                if (args != null && (typeof args !== 'object' || Array.isArray(args) || Object.keys(args).length)) throw Object.assign(new Error('describe expects empty arguments'), { code: 'invalid_argument' });
                return {
                api: 1, available: current === session && session.style?.isConnected === true,
                themeToken: APPEARANCE_TOKEN, roles: Object.fromEntries(Object.entries(ROLES).map(([name, variants]) => [name, [...variants]])),
                nativeLayout: current === session ? findPlacement()?.name ?? null : null,
                nativeTokensAvailable: typeof getComputedStyle === 'function' && !!document.documentElement && getComputedStyle(document.documentElement).getPropertyValue('--color-text').trim().length > 0
                };
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
