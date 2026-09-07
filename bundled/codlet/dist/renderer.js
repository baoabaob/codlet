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
    const RUNTIME_MANAGE_CAPABILITY = Object.freeze({
        name: 'codlet.runtime.manage',
        api: 1,
        scope: 'target'
    });

    let style = null;
    let button = null;
    let panel = null;
    let pluginList = null;
    let managementStatus = null;
    let panelRequest = 0;
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
            .codlet-plugin-copy { min-width: 0; }
            .codlet-plugin-version {
                margin-top: 2px;
                overflow-wrap: anywhere;
                color: color-mix(in srgb, CanvasText 54%, transparent);
                font-size: 11px;
            }
            .codlet-toggle {
                width: 32px;
                height: 18px;
                margin: 0;
                accent-color: #10a37f;
                cursor: pointer;
            }
            .codlet-toggle:disabled { cursor: default; opacity: 0.55; }
        `;
        document.documentElement.appendChild(style);
    }

    function createPluginRow(context, plugin) {
        const row = document.createElement('div');
        row.className = 'codlet-plugin-row';
        const copy = document.createElement('div');
        copy.className = 'codlet-plugin-copy';
        addText(copy, 'div', 'codlet-plugin-name', plugin.id === 'codlet' ? 'Codlet' : plugin.id);
        const metadata = [plugin.version, plugin.source === 'local' ? 'Local' : null]
            .filter(value => typeof value === 'string' && value.length > 0);
        if (metadata.length) addText(copy, 'div', 'codlet-plugin-version', metadata.join(' / '));
        if (typeof plugin.path === 'string') copy.title = plugin.path;
        if (plugin.validation?.status === 'failed') {
            const message = plugin.validation.error?.message;
            addText(copy, 'div', 'codlet-plugin-version', typeof message === 'string' ? message : 'Plugin validation failed');
        }
        row.appendChild(copy);

        if (plugin.id === context.pluginId && plugin.active === true) {
            const toggle = document.createElement('input');
            toggle.className = 'codlet-toggle';
            toggle.type = 'checkbox';
            toggle.checked = plugin.enabled === true;
            toggle.setAttribute('role', 'switch');
            toggle.setAttribute('aria-label', 'Enable Codlet GUI');
            toggle.addEventListener('change', async () => {
                if (toggle.checked) return;
                const confirmed = globalThis.confirm(
                    'Disable the Codlet GUI? Re-enable it with `codlet plugin enable codlet`.'
                );
                if (!confirmed) {
                    toggle.checked = true;
                    return;
                }
                toggle.disabled = true;
                try {
                    await context.rpc.request(RUNTIME_MANAGE_CAPABILITY, 'disableSelf', null);
                } catch (error) {
                    if (stopped || !row.isConnected) return;
                    toggle.checked = true;
                    toggle.disabled = false;
                    toggle.title = error instanceof Error ? error.message : String(error);
                }
            });
            row.appendChild(toggle);
        } else {
            const state = plugin.active === true ? 'Active'
                : plugin.validation?.status === 'failed' ? 'Unavailable'
                : plugin.enabled === true ? 'Not active' : 'Disabled';
            addText(row, 'div', 'codlet-plugin-state', state);
        }
        return row;
    }

    function createPanel(context, plugins) {
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
        managementStatus = document.createElement('div');
        managementStatus.className = 'codlet-plugin-version';
        managementStatus.hidden = true;
        managementStatus.setAttribute('role', 'status');
        body.appendChild(managementStatus);
        pluginList = document.createElement('div');
        for (const plugin of plugins) pluginList.appendChild(createPluginRow(context, plugin));
        body.appendChild(pluginList);
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
        if (!open) panelRequest += 1;
        panel.hidden = !open;
        button?.setAttribute('aria-expanded', String(open));
        if (open) layoutPanel();
    }

    function mountButton(context) {
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
            button.addEventListener('click', async () => {
                if (panel?.hidden === false) {
                    setPanelOpen(false);
                    return;
                }
                const currentPanel = panel;
                const request = ++panelRequest;
                setPanelOpen(true);
                pluginList.hidden = true;
                managementStatus.hidden = false;
                managementStatus.textContent = 'Loading plugins...';
                try {
                    const management = await context.rpc.request(RUNTIME_MANAGE_CAPABILITY, 'list', null);
                    if (stopped || panel !== currentPanel || request !== panelRequest) return;
                    if (!Array.isArray(management?.plugins)) throw new Error('Plugin list unavailable');
                    pluginList.replaceChildren(...management.plugins.map(plugin => createPluginRow(context, plugin)));
                    pluginList.hidden = false;
                    managementStatus.hidden = true;
                } catch (error) {
                    if (stopped || panel !== currentPanel || request !== panelRequest) return;
                    managementStatus.textContent = error instanceof Error ? error.message : 'Plugin list unavailable';
                }
            });
        }
        if (!button.isConnected) mount.appendChild(button);
        layoutPanel();
        return true;
    }

    async function start(context) {
        await waitForDocument();
        if (stopped) return;
        let runtime;
        try {
            runtime = await context.rpc.request(RUNTIME_PING_CAPABILITY, 'ping', null);
        } catch (_) {
            return;
        }
        if (stopped || runtime?.pong !== true || runtime?.abi !== 1) return;
        let management;
        try {
            management = await context.rpc.request(RUNTIME_MANAGE_CAPABILITY, 'list', null);
        } catch (_) {
            return;
        }
        if (!Array.isArray(management?.plugins)) return;
        let capability;
        try {
            capability = await context.rpc.request(MOUNT_CAPABILITY, 'getMount', null);
        } catch (_) {
            return;
        }
        if (stopped || capability?.available !== true || !validMountToken(capability.token)) return;
        mountToken = capability.token;
        installStyle();
        createPanel(context, management.plugins);
        mountButton(context);
        observer = new MutationObserver(() => {
            if (!button?.isConnected) mountButton(context);
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
            return start(context);
        },
        deactivate() {
            stopped = true;
            panelRequest += 1;
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
            pluginList = null;
            managementStatus = null;
            style = null;
            mountToken = null;
        }
    };
})();
