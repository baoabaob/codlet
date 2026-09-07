module.exports = (() => {
    const CAPABILITY_TOKEN = 'codex.ui.titlebar.afterMenu@1';
    const MOUNT_ATTRIBUTE = 'data-codlet-capability';
    const STYLE_ATTRIBUTE = 'data-codlet-style';
    const BUTTON_ATTRIBUTE = 'data-codlet-titlebar-button';
    const PANEL_ATTRIBUTE = 'data-codlet-panel';
    const MOUNT_CAPABILITY = Object.freeze({ name: 'codex.ui.titlebar.afterMenu', api: 1, scope: 'target' });
    const RUNTIME_PING_CAPABILITY = Object.freeze({ name: 'codlet.runtime.ping', api: 1, scope: 'target' });
    const RUNTIME_MANAGE_CAPABILITY = Object.freeze({ name: 'codlet.runtime.manage', api: 1, scope: 'target' });

    /* Lucide x and refresh-cw: https://github.com/lucide-icons/lucide/tree/main/icons
     * ISC License
     * Copyright (c) 2026 Lucide Icons and Contributors
     * Permission to use, copy, modify, and/or distribute this software for any
     * purpose with or without fee is hereby granted, provided that the above
     * copyright notice and this permission notice appear in all copies.
     * THE SOFTWARE IS PROVIDED "AS IS" AND THE AUTHOR DISCLAIMS ALL WARRANTIES
     * WITH REGARD TO THIS SOFTWARE INCLUDING ALL IMPLIED WARRANTIES OF
     * MERCHANTABILITY AND FITNESS. IN NO EVENT SHALL THE AUTHOR BE LIABLE FOR
     * ANY SPECIAL, DIRECT, INDIRECT, OR CONSEQUENTIAL DAMAGES OR ANY DAMAGES
     * WHATSOEVER RESULTING FROM LOSS OF USE, DATA OR PROFITS, WHETHER IN AN
     * ACTION OF CONTRACT, NEGLIGENCE OR OTHER TORTIOUS ACTION, ARISING OUT OF
     * OR IN CONNECTION WITH THE USE OR PERFORMANCE OF THIS SOFTWARE.
     *
     * The x icon is derived from Feather, under The MIT License (MIT).
     * Copyright (c) 2013-present Cole Bemis
     * Permission is hereby granted, free of charge, to any person obtaining a copy
     * of this software and associated documentation files (the "Software"), to deal
     * in the Software without restriction, including without limitation the rights
     * to use, copy, modify, merge, publish, distribute, sublicense, and/or sell
     * copies of the Software, and to permit persons to whom the Software is
     * furnished to do so, subject to the following conditions:
     * The above copyright notice and this permission notice shall be included in all
     * copies or substantial portions of the Software.
     * THE SOFTWARE IS PROVIDED "AS IS", WITHOUT WARRANTY OF ANY KIND, EXPRESS OR
     * IMPLIED, INCLUDING BUT NOT LIMITED TO THE WARRANTIES OF MERCHANTABILITY,
     * FITNESS FOR A PARTICULAR PURPOSE AND NONINFRINGEMENT. IN NO EVENT SHALL THE
     * AUTHORS OR COPYRIGHT HOLDERS BE LIABLE FOR ANY CLAIM, DAMAGES OR OTHER
     * LIABILITY, WHETHER IN AN ACTION OF CONTRACT, TORT OR OTHERWISE, ARISING FROM,
     * OUT OF OR IN CONNECTION WITH THE SOFTWARE OR THE USE OR OTHER DEALINGS IN THE
     * SOFTWARE.
     */
    const ICONS = {
        close: ['M18 6 6 18', 'm6 6 12 12'],
        refresh: ['M3 12a9 9 0 0 1 9-9 9.75 9.75 0 0 1 6.74 2.74L21 8', 'M21 3v5h-5',
            'M21 12a9 9 0 0 1-9 9 9.75 9.75 0 0 1-6.74-2.74L3 16', 'M8 16H3v5']
    };

    let style, button, panel, pluginList, managementStatus, refreshButton, closeButton;
    let confirmation, confirmationStatus, confirmButton, cancelButton, actionOrigin;
    let observer, keydown, focusin, resize, cancelDocumentWait;
    let mountToken = null;
    let returnFocus = null;
    let outsideFocus = null;
    let panelAnchor = null;
    let lifecycle = 0;
    let panelRequest = 0;
    let action = 'idle';
    let actionError = '';

    function waitForDocument() {
        if (document.documentElement && document.body) return Promise.resolve();
        return new Promise(resolve => {
            const finish = () => {
                document.removeEventListener('DOMContentLoaded', finish);
                cancelDocumentWait = null;
                resolve();
            };
            cancelDocumentWait = finish;
            document.addEventListener('DOMContentLoaded', finish, { once: true });
        });
    }

    function addText(parent, tag, className, text) {
        const element = document.createElement(tag);
        element.className = className;
        element.textContent = text;
        parent.appendChild(element);
        return element;
    }

    function iconButton(parent, name, label) {
        const control = addText(parent, 'button', 'codlet-icon-button', '');
        control.type = 'button';
        control.title = label;
        control.setAttribute('aria-label', label);
        const icon = document.createElementNS('http://www.w3.org/2000/svg', 'svg');
        for (const [key, value] of Object.entries({
            width: '16', height: '16', viewBox: '0 0 24 24', fill: 'none', stroke: 'currentColor',
            'stroke-width': '2', 'stroke-linecap': 'round', 'stroke-linejoin': 'round',
            'aria-hidden': 'true', focusable: 'false'
        })) icon.setAttribute(key, value);
        for (const d of ICONS[name]) {
            const path = document.createElementNS('http://www.w3.org/2000/svg', 'path');
            path.setAttribute('d', d);
            icon.appendChild(path);
        }
        control.appendChild(icon);
        return control;
    }

    function findMount() {
        if (!mountToken) return null;
        return Array.from(document.querySelectorAll(`[${MOUNT_ATTRIBUTE}]`))
            .find(element => element.getAttribute(MOUNT_ATTRIBUTE) === mountToken) ?? null;
    }

    function installStyle() {
        style = document.createElement('style');
        style.setAttribute(STYLE_ATTRIBUTE, 'codlet');
        style.textContent = `
            [${BUTTON_ATTRIBUTE}], [${PANEL_ATTRIBUTE}] {
                color: var(--codlet-ui-fg, CanvasText);
                font-family: var(--codlet-ui-font, system-ui, sans-serif);
                font-size: var(--codlet-ui-font-size, 13px);
                letter-spacing: 0;
                line-height: 1.45;
            }
            [${BUTTON_ATTRIBUTE}] {
                appearance: none;
                -webkit-app-region: no-drag;
                pointer-events: auto;
                flex: 0 0 auto;
                box-sizing: border-box;
                height: calc(var(--codlet-ui-menu-height, 36px) - 12px);
                padding: 0 8px;
                border: 0;
                border-radius: var(--codlet-ui-radius, 4px);
                background: transparent;
                font-weight: 400;
                line-height: 1;
                white-space: nowrap;
                cursor: default;
            }
            [${BUTTON_ATTRIBUTE}]:hover, [${PANEL_ATTRIBUTE}] button:hover:not(:disabled) {
                background: var(--codlet-ui-hover, color-mix(in srgb, CanvasText 8%, Canvas));
            }
            [${BUTTON_ATTRIBUTE}][aria-expanded="true"], [${PANEL_ATTRIBUTE}] button:active:not(:disabled) {
                background: var(--codlet-ui-active, color-mix(in srgb, CanvasText 12%, Canvas));
            }
            [${BUTTON_ATTRIBUTE}]:focus-visible, [${PANEL_ATTRIBUTE}] :focus-visible {
                outline: 2px solid var(--codlet-ui-focus, Highlight);
                outline-offset: 2px;
            }
            [${PANEL_ATTRIBUTE}] {
                position: fixed;
                right: 0;
                bottom: 0;
                z-index: 2147483600;
                display: flex;
                flex-direction: column;
                width: min(360px, 100vw);
                max-width: 100%;
                min-height: 0;
                box-sizing: border-box;
                border: 0;
                border-left: 1px solid var(--codlet-ui-border, color-mix(in srgb, CanvasText 14%, transparent));
                background: var(--codlet-ui-bg, Canvas);
                overflow-wrap: anywhere;
                -webkit-app-region: no-drag;
            }
            [${PANEL_ATTRIBUTE}] *, [${PANEL_ATTRIBUTE}] *::before { box-sizing: border-box; }
            [${PANEL_ATTRIBUTE}][hidden], [${PANEL_ATTRIBUTE}] [hidden] { display: none; }
            [${PANEL_ATTRIBUTE}] button {
                appearance: none;
                margin: 0;
                border: 0;
                border-radius: var(--codlet-ui-radius, 4px);
                background: transparent;
                color: inherit;
                font: inherit;
                letter-spacing: 0;
                cursor: default;
            }
            [${PANEL_ATTRIBUTE}] button:disabled { opacity: 0.5; }
            [${PANEL_ATTRIBUTE}] .codlet-panel-header {
                display: flex;
                align-items: center;
                gap: 4px;
                flex: 0 0 auto;
                min-height: 48px;
                padding: 8px 12px 8px 16px;
                border-bottom: 1px solid var(--codlet-ui-border, color-mix(in srgb, CanvasText 14%, transparent));
            }
            [${PANEL_ATTRIBUTE}] .codlet-panel-title {
                flex: 1;
                min-width: 0;
                margin: 0;
                font-size: inherit;
                font-weight: 600;
            }
            [${PANEL_ATTRIBUTE}] .codlet-icon-button {
                display: inline-flex;
                align-items: center;
                justify-content: center;
                flex: 0 0 28px;
                width: 28px;
                height: 28px;
                padding: 0;
            }
            [${PANEL_ATTRIBUTE}] .codlet-panel-body {
                min-height: 0;
                overflow: auto;
                overscroll-behavior: contain;
                padding: 16px;
            }
            [${PANEL_ATTRIBUTE}] .codlet-section-title {
                margin: 0 0 8px;
                font-size: inherit;
                font-weight: 600;
            }
            [${PANEL_ATTRIBUTE}] .codlet-status,
            [${PANEL_ATTRIBUTE}] .codlet-plugin-version,
            [${PANEL_ATTRIBUTE}] .codlet-plugin-state,
            [${PANEL_ATTRIBUTE}] .codlet-confirmation-copy {
                color: var(--codlet-ui-muted, color-mix(in srgb, CanvasText 65%, transparent));
            }
            [${PANEL_ATTRIBUTE}] .codlet-status { margin: 8px 0; }
            [${PANEL_ATTRIBUTE}] .codlet-plugin-row {
                display: grid;
                grid-template-columns: minmax(0, 1fr) auto;
                align-items: center;
                column-gap: 16px;
                min-height: 60px;
                padding: 10px 0;
                border-bottom: 1px solid var(--codlet-ui-border, color-mix(in srgb, CanvasText 14%, transparent));
            }
            [${PANEL_ATTRIBUTE}] .codlet-plugin-copy { min-width: 0; }
            [${PANEL_ATTRIBUTE}] .codlet-plugin-name { font-weight: 500; }
            [${PANEL_ATTRIBUTE}] .codlet-plugin-version { margin-top: 3px; font-size: 12px; }
            [${PANEL_ATTRIBUTE}] .codlet-plugin-state { max-width: 76px; font-size: 12px; text-align: right; }
            [${PANEL_ATTRIBUTE}] .codlet-toggle {
                appearance: none;
                position: relative;
                width: 28px;
                height: 16px;
                padding: 0;
                margin: 0;
                border: 1px solid var(--codlet-ui-muted, GrayText);
                border-radius: 8px;
                background: var(--codlet-ui-bg, Canvas);
                color: var(--codlet-ui-fg, CanvasText);
            }
            [${PANEL_ATTRIBUTE}] .codlet-toggle::before {
                content: '';
                position: absolute;
                top: 2px;
                left: 2px;
                width: 10px;
                height: 10px;
                border-radius: 50%;
                background: currentColor;
            }
            [${PANEL_ATTRIBUTE}] .codlet-toggle:checked {
                border-color: var(--codlet-ui-fg, CanvasText);
                background: var(--codlet-ui-fg, CanvasText);
                color: var(--codlet-ui-bg, Canvas);
            }
            [${PANEL_ATTRIBUTE}] .codlet-toggle:checked::before { left: 14px; }
            [${PANEL_ATTRIBUTE}] .codlet-toggle:disabled { opacity: 0.5; }
            [${PANEL_ATTRIBUTE}] .codlet-confirmation { padding-top: 16px; }
            [${PANEL_ATTRIBUTE}] .codlet-confirmation-copy { margin: 8px 0 12px; }
            [${PANEL_ATTRIBUTE}] .codlet-confirmation-actions { display: flex; flex-wrap: wrap; gap: 8px; justify-content: end; }
            [${PANEL_ATTRIBUTE}] .codlet-confirmation-actions button { min-height: 30px; padding: 5px 10px; }
            [${PANEL_ATTRIBUTE}] .codlet-confirmation-actions .codlet-confirm {
                background: var(--codlet-ui-active, color-mix(in srgb, CanvasText 12%, Canvas));
            }
            @media (forced-colors: active) {
                [${PANEL_ATTRIBUTE}] .codlet-toggle { appearance: auto; }
                [${PANEL_ATTRIBUTE}] .codlet-toggle::before { display: none; }
            }
        `;
        document.documentElement.appendChild(style);
    }

    function isOwned(element) {
        return !!element && (element === button || panel?.contains(element) === true);
    }

    function focus(element) {
        if (element?.isConnected && !element.disabled) element.focus({ preventScroll: true });
    }

    function renderAction() {
        confirmation.hidden = action === 'idle';
        refreshButton.disabled = action !== 'idle';
        confirmButton.disabled = action === 'pending' || action === 'done';
        cancelButton.disabled = confirmButton.disabled;
        confirmButton.textContent = action === 'pending' ? 'Disabling...' : 'Disable';
        confirmationStatus.hidden = action !== 'failed' && action !== 'done';
        confirmationStatus.textContent = action === 'failed' ? actionError : action === 'done' ? 'Codlet is disabled.' : '';
        if (actionOrigin?.isConnected) {
            actionOrigin.checked = true;
            actionOrigin.disabled = action !== 'idle';
        }
    }

    function cancelAction() {
        if (action !== 'confirm' && action !== 'failed') return;
        action = 'idle';
        renderAction();
        focus(actionOrigin?.isConnected ? actionOrigin : refreshButton);
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
        if (plugin.id === context.pluginId && plugin.active === true && plugin.enabled === true) {
            const toggle = document.createElement('input');
            toggle.className = 'codlet-toggle';
            toggle.type = 'checkbox';
            toggle.checked = true;
            toggle.setAttribute('role', 'switch');
            toggle.setAttribute('aria-label', 'Enable Codlet GUI');
            toggle.addEventListener('change', () => {
                if (toggle.checked || action !== 'idle' || !row.isConnected || panel.hidden) return;
                actionOrigin = toggle;
                action = 'confirm';
                renderAction();
                cancelButton.focus();
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

    async function disableSelf(context) {
        if (action !== 'confirm' && action !== 'failed') return;
        const epoch = lifecycle;
        const moveFocus = confirmation.contains(document.activeElement);
        action = 'pending';
        renderAction();
        if (moveFocus) focus(closeButton);
        try {
            const result = await context.rpc.request(RUNTIME_MANAGE_CAPABILITY, 'disableSelf', null);
            if (epoch !== lifecycle) return;
            if (result?.enabled !== false || result?.pluginId !== context.pluginId) throw new Error('Disable was not confirmed');
            action = 'done';
        } catch (error) {
            if (epoch !== lifecycle) return;
            action = 'failed';
            actionError = error instanceof Error ? error.message : String(error);
        }
        if (!panel.hidden) renderAction();
    }

    async function refreshPlugins(context) {
        if (!panel || panel.hidden || action !== 'idle') return;
        const currentPanel = panel;
        const epoch = lifecycle;
        const request = ++panelRequest;
        if (pluginList.contains(document.activeElement)) focus(refreshButton);
        pluginList.hidden = true;
        pluginList.setAttribute('aria-busy', 'true');
        managementStatus.hidden = false;
        managementStatus.textContent = 'Loading plugins...';
        try {
            const management = await context.rpc.request(RUNTIME_MANAGE_CAPABILITY, 'list', null);
            if (epoch !== lifecycle || panel !== currentPanel || request !== panelRequest) return;
            if (!Array.isArray(management?.plugins) || management.plugins.some(plugin =>
                !plugin || typeof plugin.id !== 'string' || !plugin.id.length)) throw new Error('Plugin list unavailable');
            pluginList.replaceChildren(...management.plugins.map(plugin => createPluginRow(context, plugin)));
            pluginList.hidden = false;
            managementStatus.hidden = management.plugins.length > 0;
            managementStatus.textContent = management.plugins.length ? '' : 'No plugins';
        } catch (error) {
            if (epoch !== lifecycle || panel !== currentPanel || request !== panelRequest) return;
            managementStatus.textContent = error instanceof Error ? error.message : 'Plugin list unavailable';
        }
        if (epoch === lifecycle && panel === currentPanel && request === panelRequest) {
            pluginList.setAttribute('aria-busy', 'false');
        }
    }

    function createPanel(context) {
        panel = document.createElement('aside');
        panel.id = `codlet-panel-${context.generation}`;
        panel.setAttribute(PANEL_ATTRIBUTE, 'codlet');
        panel.setAttribute('data-codlet-ui-theme', CAPABILITY_TOKEN);
        panel.setAttribute('data-codlet-generation', String(context.generation));
        panel.setAttribute('role', 'dialog');
        panel.setAttribute('aria-modal', 'false');
        panel.setAttribute('aria-label', 'Codlet');
        panel.hidden = true;
        const header = addText(panel, 'div', 'codlet-panel-header', '');
        addText(header, 'h1', 'codlet-panel-title', 'Codlet');
        refreshButton = iconButton(header, 'refresh', 'Refresh plugins');
        refreshButton.addEventListener('click', () => refreshPlugins(context));
        closeButton = iconButton(header, 'close', 'Close Codlet');
        closeButton.addEventListener('click', () => setPanelOpen(false));
        const body = addText(panel, 'div', 'codlet-panel-body', '');
        addText(body, 'h2', 'codlet-section-title', 'Codlets');
        managementStatus = addText(body, 'div', 'codlet-status', '');
        managementStatus.setAttribute('role', 'status');
        managementStatus.setAttribute('aria-live', 'polite');
        pluginList = addText(body, 'div', 'codlet-plugin-list', '');
        confirmation = addText(body, 'div', 'codlet-confirmation', '');
        confirmation.hidden = true;
        confirmation.setAttribute('role', 'group');
        confirmation.setAttribute('aria-label', 'Disable Codlet?');
        addText(confirmation, 'h3', 'codlet-section-title', 'Disable Codlet?');
        const consequence = addText(confirmation, 'p', 'codlet-confirmation-copy',
            'This removes the Codlet GUI from all open windows. To restore it, run codlet plugin enable codlet, then start Codlet again.');
        consequence.id = `${panel.id}-disable-consequence`;
        confirmation.setAttribute('aria-describedby', consequence.id);
        confirmationStatus = addText(confirmation, 'div', 'codlet-status', '');
        confirmationStatus.setAttribute('role', 'status');
        confirmationStatus.hidden = true;
        const actions = addText(confirmation, 'div', 'codlet-confirmation-actions', '');
        cancelButton = addText(actions, 'button', '', 'Cancel');
        cancelButton.type = 'button';
        cancelButton.addEventListener('click', cancelAction);
        confirmButton = addText(actions, 'button', 'codlet-confirm', 'Disable');
        confirmButton.type = 'button';
        confirmButton.addEventListener('click', () => disableSelf(context));
        document.body.appendChild(panel);
    }

    function layoutPanel() {
        if (!panel) return;
        const mount = findMount();
        const anchor = mount?.parentElement ?? mount;
        panelAnchor = anchor;
        const top = Math.min(globalThis.innerHeight, Math.max(0, Math.round(anchor?.getBoundingClientRect().bottom ?? 40)));
        panel.style.top = `${top}px`;
    }

    function setPanelOpen(open) {
        if (!panel || panel.hidden === !open) return;
        if (open) {
            returnFocus = document.activeElement;
            panel.hidden = false;
            button?.setAttribute('aria-expanded', 'true');
            renderAction();
            layoutPanel();
            focus(closeButton);
        } else {
            panelRequest += 1;
            const restore = panel.contains(document.activeElement);
            if (action === 'confirm' || action === 'failed') {
                action = 'idle';
                renderAction();
            }
            panel.hidden = true;
            button?.setAttribute('aria-expanded', 'false');
            if (restore) focus(returnFocus?.isConnected ? returnFocus : button?.isConnected ? button : outsideFocus);
            returnFocus = null;
        }
    }

    function mountButton(context) {
        const mount = findMount();
        if (!mount) {
            setPanelOpen(false);
            return;
        }
        if (!button) {
            button = document.createElement('button');
            button.type = 'button';
            button.textContent = 'Codlet';
            button.setAttribute(BUTTON_ATTRIBUTE, 'codlet');
            button.setAttribute('aria-label', 'Codlet');
            button.setAttribute('aria-haspopup', 'dialog');
            button.setAttribute('aria-controls', panel.id);
            button.setAttribute('aria-expanded', 'false');
            button.addEventListener('keydown', keydown);
            button.addEventListener('click', () => {
                if (panel.hidden === false) return setPanelOpen(false);
                setPanelOpen(true);
                return refreshPlugins(context);
            });
        }
        if (button.parentElement !== mount) mount.appendChild(button);
        layoutPanel();
    }

    async function start(context, epoch) {
        await waitForDocument();
        if (epoch !== lifecycle) return;
        let runtime, capability;
        try {
            runtime = await context.rpc.request(RUNTIME_PING_CAPABILITY, 'ping', null);
            if (epoch !== lifecycle || runtime?.pong !== true || runtime?.abi !== 1) return;
            capability = await context.rpc.request(MOUNT_CAPABILITY, 'getMount', null);
        } catch (_) {
            return;
        }
        if (epoch !== lifecycle || typeof capability?.available !== 'boolean' || capability.token !== CAPABILITY_TOKEN) return;
        mountToken = capability.token;
        outsideFocus = document.activeElement;
        keydown = event => {
            if (event.key !== 'Escape' || event.defaultPrevented || event.isComposing || event.altKey ||
                event.ctrlKey || event.metaKey || event.shiftKey || panel.hidden || !isOwned(event.target)) return;
            event.preventDefault();
            event.stopPropagation();
            if (action === 'confirm' || action === 'failed') cancelAction();
            else setPanelOpen(false);
        };
        installStyle();
        createPanel(context);
        panel.addEventListener('keydown', keydown);
        mountButton(context);
        observer = new MutationObserver(() => {
            const mount = findMount();
            if (!button?.isConnected || button.parentElement !== mount) mountButton(context);
            else if (mount?.parentElement !== panelAnchor) layoutPanel();
        });
        observer.observe(document.documentElement, { childList: true, subtree: true });
        focusin = event => {
            if (!isOwned(event.target)) outsideFocus = event.target;
        };
        resize = layoutPanel;
        document.addEventListener('focusin', focusin);
        globalThis.addEventListener('resize', resize);
    }

    function deactivate() {
        lifecycle += 1;
        panelRequest += 1;
        cancelDocumentWait?.();
        const restore = isOwned(document.activeElement);
        const target = returnFocus?.isConnected && !isOwned(returnFocus) ? returnFocus : outsideFocus;
        observer?.disconnect();
        panel?.removeEventListener('keydown', keydown);
        button?.removeEventListener('keydown', keydown);
        document.removeEventListener('focusin', focusin);
        globalThis.removeEventListener('resize', resize);
        button?.remove();
        panel?.remove();
        style?.remove();
        if (restore) focus(target);
        style = button = panel = pluginList = managementStatus = refreshButton = closeButton = null;
        confirmation = confirmationStatus = confirmButton = cancelButton = actionOrigin = null;
        observer = keydown = focusin = resize = mountToken = returnFocus = outsideFocus = panelAnchor = null;
        action = 'idle';
        actionError = '';
    }

    return {
        activate(context) {
            deactivate();
            return start(context, lifecycle);
        },
        deactivate
    };
})();
