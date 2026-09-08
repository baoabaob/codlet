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
    let panelTitle, settingsSection;
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
        // Use the documented dialog/setting-row geometry; viewport clamping belongs to this GUI.
        style.textContent = `
            [${BUTTON_ATTRIBUTE}], [${PANEL_ATTRIBUTE}] {
                color: var(--codlet-ui-fg, CanvasText);
                font-family: var(--codlet-ui-font, system-ui, sans-serif);
                font-size: var(--codlet-ui-font-size, 14px);
                letter-spacing: 0;
                line-height: 1.45;
            }
            [${BUTTON_ATTRIBUTE}] {
                appearance: none;
                -webkit-app-region: no-drag;
                pointer-events: auto;
                flex: 0 0 auto;
                box-sizing: border-box;
                height: auto;
                padding: 4px 10px;
                border: 1px solid transparent;
                border-radius: var(--codlet-ui-radius, 4px);
                background: transparent;
                color: var(--codlet-ui-menu-fg, var(--codlet-ui-muted, GrayText));
                font-weight: var(--codlet-ui-font-weight-normal, 400);
                line-height: 1;
                white-space: nowrap;
                cursor: default;
            }
            [${BUTTON_ATTRIBUTE}]:hover, [${BUTTON_ATTRIBUTE}]:focus-visible {
                color: var(--codlet-ui-menu-hover-fg, var(--codlet-ui-muted, GrayText));
                background: var(--codlet-ui-menu-hover-bg, color-mix(in oklab, CanvasText 5%, transparent));
            }
            [${PANEL_ATTRIBUTE}] button:hover:not(:disabled) {
                background: var(--codlet-ui-hover, color-mix(in srgb, CanvasText 8%, Canvas));
            }
            [${BUTTON_ATTRIBUTE}][aria-expanded="true"] {
                color: var(--codlet-ui-menu-active-fg, var(--codlet-ui-fg, CanvasText));
                background: var(--codlet-ui-active, color-mix(in srgb, CanvasText 12%, Canvas));
            }
            [${PANEL_ATTRIBUTE}] button:active:not(:disabled) {
                background: var(--codlet-ui-active, color-mix(in srgb, CanvasText 12%, Canvas));
            }
            [${BUTTON_ATTRIBUTE}]:focus-visible, [${PANEL_ATTRIBUTE}] :focus-visible {
                outline: 2px solid var(--codlet-ui-focus, Highlight);
                outline-offset: 2px;
            }
            [${PANEL_ATTRIBUTE}] {
                position: fixed;
                left: 0;
                right: 0;
                bottom: 0;
                display: flex;
                flex-direction: column;
                width: 600px;
                max-width: 92vw;
                max-height: calc(100dvh - var(--codlet-available-top, 36px) - 32px);
                min-height: 0;
                margin: auto;
                padding: 0;
                box-sizing: border-box;
                border: 0;
                border-radius: var(--codlet-ui-dialog-radius, 20px);
                background: color-mix(in srgb, var(--codlet-ui-surface-raised, Canvas) 90%, transparent);
                box-shadow: 0 0 0 0.5px var(--codlet-ui-border, ButtonBorder), var(--codlet-ui-dialog-shadow, 0 4px 8px -2px rgb(0 0 0 / 10%));
                backdrop-filter: blur(24px);
                overflow-wrap: anywhere;
                overflow: hidden;
                -webkit-app-region: no-drag;
            }
            [${PANEL_ATTRIBUTE}]::backdrop { background: var(--codlet-ui-backdrop, #00000022); }
            [${PANEL_ATTRIBUTE}][data-codlet-view="confirmation"] { width: 420px; }
            [${PANEL_ATTRIBUTE}] *, [${PANEL_ATTRIBUTE}] *::before, [${PANEL_ATTRIBUTE}] *::after { box-sizing: border-box; }
            [${PANEL_ATTRIBUTE}]:not([open]), [${PANEL_ATTRIBUTE}][hidden], [${PANEL_ATTRIBUTE}] [hidden] { display: none; }
            [${PANEL_ATTRIBUTE}] button {
                appearance: none;
                margin: 0;
                border: 0;
                border-radius: 999px;
                background: transparent;
                color: inherit;
                font: inherit;
                letter-spacing: 0;
                cursor: var(--codlet-ui-cursor, default);
            }
            [${PANEL_ATTRIBUTE}] button:disabled { opacity: 0.4; }
            [${PANEL_ATTRIBUTE}] .codlet-panel-header {
                display: flex;
                align-items: center;
                gap: 16px;
                flex: 0 0 auto;
                padding: 20px 56px 0 20px;
            }
            [${PANEL_ATTRIBUTE}] .codlet-panel-title {
                flex: 1;
                min-width: 0;
                margin: 0;
                font-size: var(--codlet-ui-font-heading, 20px);
                line-height: 28px;
                font-weight: var(--codlet-ui-font-weight-medium, 500);
            }
            [${PANEL_ATTRIBUTE}] .codlet-icon-button {
                display: inline-flex;
                align-items: center;
                justify-content: center;
                flex: 0 0 24px;
                width: 24px;
                height: 24px;
                padding: 0;
            }
            [${PANEL_ATTRIBUTE}] .codlet-dialog-close {
                position: absolute;
                top: 16px;
                right: 16px;
                border-radius: 4px;
                color: color-mix(in srgb, var(--codlet-ui-fg, CanvasText) 80%, transparent);
            }
            [${PANEL_ATTRIBUTE}] .codlet-panel-body {
                min-height: 0;
                overflow: auto;
                overscroll-behavior: contain;
                padding: 12px 20px 20px;
                scrollbar-gutter: stable;
            }
            [${PANEL_ATTRIBUTE}] .codlet-section-header {
                display: flex;
                align-items: center;
                justify-content: space-between;
                gap: 16px;
                min-height: 46px;
                padding-bottom: 6px;
            }
            [${PANEL_ATTRIBUTE}] .codlet-section-title {
                margin: 0;
                font-size: inherit;
                font-weight: var(--codlet-ui-font-weight-medium, 500);
            }
            [${PANEL_ATTRIBUTE}] .codlet-status,
            [${PANEL_ATTRIBUTE}] .codlet-plugin-version,
            [${PANEL_ATTRIBUTE}] .codlet-plugin-state,
            [${PANEL_ATTRIBUTE}] .codlet-confirmation-copy {
                color: var(--codlet-ui-secondary, GrayText);
            }
            [${PANEL_ATTRIBUTE}] .codlet-status { margin: 8px 0; }
            [${PANEL_ATTRIBUTE}] .codlet-plugin-list {
                overflow: hidden;
                border: 1px solid var(--codlet-ui-border, ButtonBorder);
                border-radius: var(--codlet-ui-group-radius, 16px);
                background: var(--codlet-ui-surface-group, var(--codlet-ui-surface, Canvas));
            }
            [${PANEL_ATTRIBUTE}] .codlet-plugin-list:empty { display: none; }
            [${PANEL_ATTRIBUTE}] .codlet-plugin-row {
                position: relative;
                display: grid;
                grid-template-columns: minmax(0, 1fr) auto;
                align-items: center;
                column-gap: 24px;
                padding: 12px 16px;
            }
            [${PANEL_ATTRIBUTE}] .codlet-plugin-row:not(:last-child)::after {
                content: '';
                position: absolute;
                pointer-events: none;
                left: 16px;
                right: 16px;
                bottom: 0;
                height: 0.5px;
                background: var(--codlet-ui-border, ButtonBorder);
            }
            [${PANEL_ATTRIBUTE}] .codlet-plugin-copy { min-width: 0; }
            [${PANEL_ATTRIBUTE}] .codlet-plugin-name { font-size: var(--codlet-ui-font-small, 13px); line-height: 18px; font-weight: var(--codlet-ui-font-weight-medium, 500); }
            [${PANEL_ATTRIBUTE}] .codlet-plugin-version { margin-top: 2px; font-size: var(--codlet-ui-font-caption, 12px); line-height: 16px; }
            [${PANEL_ATTRIBUTE}] .codlet-plugin-state { max-width: 88px; font-size: var(--codlet-ui-font-small, 13px); line-height: 18px; text-align: right; }
            [${PANEL_ATTRIBUTE}] .codlet-toggle {
                appearance: none;
                position: relative;
                width: 32px;
                height: 20px;
                padding: 0;
                margin: 0;
                border: 0;
                border-radius: 999px;
                background: color-mix(in oklab, var(--codlet-ui-fg, CanvasText) 10%, transparent);
                color: var(--codlet-ui-on-accent, HighlightText);
                cursor: var(--codlet-ui-cursor, default);
                transition: background-color var(--codlet-ui-motion-duration, var(--codlet-fallback-motion-duration, 150ms)) ease-out;
            }
            [${PANEL_ATTRIBUTE}] .codlet-toggle::before {
                content: '';
                position: absolute;
                top: 2px;
                left: 2px;
                width: 16px;
                height: 16px;
                border-radius: 50%;
                background: currentColor;
                transition: left var(--codlet-ui-motion-duration, var(--codlet-fallback-motion-duration, 150ms)) ease-out;
            }
            [${PANEL_ATTRIBUTE}] .codlet-toggle:checked {
                background: var(--codlet-ui-accent, Highlight);
            }
            [${PANEL_ATTRIBUTE}] .codlet-toggle:checked::before { left: 14px; }
            [${PANEL_ATTRIBUTE}] .codlet-toggle:disabled { opacity: 0.4; }
            [${PANEL_ATTRIBUTE}] .codlet-confirmation-copy { margin: 0; color: var(--codlet-ui-muted, GrayText); line-height: 1.5; }
            [${PANEL_ATTRIBUTE}] .codlet-confirmation-copy code { font: inherit; color: var(--codlet-ui-fg, CanvasText); }
            [${PANEL_ATTRIBUTE}] .codlet-confirmation-actions { display: flex; flex-wrap: wrap; gap: 12px; justify-content: end; padding-top: 12px; }
            [${PANEL_ATTRIBUTE}] .codlet-confirmation-actions button {
                min-height: 36px;
                padding: 6px 16px;
                border: 1px solid transparent;
                border-radius: 999px;
                font-size: var(--codlet-ui-font-small, 13px);
                line-height: 18px;
                font-weight: var(--codlet-ui-font-weight-medium, 500);
                background: color-mix(in oklab, var(--codlet-ui-fg, CanvasText) 5%, transparent);
            }
            [${PANEL_ATTRIBUTE}] .codlet-confirmation-actions button:hover:not(:disabled) {
                background: color-mix(in oklab, var(--codlet-ui-fg, CanvasText) 10%, transparent);
            }
            [${PANEL_ATTRIBUTE}] .codlet-confirmation-actions .codlet-confirm {
                color: var(--codlet-ui-danger-fg, HighlightText);
                background: var(--codlet-ui-danger-bg, Highlight);
            }
            [${PANEL_ATTRIBUTE}] .codlet-confirmation-actions .codlet-confirm:hover:not(:disabled) {
                background: var(--codlet-ui-danger-hover, Highlight);
            }
            @media (prefers-reduced-motion: reduce) {
                [${PANEL_ATTRIBUTE}] { --codlet-fallback-motion-duration: 0ms; }
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
        settingsSection.hidden = action !== 'idle';
        confirmation.hidden = action === 'idle';
        panel.setAttribute('data-codlet-view', action === 'idle' ? 'settings' : 'confirmation');
        panelTitle.textContent = action === 'idle' ? 'Codlet' : action === 'done' ? 'Codlet disabled' : 'Disable Codlet?';
        panel.setAttribute('aria-label', panelTitle.textContent);
        if (action === 'idle') panel.removeAttribute('aria-describedby');
        else panel.setAttribute('aria-describedby', `${panel.id}-disable-consequence`);
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
        addText(copy, 'div', 'codlet-plugin-name', plugin.id === 'codlet' ? 'Codlet GUI' : plugin.id);
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
        if (panel.open && !panel.hidden) renderAction();
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
            if (epoch !== lifecycle || panel !== currentPanel || !currentPanel.open || currentPanel.hidden || request !== panelRequest) return;
            if (!Array.isArray(management?.plugins) || management.plugins.some(plugin =>
                !plugin || typeof plugin.id !== 'string' || !plugin.id.length)) throw new Error('Plugin list unavailable');
            pluginList.replaceChildren(...management.plugins.map(plugin => createPluginRow(context, plugin)));
            pluginList.hidden = false;
            managementStatus.hidden = management.plugins.length > 0;
            managementStatus.textContent = management.plugins.length ? '' : 'No plugins';
        } catch (error) {
            if (epoch !== lifecycle || panel !== currentPanel || !currentPanel.open || currentPanel.hidden || request !== panelRequest) return;
            managementStatus.textContent = error?.code === 'rpc_timeout'
                ? 'Plugin list timed out. Refresh to try again.'
                : error instanceof Error ? error.message : 'Plugin list unavailable';
        }
        if (epoch === lifecycle && panel === currentPanel && currentPanel.open && !currentPanel.hidden && request === panelRequest) {
            pluginList.setAttribute('aria-busy', 'false');
        }
    }

    function createPanel(context) {
        panel = document.createElement('dialog');
        panel.id = `codlet-panel-${context.generation}`;
        panel.setAttribute(PANEL_ATTRIBUTE, 'codlet');
        panel.setAttribute('data-codlet-ui-theme', CAPABILITY_TOKEN);
        panel.setAttribute('data-codlet-generation', String(context.generation));
        panel.setAttribute('role', 'dialog');
        panel.setAttribute('aria-modal', 'true');
        panel.setAttribute('aria-label', 'Codlet');
        panel.hidden = true;
        const header = addText(panel, 'div', 'codlet-panel-header', '');
        panelTitle = addText(header, 'h1', 'codlet-panel-title', 'Codlet');
        closeButton = iconButton(header, 'close', 'Close Codlet');
        closeButton.className += ' codlet-dialog-close';
        closeButton.addEventListener('click', () => setPanelOpen(false));
        const body = addText(panel, 'div', 'codlet-panel-body', '');
        settingsSection = addText(body, 'section', 'codlet-settings-section', '');
        const sectionHeader = addText(settingsSection, 'div', 'codlet-section-header', '');
        addText(sectionHeader, 'h2', 'codlet-section-title', 'Codlets');
        refreshButton = iconButton(sectionHeader, 'refresh', 'Refresh plugins');
        refreshButton.addEventListener('click', () => refreshPlugins(context));
        managementStatus = addText(settingsSection, 'div', 'codlet-status', '');
        managementStatus.setAttribute('role', 'status');
        managementStatus.setAttribute('aria-live', 'polite');
        pluginList = addText(settingsSection, 'div', 'codlet-plugin-list', '');
        confirmation = addText(body, 'div', 'codlet-confirmation', '');
        confirmation.hidden = true;
        confirmation.setAttribute('role', 'group');
        confirmation.setAttribute('aria-label', 'Disable Codlet?');
        const consequence = addText(confirmation, 'p', 'codlet-confirmation-copy',
            'The Codlet GUI will close in all open windows. To restore it, run ');
        addText(consequence, 'code', '', 'codlet plugin enable codlet');
        consequence.appendChild(document.createTextNode(', then start Codlet again.'));
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
        const currentPanel = panel;
        panel.addEventListener('pointerdown', event => {
            if (panel !== currentPanel || !panel.open || event.defaultPrevented) return;
            event.stopPropagation();
            if (event.target !== panel || event.button !== 0 || event.ctrlKey || event.isPrimary === false) return;
            const bounds = panel.getBoundingClientRect();
            if (event.clientX >= bounds.left && event.clientX <= bounds.right &&
                event.clientY >= bounds.top && event.clientY <= bounds.bottom) return;
            event.preventDefault();
            if (action === 'confirm' || action === 'failed') cancelAction();
            else setPanelOpen(false);
        });
        panel.addEventListener('cancel', event => {
            if (event.defaultPrevented || panel !== currentPanel) return;
            event.preventDefault();
            event.stopPropagation();
            if (action === 'confirm' || action === 'failed') cancelAction();
            else setPanelOpen(false);
        });
        panel.addEventListener('close', () => {
            if (panel === currentPanel && !panel.open && !panel.hidden) setPanelOpen(false);
        });
        document.body.appendChild(panel);
    }

    function layoutPanel() {
        if (!panel) return;
        const mount = findMount();
        const anchor = mount?.parentElement ?? mount;
        panelAnchor = anchor;
        const top = Math.min(globalThis.innerHeight, Math.max(0, Math.round(anchor?.getBoundingClientRect().bottom ?? 40)));
        panel.style.top = `${top}px`;
        panel.style.setProperty('--codlet-available-top', `${top}px`);
    }

    function setPanelOpen(open) {
        if (!panel || (open ? panel.open && !panel.hidden : !panel.open && panel.hidden)) return false;
        if (open) {
            if (!panel.isConnected) return false;
            returnFocus = document.activeElement;
            panel.hidden = false;
            renderAction();
            layoutPanel();
            try {
                panel.showModal();
            } catch (error) {
                panel.hidden = true;
                if (panel.open) panel.close();
                button?.setAttribute('aria-expanded', 'false');
                if (button) button.title = error instanceof Error ? error.message : 'Could not open Codlet';
                if (panel.contains(document.activeElement)) focus(returnFocus);
                returnFocus = null;
                return false;
            }
            button?.setAttribute('aria-expanded', 'true');
            if (button) button.title = 'Codlet';
            focus(closeButton);
        } else {
            panelRequest += 1;
            const restore = panel.contains(document.activeElement);
            if (action === 'confirm' || action === 'failed') {
                action = 'idle';
                renderAction();
            }
            if (panel.open) panel.close();
            panel.hidden = true;
            button?.setAttribute('aria-expanded', 'false');
            if (restore) focus(returnFocus?.isConnected ? returnFocus : button?.isConnected ? button : outsideFocus);
            returnFocus = null;
        }
        return true;
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
                if (setPanelOpen(true)) return refreshPlugins(context);
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
        if (panel?.open) panel.close();
        if (panel) panel.hidden = true;
        button?.remove();
        panel?.remove();
        style?.remove();
        if (restore) focus(target);
        style = button = panel = pluginList = managementStatus = refreshButton = closeButton = null;
        panelTitle = settingsSection = null;
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
