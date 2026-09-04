module.exports = (() => {
    const CAPABILITY_TOKEN = 'codex.ui.titlebar.afterMenu@1';
    const MOUNT_ATTRIBUTE = 'data-codlet-capability';
    const STYLE_ATTRIBUTE = 'data-codlet-style';
    const BUTTON_ATTRIBUTE = 'data-codlet-titlebar-button';
    const PANEL_ATTRIBUTE = 'data-codlet-panel';
    const MOUNT_CAPABILITY = Object.freeze({
        name: 'codex.ui.titlebar.afterMenu',
        api: 1,
        scope: 'target'
    });
    const RUNTIME_PING_CAPABILITY = Object.freeze({
        name: 'codlet.runtime.ping',
        api: 1,
        scope: 'target'
    });

    let style = null;
    let button = null;
    let panel = null;
    let observer = null;
    let keydown = null;
    let resize = null;
    let mountToken = null;
    let stopped = false;

    function waitForDocument() {
        if (document.documentElement && document.body) return Promise.resolve();
        return new Promise((resolve) => {
            document.addEventListener('DOMContentLoaded', resolve, { once: true });
        });
    }

    function addText(parent, tag, className, text) {
        const element = document.createElement(tag);
        element.className = className;
        element.textContent = text;
        parent.appendChild(element);
        return element;
    }

    function validMountToken(value) {
        return value === CAPABILITY_TOKEN && /^[A-Za-z0-9._:@-]+$/.test(value);
    }

    function findMount() {
        if (!mountToken) return null;
        return Array.from(document.querySelectorAll(`[${MOUNT_ATTRIBUTE}]`))
            .find((element) => element.getAttribute(MOUNT_ATTRIBUTE) === mountToken) ?? null;
    }

    function installStyle() {
        style = document.createElement('style');
        style.setAttribute(STYLE_ATTRIBUTE, 'codlet');
        style.textContent = `
            [${BUTTON_ATTRIBUTE}] {
                pointer-events: auto;
                flex: 0 0 auto;
                height: 28px;
                min-width: 28px;
                padding: 0 9px;
                border: 1px solid color-mix(in srgb, currentColor 18%, transparent);
                border-radius: 6px;
                background: color-mix(in srgb, Canvas 92%, CanvasText 8%);
                color: CanvasText;
                font: 600 12px/1 system-ui, sans-serif;
                letter-spacing: 0;
                cursor: pointer;
            }
            [${BUTTON_ATTRIBUTE}]:hover {
                background: color-mix(in srgb, Canvas 84%, CanvasText 16%);
            }
            [${BUTTON_ATTRIBUTE}]:focus-visible,
            [${PANEL_ATTRIBUTE}] button:focus-visible {
                outline: 2px solid #10a37f;
                outline-offset: 2px;
            }
            [${PANEL_ATTRIBUTE}] {
                position: fixed;
                right: 0;
                z-index: 2147483600;
                width: min(360px, calc(100vw - 24px));
                border-left: 1px solid color-mix(in srgb, CanvasText 16%, transparent);
                background: Canvas;
                color: CanvasText;
                box-shadow: -12px 0 30px rgb(0 0 0 / 14%);
                font: 13px/1.45 system-ui, sans-serif;
                letter-spacing: 0;
            }
            [${PANEL_ATTRIBUTE}][hidden] { display: none; }
            .codlet-panel-header {
                display: flex;
                align-items: center;
                justify-content: space-between;
                min-height: 48px;
                padding: 0 14px;
                border-bottom: 1px solid color-mix(in srgb, CanvasText 12%, transparent);
            }
            .codlet-panel-title { font-size: 14px; font-weight: 650; }
            .codlet-close {
                width: 30px;
                height: 30px;
                border: 0;
                border-radius: 6px;
                background: transparent;
                color: inherit;
                font: 18px/1 system-ui, sans-serif;
                cursor: pointer;
            }
            .codlet-close:hover { background: color-mix(in srgb, Canvas 86%, CanvasText 14%); }
            .codlet-panel-body { padding: 14px; }
            .codlet-runtime-state {
                display: flex;
                align-items: center;
                gap: 8px;
                padding-bottom: 16px;
                color: color-mix(in srgb, CanvasText 72%, transparent);
            }
            .codlet-status-dot {
                width: 8px;
                height: 8px;
                flex: 0 0 auto;
                border-radius: 50%;
                background: #10a37f;
            }
            .codlet-section-title {
                margin: 0 0 8px;
                color: color-mix(in srgb, CanvasText 62%, transparent);
                font-size: 11px;
                font-weight: 700;
                text-transform: uppercase;
            }
            .codlet-plugin-row {
                display: grid;
                grid-template-columns: minmax(0, 1fr) auto;
                align-items: center;
                gap: 12px;
                min-height: 44px;
                border-top: 1px solid color-mix(in srgb, CanvasText 10%, transparent);
            }
            .codlet-plugin-name { overflow: hidden; font-weight: 600; text-overflow: ellipsis; }
            .codlet-plugin-state { color: #087f5b; font-size: 12px; }
        `;
        document.documentElement.appendChild(style);
    }

    function createPanel() {
        panel = document.createElement('aside');
        panel.setAttribute(PANEL_ATTRIBUTE, 'codlet');
        panel.setAttribute('role', 'dialog');
        panel.setAttribute('aria-label', 'Codlet');
        panel.hidden = true;

        const header = document.createElement('div');
        header.className = 'codlet-panel-header';
        addText(header, 'div', 'codlet-panel-title', 'Codlet');
        const close = document.createElement('button');
        close.className = 'codlet-close';
        close.type = 'button';
        close.title = 'Close';
        close.setAttribute('aria-label', 'Close Codlet');
        close.textContent = 'X';
        close.addEventListener('click', () => setPanelOpen(false));
        header.appendChild(close);
        panel.appendChild(header);

        const body = document.createElement('div');
        body.className = 'codlet-panel-body';
        const runtime = document.createElement('div');
        runtime.className = 'codlet-runtime-state';
        const dot = document.createElement('span');
        dot.className = 'codlet-status-dot';
        runtime.appendChild(dot);
        addText(runtime, 'span', '', 'Runtime connected');
        body.appendChild(runtime);
        addText(body, 'h2', 'codlet-section-title', 'Codlets');
        const row = document.createElement('div');
        row.className = 'codlet-plugin-row';
        addText(row, 'div', 'codlet-plugin-name', 'Codlet');
        addText(row, 'div', 'codlet-plugin-state', 'Active');
        body.appendChild(row);
        panel.appendChild(body);
        document.body.appendChild(panel);
    }

    function layoutPanel() {
        if (!panel) return;
        const mount = findMount();
        const anchor = mount?.parentElement ?? mount;
        const top = anchor ? Math.max(0, Math.round(anchor.getBoundingClientRect().bottom)) : 40;
        panel.style.top = `${top}px`;
        panel.style.height = `calc(100vh - ${top}px)`;
    }

    function setPanelOpen(open) {
        if (!panel) return;
        panel.hidden = !open;
        button?.setAttribute('aria-expanded', String(open));
        if (open) layoutPanel();
    }

    function mountButton() {
        const mount = findMount();
        if (!mount) return false;
        if (!button) {
            button = document.createElement('button');
            button.type = 'button';
            button.title = 'Codlet';
            button.textContent = 'Codlet';
            button.setAttribute(BUTTON_ATTRIBUTE, 'codlet');
            button.setAttribute('aria-label', 'Open Codlet');
            button.setAttribute('aria-expanded', 'false');
            button.addEventListener('click', () => setPanelOpen(panel?.hidden !== false));
        }
        if (!button.isConnected) mount.appendChild(button);
        layoutPanel();
        return true;
    }

    async function start(context) {
        await waitForDocument();
        if (stopped) return;
        try {
            const runtime = await context.rpc.request(RUNTIME_PING_CAPABILITY, 'ping', null);
            if (stopped || runtime?.pong !== true || runtime?.abi !== 1) return;
        } catch (_) {
            return;
        }
        let capability;
        try {
            capability = await context.rpc.request(MOUNT_CAPABILITY, 'getMount', null);
        } catch (_) {
            return;
        }
        if (stopped || capability?.available !== true || !validMountToken(capability.token)) return;
        mountToken = capability.token;
        installStyle();
        createPanel();
        mountButton();
        observer = new MutationObserver(() => {
            if (!button?.isConnected) mountButton();
        });
        observer.observe(document.documentElement, { childList: true, subtree: true });
        keydown = (event) => {
            if (event.key === 'Escape' && panel?.hidden === false) setPanelOpen(false);
        };
        resize = () => layoutPanel();
        document.addEventListener('keydown', keydown);
        globalThis.addEventListener('resize', resize);
        panel.setAttribute('data-codlet-generation', String(context.generation));
    }

    return {
        activate(context) {
            stopped = false;
            void start(context);
        },
        deactivate() {
            stopped = true;
            observer?.disconnect();
            document.removeEventListener('keydown', keydown);
            globalThis.removeEventListener('resize', resize);
            button?.remove();
            panel?.remove();
            style?.remove();
            observer = null;
            keydown = null;
            resize = null;
            button = null;
            panel = null;
            style = null;
            mountToken = null;
        }
    };
})();
