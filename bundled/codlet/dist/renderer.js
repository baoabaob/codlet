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
    let confirmation, confirmationCopy, confirmationStatus, confirmButton, cancelButton, actionOrigin;
    let confirmationSelection = null;
    let visiblePlugins = [];
    let tooltip = null, tooltipControl = null, tooltipTimer = null;
    let observer, keydown, focusin, resize, cancelDocumentWait;
    let mountToken = null;
    let returnFocus = null;
    let outsideFocus = null;
    let panelAnchor = null;
    let lifecycle = 0;
    let panelRequest = 0;
    let action = 'idle';
    let actionError = '';
    let pendingOperation = null;
    let operationTimer = null;
    const mutationControls = new Set();
    const renderedPlugins = new Map();

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
        control.setAttribute('aria-label', label);
        installTooltip(control, label);
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

    function hideTooltip() {
        if (tooltipTimer !== null) clearTimeout(tooltipTimer);
        tooltipTimer = null;
        tooltipControl?.removeAttribute('aria-describedby');
        tooltip?.remove();
        tooltip = tooltipControl = null;
    }

    function installTooltip(control, text) {
        const schedule = () => {
            hideTooltip();
            tooltipControl = control;
            const epoch = lifecycle;
            tooltipTimer = setTimeout(() => {
                tooltipTimer = null;
                if (epoch !== lifecycle || !panel?.open || panel.hidden || !control.isConnected || control.disabled) return hideTooltip();
                tooltip = addText(panel, 'div', 'codlet-tooltip', text);
                tooltip.id = `${panel.id}-tooltip`;
                tooltip.setAttribute('role', 'tooltip');
                control.setAttribute('aria-describedby', tooltip.id);
                const container = panel.getBoundingClientRect();
                const anchor = control.getBoundingClientRect();
                const bounds = tooltip.getBoundingClientRect();
                const width = bounds.width || 180, height = bounds.height || 28;
                const x = Math.max(8, Math.min((anchor.left ?? container.left) - container.left, container.right - container.left - width - 8));
                const below = anchor.bottom - container.top + 8;
                const y = below + height <= container.bottom - container.top - 8 ? below : Math.max(8, (anchor.top ?? anchor.bottom) - container.top - height - 8);
                tooltip.style.left = `${x}px`;
                tooltip.style.top = `${y}px`;
            }, 280);
        };
        const cancel = () => { if (tooltipControl === control) hideTooltip(); };
        control.addEventListener('pointerenter', schedule);
        control.addEventListener('pointerleave', cancel);
        control.addEventListener('pointerdown', cancel);
        control.addEventListener('focusin', () => { if (control.matches?.(':focus-visible')) schedule(); });
        control.addEventListener('focusout', cancel);
    }

    function pluginName(plugin) {
        return typeof plugin.name === 'string' && plugin.name.trim() ? plugin.name.trim() : plugin.id;
    }

    function requestDisable(context, plugin, origin) {
        if (pendingOperation || action !== 'idle' || !panel?.open || panel.hidden) return;
        const dependents = Array.isArray(plugin.disableDependents) ? plugin.disableDependents.filter(id => typeof id === 'string' && id !== plugin.id) : [];
        const closesGui = plugin.id === context.pluginId || dependents.includes(context.pluginId);
        if (!dependents.length && !closesGui) return managePlugin(context, plugin.id, 'disable');
        confirmationSelection = { id: plugin.id, name: pluginName(plugin), cascade: dependents.length > 0 };
        const dependentNames = dependents.map(id => pluginName(visiblePlugins.find(candidate => candidate.id === id) ?? { id }));
        confirmationCopy.textContent = `${dependentNames.length ? `This will also disable: ${dependentNames.join(', ')}. ` : ''}${closesGui ? 'The Codlet GUI will close in all open windows. Re-enable the plugins from the launcher to restore it.' : 'These plugins will stay disabled until you enable them again.'}`;
        actionOrigin = origin;
        action = 'confirm';
        renderAction();
        focus(cancelButton);
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
            [${PANEL_ATTRIBUTE}] .codlet-plugin-actions {
                display: flex;
                align-items: center;
                gap: 8px;
                flex: 0 0 auto;
            }
            [${PANEL_ATTRIBUTE}] .codlet-plugin-actions > button {
                min-width: 28px;
                min-height: 28px;
                padding: 4px 8px;
            }
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
            [${PANEL_ATTRIBUTE}] .codlet-tooltip {
                position: absolute;
                z-index: 10;
                pointer-events: none;
                max-width: min(360px, calc(100% - 16px));
                max-height: 140px;
                overflow: hidden;
                padding: 6px 9px;
                border: 1px solid var(--codlet-ui-border, ButtonBorder);
                border-radius: 6px;
                background: var(--codlet-ui-surface-raised, Canvas);
                color: var(--codlet-ui-fg, CanvasText);
                font-size: var(--codlet-ui-font-small, 13px);
                font-weight: 400;
                line-height: 1.4;
                white-space: pre-line;
                box-shadow: 0 2px 8px rgb(0 0 0 / 15%);
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
        hideTooltip();
        settingsSection.hidden = action !== 'idle';
        confirmation.hidden = action === 'idle';
        panel.setAttribute('data-codlet-view', action === 'idle' ? 'settings' : 'confirmation');
        const selectedName = confirmationSelection?.name || 'Codlet';
        panelTitle.textContent = action === 'idle' ? 'Codlet' : action === 'done' ? `${selectedName} disabled` : `Disable ${selectedName}?`;
        panel.setAttribute('aria-label', panelTitle.textContent);
        confirmation.setAttribute('aria-label', panelTitle.textContent);
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
            actionOrigin.disabled = action !== 'idle' || pendingOperation !== null;
        }
    }

    function cancelAction() {
        if (action !== 'confirm' && action !== 'failed') return;
        action = 'idle';
        confirmationSelection = null;
        renderAction();
        focus(actionOrigin?.isConnected ? actionOrigin : refreshButton);
    }

    function createPluginRow(context, plugin) {
        const execution = plugin.execution?.kind === 'host' ? plugin.execution : null;
        const executionState = execution?.state === 'active' && execution.rendererActive === false ? 'Waiting for renderer'
            : execution?.state === 'starting' ? 'Starting'
            : execution?.state === 'active' ? 'Active'
            : execution?.state === 'stopping' ? 'Stopping'
            : execution?.state === 'failed' ? 'Failed'
            : execution?.state === 'exited' ? 'Exited' : null;
        const executionError = typeof execution?.error === 'string' && execution.error.length > 0
            ? execution.error : execution?.state === 'failed' ? 'Host process failed' : null;
        const row = document.createElement('div');
        row.className = 'codlet-plugin-row';
        const copy = document.createElement('div');
        copy.className = 'codlet-plugin-copy';
        const name = pluginName(plugin);
        addText(copy, 'div', 'codlet-plugin-name', name);
        const metadata = [plugin.version, plugin.source === 'local' ? 'Local' : null]
            .filter(value => typeof value === 'string' && value.length > 0);
        if (metadata.length) addText(copy, 'div', 'codlet-plugin-version', metadata.join(' / '));
        const path = typeof plugin.path === 'string' ? plugin.path : plugin.loadedPath;
        installTooltip(copy, `${plugin.id}${typeof path === 'string' ? `\n${path}` : ''}`);
        if (plugin.registered === false && plugin.loaded === true) {
            addText(copy, 'div', 'codlet-plugin-version', 'Registration removed; still loaded');
        } else if (plugin.validation?.status === 'not_loaded') {
            addText(copy, 'div', 'codlet-plugin-version', 'Registered, not loaded');
        }
        if (executionError) {
            addText(copy, 'div', 'codlet-plugin-version', executionError);
        } else if (plugin.validation?.status === 'failed') {
            const message = plugin.validation.error?.message;
            addText(copy, 'div', 'codlet-plugin-version', typeof message === 'string' ? message : 'Plugin validation failed');
        }
        row.appendChild(copy);
        const state = executionState ?? (plugin.active === true ? 'Active'
            : plugin.validation?.status === 'failed' ? 'Unavailable'
            : plugin.enabled === true ? 'Not active' : 'Disabled');
        if (plugin.id === context.pluginId && plugin.active === true && plugin.enabled === true) {
            const controls = addText(row, 'div', 'codlet-plugin-actions', '');
            addText(controls, 'div', 'codlet-plugin-state', state);
            const toggle = document.createElement('input');
            toggle.className = 'codlet-toggle';
            toggle.type = 'checkbox';
            toggle.checked = true;
            toggle.setAttribute('role', 'switch');
            toggle.setAttribute('aria-label', 'Enable Codlet GUI');
            toggle.addEventListener('change', () => {
                if (toggle.checked || action !== 'idle' || pendingOperation || !row.isConnected || panel.hidden) return;
                return requestDisable(context, plugin, toggle);
            });
            mutationControls.add(toggle);
            toggle.disabled = pendingOperation !== null;
            controls.appendChild(toggle);
        } else {
            if (plugin.registered !== false || plugin.loaded === true) {
                const controls = addText(row, 'div', 'codlet-plugin-actions', '');
                addText(controls, 'div', 'codlet-plugin-state', state);
                if (plugin.registered === false) {
                    const stop = addText(controls, 'button', '', 'Stop');
                    stop.type = 'button';
                    stop.setAttribute('aria-label', `Stop ${name}`);
                    stop.addEventListener('click', () => requestDisable(context, plugin, stop));
                    mutationControls.add(stop);
                    stop.disabled = pendingOperation !== null;
                    return row;
                }
                if (plugin.enabled === true) {
                    const loadAction = plugin.loaded === true || Number.isSafeInteger(plugin.generation) ? 'reload' : 'enable';
                    const load = loadAction === 'reload'
                        ? iconButton(controls, 'refresh', `Reload ${name}${plugin.disableDependents?.length ? ' and dependent plugins' : ''}`)
                        : addText(controls, 'button', '', 'Start');
                    load.type = 'button';
                    load.setAttribute('aria-label', `${loadAction === 'reload' ? 'Reload' : 'Start'} ${name}`);
                    load.addEventListener('click', () => managePlugin(context, plugin.id, loadAction));
                    mutationControls.add(load);
                    load.disabled = pendingOperation !== null;
                }
                const toggle = document.createElement('input');
                toggle.className = 'codlet-toggle';
                toggle.type = 'checkbox';
                toggle.checked = plugin.enabled === true;
                toggle.setAttribute('role', 'switch');
                toggle.setAttribute('aria-label', `Enable ${name}`);
                toggle.addEventListener('change', () => {
                    const nextAction = toggle.checked ? 'enable' : 'disable';
                    toggle.checked = plugin.enabled === true;
                    return nextAction === 'disable' ? requestDisable(context, plugin, toggle) : managePlugin(context, plugin.id, nextAction);
                });
                controls.appendChild(toggle);
                mutationControls.add(toggle);
                toggle.disabled = pendingOperation !== null;
            } else {
                addText(row, 'div', 'codlet-plugin-state', state);
            }
        }
        return row;
    }

    function updatePluginRows(context, plugins) {
        const focused = document.activeElement;
        const focusLabel = pluginList.contains(focused) ? focused.getAttribute('aria-label') : null;
        const ids = new Set(plugins.map(plugin => plugin.id));
        for (const [id, entry] of renderedPlugins) {
            if (!ids.has(id)) {
                entry.row.remove();
                renderedPlugins.delete(id);
            }
        }
        plugins.forEach((plugin, index) => {
            const snapshot = JSON.stringify(plugin);
            let entry = renderedPlugins.get(plugin.id);
            if (!entry || entry.snapshot !== snapshot) {
                entry?.row.remove();
                entry = { snapshot, row: createPluginRow(context, plugin) };
                renderedPlugins.set(plugin.id, entry);
            }
            if (pluginList.children[index] !== entry.row) {
                pluginList.insertBefore(entry.row, pluginList.children[index] ?? null);
            }
        });
        for (const control of mutationControls) {
            if (!control.isConnected) mutationControls.delete(control);
        }
        if (focusLabel && !focused.isConnected) {
            focus([...mutationControls].find(control => control.getAttribute('aria-label') === focusLabel) ?? refreshButton);
        }
    }

    function operationMessage(message) {
        if (!panel?.open || panel.hidden || action !== 'idle') return;
        managementStatus.hidden = false;
        managementStatus.textContent = message;
    }

    function setMutationBusy(busy) {
        if (busy) hideTooltip();
        for (const control of mutationControls) {
            if (control.isConnected) control.disabled = busy;
        }
    }

    async function finishOperation(context, expected, message) {
        if (pendingOperation !== expected) return;
        const epoch = lifecycle;
        pendingOperation = null;
        if (operationTimer !== null) clearTimeout(operationTimer);
        operationTimer = null;
        if (panel?.open && !panel.hidden) {
            await refreshPlugins(context);
            if (epoch === lifecycle && pendingOperation === null) operationMessage(message);
        }
    }

    async function checkOperation(context, expected = pendingOperation) {
        if (!expected?.operationId || pendingOperation !== expected || expected.checking) return;
        if (operationTimer !== null) clearTimeout(operationTimer);
        operationTimer = null;
        const epoch = lifecycle;
        expected.checking = true;
        let reply;
        try {
            reply = await context.rpc.request(RUNTIME_MANAGE_CAPABILITY, 'operation', { operationId: expected.operationId });
        } catch (_) {
            if (epoch === lifecycle && pendingOperation === expected) {
                operationMessage('Action status unavailable. Refresh to check again.');
            }
            expected.checking = false;
            return;
        }
        expected.checking = false;
        if (epoch !== lifecycle || pendingOperation !== expected) return;
        const operation = reply?.operation;
        if (operation?.operation_id !== expected.operationId ||
            operation.request?.plugin_id !== expected.pluginId || operation.request?.action !== expected.action) {
            operationMessage(reply?.error || 'Action status is no longer available. The action has not been repeated.');
            return;
        }
        if (reply.status === 'completed') {
            const completion = operation.completion;
            const report = completion?.kind === 'report' ? completion.report : null;
            const succeeded = report?.outcome === 'applied' || report?.outcome === 'unchanged';
            const message = succeeded
                ? `${expected.name}: ${expected.action === 'enable' ? 'enabled' : expected.action === 'disable' ? 'disabled' : 'reloaded'}.`
                : completion?.error?.message || report?.message || 'The action finished with an error. Refresh for the current state.';
            await finishOperation(context, expected, message);
            return;
        }
        if (reply.status !== 'queued' && reply.status !== 'running') {
            operationMessage(reply?.error || 'The action was not confirmed. Refresh checks the same action without repeating it.');
            return;
        }
        operationMessage(`${expected.name}: ${reply.status === 'queued' ? 'waiting' : 'updating'}...`);
        if (panel?.open && !panel.hidden) {
            operationTimer = setTimeout(() => { operationTimer = null; void checkOperation(context, expected); }, 250);
        }
    }

    async function managePlugin(context, pluginId, nextAction, cascade = false) {
        if (pendingOperation || action !== 'idle' || !panel?.open || panel.hidden) return;
        const epoch = lifecycle;
        const expected = { pluginId, name: pluginName(visiblePlugins.find(plugin => plugin.id === pluginId) ?? { id: pluginId }), action: nextAction, operationId: null, checking: false };
        pendingOperation = expected;
        setMutationBusy(true);
        operationMessage(`${expected.name}: preparing...`);
        let prepared;
        try {
            prepared = await context.rpc.request(RUNTIME_MANAGE_CAPABILITY, 'prepare', { action: nextAction, plugin_id: pluginId, ...(cascade ? { cascade: true } : {}) });
        } catch (error) {
            if (epoch === lifecycle) await finishOperation(context, expected, error instanceof Error ? error.message : 'The action could not be prepared.');
            return;
        }
        if (epoch !== lifecycle || pendingOperation !== expected) return;
        if (prepared?.status !== 'prepared' || typeof prepared.operation?.operation_id !== 'string') {
            await finishOperation(context, expected, prepared?.error || 'The action could not be prepared.');
            return;
        }
        expected.operationId = prepared.operation.operation_id;
        let submitted;
        try {
            // One submission only. A lost reply is followed exclusively by
            // read-only queries for this exact server-issued receipt.
            submitted = await context.rpc.request(RUNTIME_MANAGE_CAPABILITY, 'submit', { operationId: expected.operationId });
        } catch (_) {
            submitted = null;
        }
        if (epoch !== lifecycle || pendingOperation !== expected) return;
        if (['busy', 'not_ready', 'stopping', 'expired', 'stale_host', 'invalid_request', 'not_running'].includes(submitted?.status)) {
            await finishOperation(context, expected, submitted.error || 'The action was not submitted. Try again when the runtime is ready.');
            return;
        }
        await checkOperation(context, expected);
    }

    async function disableSelf(context) {
        if (action !== 'confirm' && action !== 'failed') return;
        if (confirmationSelection && (confirmationSelection.id !== context.pluginId || confirmationSelection.cascade)) {
            const selection = confirmationSelection;
            confirmationSelection = null;
            action = 'idle';
            renderAction();
            return managePlugin(context, selection.id, 'disable', selection.cascade);
        }
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
        if (pendingOperation?.operationId) {
            await checkOperation(context);
            return;
        }
        const currentPanel = panel;
        const epoch = lifecycle;
        const request = ++panelRequest;
        hideTooltip();
        const initial = pluginList.children.length === 0;
        pluginList.hidden = initial;
        pluginList.setAttribute('aria-busy', 'true');
        setMutationBusy(true);
        managementStatus.hidden = false;
        managementStatus.textContent = initial ? 'Loading plugins...' : 'Updating plugins...';
        try {
            const management = await context.rpc.request(RUNTIME_MANAGE_CAPABILITY, 'list', null);
            if (epoch !== lifecycle || panel !== currentPanel || !currentPanel.open || currentPanel.hidden || request !== panelRequest) return;
            if (!Array.isArray(management?.plugins) || management.plugins.some(plugin =>
                !plugin || typeof plugin.id !== 'string' || !plugin.id.length)) throw new Error('Plugin list unavailable');
            if (new Set(management.plugins.map(plugin => plugin.id)).size !== management.plugins.length) throw new Error('Plugin list contains duplicate IDs');
            visiblePlugins = management.plugins;
            setMutationBusy(false);
            updatePluginRows(context, management.plugins);
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
            setMutationBusy(pendingOperation !== null);
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
        confirmationCopy = addText(confirmation, 'p', 'codlet-confirmation-copy', '');
        confirmationCopy.id = `${panel.id}-disable-consequence`;
        confirmation.setAttribute('aria-describedby', confirmationCopy.id);
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
        panel.addEventListener('scroll', hideTooltip, true);
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
            if (tooltip) { hideTooltip(); return; }
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
            hideTooltip();
            panelRequest += 1;
            if (operationTimer !== null) clearTimeout(operationTimer);
            operationTimer = null;
            const restore = panel.contains(document.activeElement);
            if (action === 'confirm' || action === 'failed') {
                action = 'idle';
                confirmationSelection = null;
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
            if (tooltip) { hideTooltip(); return; }
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
        resize = () => { hideTooltip(); layoutPanel(); };
        document.addEventListener('focusin', focusin);
        globalThis.addEventListener('resize', resize);
    }

    function deactivate() {
        lifecycle += 1;
        panelRequest += 1;
        if (operationTimer !== null) clearTimeout(operationTimer);
        operationTimer = null;
        pendingOperation = null;
        hideTooltip();
        visiblePlugins = [];
        confirmationSelection = null;
        mutationControls.clear();
        renderedPlugins.clear();
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
        confirmation = confirmationCopy = confirmationStatus = confirmButton = cancelButton = actionOrigin = null;
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
