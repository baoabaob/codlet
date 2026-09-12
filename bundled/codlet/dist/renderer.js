module.exports = (() => {
    const CAPABILITY_TOKEN = 'codex.ui.titlebar.afterMenu@1';
    const MOUNT_ATTRIBUTE = 'data-codlet-capability';
    const STYLE_ATTRIBUTE = 'data-codlet-style';
    const BUTTON_ATTRIBUTE = 'data-codlet-titlebar-button';
    const PANEL_ATTRIBUTE = 'data-codlet-panel';
    const MOUNT_CAPABILITY = Object.freeze({ name: 'codex.ui.titlebar.afterMenu', api: 1, scope: 'target' });
    const APPEARANCE_CAPABILITY = Object.freeze({ name: 'codex.ui.appearance', api: 1, scope: 'target' });
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

    let ui, style, button, panel, pluginList, managementStatus, refreshButton, closeButton;
    const ROLE_BY_CLASS = Object.freeze({ 'codlet-panel-header': 'dialogHeader', 'codlet-panel-title': 'heading', 'codlet-panel-body': 'dialogBody', 'codlet-plugin-list': 'section', 'codlet-plugin-actions': 'actions', 'codlet-plugin-name': 'label', 'codlet-plugin-version': 'description', 'codlet-confirmation-actions': 'dialogActions', 'codlet-status': 'status' });
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
    let page = 'plugins', localManagement = null;
    let importButton, importSection, importPath, chooseFolderButton, inspectButton, importStatus, previewBody, importSubmit;
    let importTrust, importEnable, importPreview = null, importBusy = false, localRequest = 0, pickerTimer = null;
    let detailsSection, detailsBody, detailsStatus, detailsPlugin = null;
    let githubButton, githubFields, githubUrl, githubRead, githubRelease, githubAsset, githubDownload, githubCancel, githubRetry;
    let importMode = 'local', importOperation = 'install', importTarget = null, githubCatalog = null, githubJob = null, githubTimer = null;
    let runtimeContext = null;
    const COMMUNITY_URL = 'https://github.com/topics/codlet-plugin';
    const importGrants = new Map(), scopeInputs = new Map();
    const PERMISSION_COPY = Object.freeze({
        'ui.dom': 'Read and change the page interface', 'ui.mainWorld': 'Run in the page’s main JavaScript world',
        'cdp.raw': 'Use raw browser debugging access', 'host.process': 'Run native code with your user account’s OS permissions',
        'host.fs': 'Read files inside explicitly allowed folders', 'host.network': 'Request explicitly allowed HTTP(S) origins',
        'host.system': 'Read basic system information', 'runtime.manage': 'Manage other plugins and their permissions'
    });

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
        const element = tag === 'button' ? ui.button({ text, variant: className === 'codlet-confirm' ? 'danger' : 'default' })
            : ui.element(tag, { role: ROLE_BY_CLASS[className], text });
        element.className = className;
        element.textContent = text;
        parent.appendChild(element);
        return element;
    }

    function iconButton(parent, name, label) {
        const control = ui.button({ label, variant: name === 'close' ? 'close' : 'icon' });
        control.className = 'codlet-icon-button';
        parent.appendChild(control);
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
        if (tooltip && ui) ui.remove(tooltip);
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
        ui.on(control, 'pointerenter', schedule);
        ui.on(control, 'pointerleave', cancel);
        ui.on(control, 'pointerdown', cancel);
        ui.on(control, 'focusin', () => { if (control.matches?.(':focus-visible')) schedule(); });
        ui.on(control, 'focusout', cancel);
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
        // Shared control geometry and theme recipes belong to codex.ui.appearance.
        // This consumer owns its viewport anchor, business layout and tooltips.
        style.textContent = `
            [${BUTTON_ATTRIBUTE}] { pointer-events:auto; }
            [${PANEL_ATTRIBUTE}] { max-height:calc(100dvh - var(--codlet-available-top,36px) - 32px); }
            [${PANEL_ATTRIBUTE}][data-codlet-view="confirmation"] { width:420px; }
            [${PANEL_ATTRIBUTE}] *, [${PANEL_ATTRIBUTE}] *::before, [${PANEL_ATTRIBUTE}] *::after { box-sizing:border-box; }
            [${PANEL_ATTRIBUTE}] [hidden] { display:none; }
            [${PANEL_ATTRIBUTE}] .codlet-section-header { display:flex; align-items:center; justify-content:space-between; gap:16px; min-height:46px; padding-bottom:6px; }
            [${PANEL_ATTRIBUTE}] .codlet-section-title { margin:0; font-size:inherit; font-weight:var(--codlet-ui-font-weight-medium,500); }
            [${PANEL_ATTRIBUTE}] .codlet-plugin-list:empty { display:none; }
            [${PANEL_ATTRIBUTE}] .codlet-plugin-state { max-width:88px; font-size:var(--codlet-ui-font-small,13px); line-height:calc(var(--codlet-ui-font-small,13px) * 18 / 13); text-align:right; color:var(--codlet-ui-secondary,GrayText); }
            [${PANEL_ATTRIBUTE}] .codlet-confirmation-copy { margin:0; color:var(--codlet-ui-muted,GrayText); line-height:1.5; }
            [${PANEL_ATTRIBUTE}] .codlet-confirmation-copy code { font:inherit; color:var(--codlet-ui-fg,CanvasText); }
            [${PANEL_ATTRIBUTE}] .codlet-local-page { display:flex; flex-direction:column; gap:16px; min-width:0; }
            [${PANEL_ATTRIBUTE}] .codlet-local-toolbar { display:flex; align-items:center; flex-wrap:wrap; gap:8px; }
            [${PANEL_ATTRIBUTE}] .codlet-local-toolbar > :first-child { margin-right:auto; }
            [${PANEL_ATTRIBUTE}] .codlet-field { display:flex; flex-direction:column; gap:6px; }
            [${PANEL_ATTRIBUTE}] .codlet-field-label { font-weight:500; }
            [${PANEL_ATTRIBUTE}] .codlet-field-input { width:100%; min-width:0; padding:8px 10px; border:1px solid var(--codlet-ui-border,ButtonBorder); border-radius:6px; background:var(--codlet-ui-input-bg,var(--codlet-ui-surface,Canvas)); color:inherit; font:inherit; line-height:1.45; }
            [${PANEL_ATTRIBUTE}] textarea.codlet-field-input { min-height:64px; resize:vertical; }
            [${PANEL_ATTRIBUTE}] .codlet-field-input:focus-visible { outline:2px solid var(--codlet-ui-accent,Highlight); outline-offset:2px; }
            [${PANEL_ATTRIBUTE}] .codlet-local-copy { margin:0; color:var(--codlet-ui-secondary,GrayText); font-size:var(--codlet-ui-font-small,13px); line-height:1.5; white-space:pre-line; overflow-wrap:anywhere; }
            [${PANEL_ATTRIBUTE}] .codlet-local-preview { display:flex; flex-direction:column; gap:14px; }
            [${PANEL_ATTRIBUTE}] .codlet-permission-choice { display:flex; align-items:flex-start; gap:10px; line-height:1.45; }
            [${PANEL_ATTRIBUTE}] .codlet-permission-choice input { flex:0 0 auto; margin:4px 0 0; accent-color:var(--codlet-ui-accent,Highlight); }
            [${PANEL_ATTRIBUTE}] .codlet-permission-line { display:flex; align-items:center; gap:12px; }
            [${PANEL_ATTRIBUTE}] .codlet-permission-line > :first-child { flex:1; min-width:0; }
            [${PANEL_ATTRIBUTE}] .codlet-details-button { flex:0 0 auto; }
            [${PANEL_ATTRIBUTE}] .codlet-tooltip { position:absolute; z-index:10; pointer-events:none; max-width:min(360px,calc(100% - 16px)); max-height:140px; overflow:hidden; padding:6px 9px; border:1px solid var(--codlet-ui-border,ButtonBorder); border-radius:6px; background:var(--codlet-ui-surface-raised,Canvas); color:var(--codlet-ui-fg,CanvasText); font-size:var(--codlet-ui-font-small,13px); font-weight:400; line-height:1.4; white-space:pre-line; box-shadow:0 2px 8px rgb(0 0 0 / 15%); }
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
        settingsSection.hidden = action !== 'idle' || page !== 'plugins';
        importSection.hidden = action !== 'idle' || page !== 'import';
        detailsSection.hidden = action !== 'idle' || page !== 'details';
        confirmation.hidden = action === 'idle';
        panel.setAttribute('data-codlet-view', action === 'idle' ? page === 'plugins' ? 'settings' : page : 'confirmation');
        const selectedName = confirmationSelection?.name || 'Codlet';
        const verb = confirmationSelection?.action === 'remove' ? 'Remove' : confirmationSelection?.action === 'revoke' ? 'Revoke permission for' : 'Disable';
        panelTitle.textContent = action === 'idle' ? page === 'import' ? importMode === 'local' ? 'Import local plugin' : importOperation === 'update' ? 'Update GitHub plugin' : importOperation === 'rollback' ? 'Roll back plugin' : 'Import from GitHub' : page === 'details' ? pluginName(detailsPlugin ?? { id: 'Plugin details' }) : 'Codlet'
            : action === 'done' ? `${selectedName} disabled` : `${verb} ${selectedName}?`;
        panel.setAttribute('aria-label', panelTitle.textContent);
        confirmation.setAttribute('aria-label', panelTitle.textContent);
        if (action === 'idle') panel.removeAttribute('aria-describedby');
        else panel.setAttribute('aria-describedby', `${panel.id}-disable-consequence`);
        refreshButton.disabled = action !== 'idle';
        confirmButton.disabled = action === 'pending' || action === 'done';
        cancelButton.disabled = confirmButton.disabled;
        confirmButton.textContent = action === 'pending' ? 'Disabling...' : confirmationSelection?.action === 'remove' ? 'Remove' : confirmationSelection?.action === 'revoke' ? 'Revoke' : 'Disable';
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

    function addLoadControl(context, plugin, controls, loadAction) {
        const name = pluginName(plugin);
        const load = loadAction === 'reload'
            ? iconButton(controls, 'refresh', `Reload ${name}${plugin.disableDependents?.length ? ' and dependent plugins' : ''}`)
            : addText(controls, 'button', '', 'Start');
        load.type = 'button';
        load.setAttribute('aria-label', `${loadAction === 'reload' ? 'Reload' : 'Start'} ${name}`);
        load.addEventListener('click', () => managePlugin(context, plugin.id, loadAction));
        mutationControls.add(load);
        load.disabled = pendingOperation !== null;
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
        const name = pluginName(plugin);
        const metadata = [plugin.version, plugin.ownership === 'core-managed-github' ? `GitHub${plugin.managedSource?.tag ? ` · ${plugin.managedSource.tag}` : ''}` : plugin.source === 'local' ? 'Local' : null]
            .filter(value => typeof value === 'string' && value.length > 0);
        const parts = ui.row({ label: name, description: metadata.join(' / ') });
        const row = parts.element, copy = parts.copy;
        row.className = 'codlet-plugin-row'; copy.className = 'codlet-plugin-copy';
        parts.label.className = 'codlet-plugin-name'; parts.description.className = 'codlet-plugin-version';
        parts.controls.className = 'codlet-plugin-actions';
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
        if (plugin.source === 'local' && Array.isArray(plugin.grants)) {
            addText(copy, 'div', 'codlet-plugin-version', `Permissions: ${plugin.grants.join(', ') || 'None'}`);
        }
        if (plugin.source === 'local' && plugin.registered !== false) {
            const details = addText(parts.controls, 'button', 'codlet-details-button', 'Details');
            details.setAttribute('aria-label', `Details for ${name}`);
            ui.on(details, 'click', () => showDetails(context, plugin));
            mutationControls.add(details);
            details.disabled = pendingOperation !== null;
        }
        const state = executionState ?? (plugin.active === true ? 'Active'
            : plugin.validation?.status === 'failed' ? 'Unavailable'
            : plugin.enabled === true ? 'Not active' : 'Disabled');
        if (plugin.id === context.pluginId && plugin.active === true && plugin.enabled === true) {
            const controls = parts.controls;
            addText(controls, 'div', 'codlet-plugin-state', state);
            addLoadControl(context, plugin, controls, 'reload');
            const toggle = ui.switch({ label: 'Enable Codlet GUI', checked: true });
            toggle.className = 'codlet-toggle';
            toggle.type = 'checkbox';
            toggle.checked = true;
            toggle.setAttribute('role', 'switch');
            toggle.setAttribute('aria-label', 'Enable Codlet GUI');
            ui.on(toggle, 'change', () => {
                if (toggle.checked || action !== 'idle' || pendingOperation || !row.isConnected || panel.hidden) return;
                return requestDisable(context, plugin, toggle);
            });
            mutationControls.add(toggle);
            toggle.disabled = pendingOperation !== null;
            controls.appendChild(toggle);
        } else {
            if (plugin.registered !== false || plugin.loaded === true) {
                const controls = parts.controls;
                addText(controls, 'div', 'codlet-plugin-state', state);
                if (plugin.registered === false) {
                    const stop = addText(controls, 'button', '', 'Stop');
                    stop.type = 'button';
                    stop.setAttribute('aria-label', `Stop ${name}`);
                    ui.on(stop, 'click', () => requestDisable(context, plugin, stop));
                    mutationControls.add(stop);
                    stop.disabled = pendingOperation !== null;
                    return row;
                }
                if (plugin.enabled === true) {
                    const loadAction = plugin.loaded === true || Number.isSafeInteger(plugin.generation) ? 'reload' : 'enable';
                    addLoadControl(context, plugin, controls, loadAction);
                }
                const toggle = ui.switch({ label: `Enable ${name}`, checked: plugin.enabled === true });
                toggle.className = 'codlet-toggle';
                toggle.type = 'checkbox';
                toggle.checked = plugin.enabled === true;
                toggle.setAttribute('role', 'switch');
                toggle.setAttribute('aria-label', `Enable ${name}`);
                ui.on(toggle, 'change', () => {
                    const nextAction = toggle.checked ? 'enable' : 'disable';
                    toggle.checked = plugin.enabled === true;
                    return nextAction === 'disable' ? requestDisable(context, plugin, toggle) : managePlugin(context, plugin.id, nextAction);
                });
                controls.appendChild(toggle);
                mutationControls.add(toggle);
                toggle.disabled = pendingOperation !== null;
            } else {
                addText(parts.controls, 'div', 'codlet-plugin-state', state);
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
                ui.remove(entry.row);
                renderedPlugins.delete(id);
            }
        }
        plugins.forEach((plugin, index) => {
            const snapshot = JSON.stringify(plugin);
            let entry = renderedPlugins.get(plugin.id);
            if (!entry || entry.snapshot !== snapshot) {
                if (entry) ui.remove(entry.row);
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
                ? `${expected.name}: ${{ enable: 'enabled', disable: 'disabled', reload: 'reloaded', import: report.desired_enabled ? 'imported and enabled' : 'imported, disabled', update: report.desired_enabled ? 'updated and enabled' : 'updated, disabled', rollback: report.desired_enabled ? 'rolled back and enabled' : 'rolled back, disabled', remove: 'removed; files kept', revoke: 'permission revoked' }[expected.action]}.`
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

    async function managePlugin(context, pluginId, nextAction, cascade = false, extra = {}, displayName = null) {
        if (pendingOperation || action !== 'idle' || !panel?.open || panel.hidden) return;
        const epoch = lifecycle;
        const expected = { pluginId, name: displayName || pluginName(visiblePlugins.find(plugin => plugin.id === pluginId) ?? { id: pluginId }), action: nextAction, operationId: null, checking: false };
        pendingOperation = expected;
        setMutationBusy(true);
        operationMessage(`${expected.name}: preparing...`);
        let prepared;
        try {
            prepared = await context.rpc.request(RUNTIME_MANAGE_CAPABILITY, 'prepare', { action: nextAction, plugin_id: pluginId, ...(cascade ? { cascade: true } : {}), ...extra });
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
        if (confirmationSelection?.action === 'remove' || confirmationSelection?.action === 'revoke') {
            const selected = confirmationSelection;
            confirmationSelection = null;
            action = 'idle'; page = 'plugins';
            renderAction();
            return managePlugin(context, selected.id, selected.action, selected.cascade ?? false, selected.permission ? { permission: selected.permission } : {});
        }
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
            localManagement = management.localManagement ?? null;
            importButton.hidden = localManagement?.available !== true;
            githubButton.hidden = management.githubManagement?.available !== true;
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
        panel = ui.element('dialog', { role: 'dialog', variant: 'settings' });
        panel.id = `codlet-panel-${context.generation}`;
        panel.setAttribute(PANEL_ATTRIBUTE, 'codlet');
        panel.setAttribute('data-codlet-generation', String(context.generation));
        panel.setAttribute('role', 'dialog');
        panel.setAttribute('aria-modal', 'true');
        panel.setAttribute('aria-label', 'Codlet');
        panel.hidden = true;
        const header = addText(panel, 'div', 'codlet-panel-header', '');
        panelTitle = addText(header, 'h1', 'codlet-panel-title', 'Codlet');
        closeButton = iconButton(header, 'close', 'Close Codlet');
        closeButton.className += ' codlet-dialog-close';
        ui.on(closeButton, 'click', () => setPanelOpen(false));
        const body = addText(panel, 'div', 'codlet-panel-body', '');
        settingsSection = addText(body, 'section', 'codlet-settings-section', '');
        const sectionHeader = addText(settingsSection, 'div', 'codlet-section-header', '');
        addText(sectionHeader, 'h2', 'codlet-section-title', 'Codlets');
        const listActions = addText(sectionHeader, 'div', 'codlet-local-toolbar', '');
        importButton = addText(listActions, 'button', '', 'Import local');
        importButton.setAttribute('aria-label', 'Import local plugin');
        importButton.hidden = true;
        mutationControls.add(importButton);
        ui.on(importButton, 'click', () => showImport());
        githubButton = addText(listActions, 'button', '', 'Import GitHub');
        githubButton.setAttribute('aria-label', 'Import from GitHub');
        githubButton.hidden = true;
        mutationControls.add(githubButton);
        ui.on(githubButton, 'click', () => showGitHubImport(context));
        refreshButton = iconButton(listActions, 'refresh', 'Refresh plugins');
        ui.on(refreshButton, 'click', () => refreshPlugins(context));
        managementStatus = addText(settingsSection, 'div', 'codlet-status', '');
        managementStatus.setAttribute('role', 'status');
        managementStatus.setAttribute('aria-live', 'polite');
        pluginList = addText(settingsSection, 'div', 'codlet-plugin-list', '');
        const community = ui.externalLink({ text: 'Browse community plugins', href: COMMUNITY_URL });
        settingsSection.appendChild(community);
        addText(settingsSection, 'p', 'codlet-local-copy', `GitHub Topic codlet-plugin is a community discovery convention. Listings are not endorsements or permission grants. Review the repository and release before importing.\n${COMMUNITY_URL}`);
        createLocalPages(context, body);
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
        ui.on(cancelButton, 'click', cancelAction);
        confirmButton = addText(actions, 'button', 'codlet-confirm', 'Disable');
        confirmButton.type = 'button';
        ui.on(confirmButton, 'click', () => disableSelf(context));
        const currentPanel = panel;
        ui.on(panel, 'scroll', hideTooltip, true);
        ui.on(panel, 'pointerdown', event => {
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
        ui.on(panel, 'cancel', event => {
            if (event.defaultPrevented || panel !== currentPanel) return;
            event.preventDefault();
            event.stopPropagation();
            if (tooltip) { hideTooltip(); return; }
            if (action === 'confirm' || action === 'failed') cancelAction();
            else setPanelOpen(false);
        });
        ui.on(panel, 'close', () => {
            if (panel === currentPanel && !panel.open && !panel.hidden) setPanelOpen(false);
        });
        document.body.appendChild(panel);
    }

    function clearLocalBody(parent) {
        for (const child of Array.from(parent.children)) ui.remove(child);
    }

    function localInput(parent, label, multiline = false) {
        const field = addText(parent, 'div', 'codlet-field', '');
        const caption = addText(field, 'label', 'codlet-field-label', label);
        const input = ui.element(multiline ? 'textarea' : 'input');
        input.className = 'codlet-field-input';
        input.value = '';
        if (!multiline) input.type = 'text';
        input.setAttribute('aria-label', label);
        input.autocomplete = 'off'; input.spellcheck = false;
        input.id = `${panel.id}-field-${label.replace(/[^a-zA-Z0-9]/g, '-')}`;
        caption.setAttribute('for', input.id);
        field.appendChild(input);
        return input;
    }

    function localCheckbox(parent, label, text = label) {
        const row = addText(parent, 'label', 'codlet-permission-choice', '');
        const input = ui.element('input');
        input.type = 'checkbox'; input.checked = false;
        input.setAttribute('aria-label', label);
        row.appendChild(input);
        addText(row, 'span', '', text);
        return input;
    }

    function localStatus(message) { importStatus.textContent = message; importStatus.hidden = !message; }

    function invalidatePreview() {
        localRequest += 1;
        if (pickerTimer !== null) clearTimeout(pickerTimer);
        pickerTimer = null;
        importPreview = null; importBusy = false;
        importGrants.clear(); scopeInputs.clear();
        importTrust = importEnable = null;
        clearLocalBody(previewBody);
        previewBody.hidden = true;
        importSubmit.disabled = true;
        inspectButton.disabled = false;
        chooseFolderButton.disabled = false;
    }

    function cancelGitHubWork() {
        if (githubTimer !== null) clearTimeout(githubTimer);
        githubTimer = null;
        const job = githubJob;
        githubJob = null;
        if (job?.jobId && runtimeContext) {
            void runtimeContext.rpc.request(RUNTIME_MANAGE_CAPABILITY, 'cancelGitHubJob', { jobId: job.jobId }).catch(() => {});
        }
        if (githubCancel) githubCancel.hidden = true;
        if (githubRetry) githubRetry.hidden = true;
    }

    function resetGitHubSelection() {
        cancelGitHubWork(); invalidatePreview();
        githubCatalog = null;
        fillSelect(githubRelease, 'Choose a release', []);
        fillSelect(githubAsset, 'Choose a ZIP asset', []);
        githubDownload.disabled = true;
        githubRead.disabled = false;
    }

    function configureImportPage() {
        const local = importMode === 'local';
        importPath.parentElement.hidden = !local;
        inspectButton.hidden = !local;
        chooseFolderButton.hidden = !local || localManagement?.folderPicker !== true;
        githubFields.hidden = local || importOperation === 'rollback';
        importSubmit.textContent = local || importOperation === 'install' ? 'Import plugin' : importOperation === 'update' ? 'Update plugin' : 'Roll back plugin';
        importSubmit.setAttribute('aria-label', local ? 'Confirm local import' : importOperation === 'install' ? 'Confirm GitHub import' : importOperation === 'update' ? 'Confirm managed update' : 'Confirm managed rollback');
    }

    function showImport() {
        if (pendingOperation || action !== 'idle' || !panel?.open || panel.hidden) return;
        resetGitHubSelection(); importMode = 'local'; importOperation = 'install'; importTarget = null;
        page = 'import';
        configureImportPage();
        localStatus('Choose the folder containing codlet.json, or enter its full path.');
        renderAction();
        focus(importPath);
    }

    function backToPlugins(context) {
        if (pendingOperation) return;
        resetGitHubSelection();
        page = 'plugins'; detailsPlugin = null;
        renderAction();
        focus(importButton.hidden ? refreshButton : importButton);
        return refreshPlugins(context);
    }

    function importReady() {
        importSubmit.disabled = !importPreview || importBusy || pendingOperation !== null
            || importTrust?.checked !== true || [...importGrants.values()].some(control => !control.checked);
    }

    function renderImportPreview(preview) {
        clearLocalBody(previewBody);
        importGrants.clear(); scopeInputs.clear();
        const manifest = preview.manifest;
        addText(previewBody, 'h2', 'codlet-section-title', manifest.name || manifest.id);
        addText(previewBody, 'p', 'codlet-local-copy', `${manifest.id} · ${manifest.version}\n${preview.path}`);
        const entries = [manifest.renderer ? `Renderer: ${manifest.renderer.entry} (${manifest.renderer.world})` : null, manifest.host ? `Host: ${manifest.host.entry}` : null].filter(Boolean);
        addText(previewBody, 'p', 'codlet-local-copy', entries.join('\n'));
        const requirements = [
            ...(manifest.renderer ? (manifest.requires ?? []).map(cap => ({ ...cap, entry: 'Renderer' })) : []),
            ...(manifest.host ? (manifest.renderer ? manifest.host.requires ?? [] : manifest.requires ?? []).map(cap => ({ ...cap, entry: 'Host' })) : [])
        ];
        addText(previewBody, 'p', 'codlet-local-copy', requirements.length
            ? `Dependencies\n${requirements.map(cap => `${cap.entry}: ${cap.name}@${cap.api} (${cap.scope})`).join('\n')}\nAvailability is checked again when enabling.` : 'Dependencies: none');
        const unavailable = (preview.dependencyCheck?.requirements ?? []).filter(requirement => requirement.status === 'unavailable');
        if (unavailable.length) addText(previewBody, 'p', 'codlet-local-copy', `Currently unavailable: ${unavailable.map(item => `${item.capability.name}@${item.capability.api}`).join(', ')}. You can import the folder while disabled, then enable its providers first.`);
        if (importMode === 'github') {
            renderManagedSource(previewBody, preview.source, preview.metadata);
            addText(previewBody, 'p', 'codlet-local-copy', 'Codlet owns this installed package directory. Removing registration keeps the package and plugin data. The SHA-256 identifies downloaded bytes; it does not establish trust in the author.');
            if (preview.currentVersion) {
                addText(previewBody, 'p', 'codlet-local-copy', `Version: ${preview.currentVersion.manifest.version} → ${manifest.version}\nRepository: ${preview.currentVersion.source.repositoryUrl} → ${preview.source.repositoryUrl}\nRelease: ${preview.currentVersion.source.tag} → ${preview.source.tag}`);
                const runtimeDeclaration = metadata => metadata?.runtimeApi == null ? 'unknown' : `author declared API ${metadata.runtimeApi}`;
                const platformDeclaration = metadata => metadata?.platforms?.length ? `author declared ${metadata.platforms.join(', ')}` : 'unknown';
                addText(previewBody, 'p', 'codlet-local-copy', `Runtime declaration: ${runtimeDeclaration(preview.currentVersion.metadata)} → ${runtimeDeclaration(preview.metadata)}\nPlatform declaration: ${platformDeclaration(preview.currentVersion.metadata)} → ${platformDeclaration(preview.metadata)}`);
                const changes = preview.changes ?? {};
                for (const [label, key] of [['Permissions added', 'permissionsAdded'], ['Permissions removed', 'permissionsRemoved'], ['Dependencies added', 'requirementsAdded'], ['Dependencies removed', 'requirementsRemoved']]) {
                    addText(previewBody, 'p', 'codlet-local-copy', `${label}: ${(changes[key] ?? []).map(item => typeof item === 'string' ? item : `${item.name}@${item.api} (${item.scope})`).join(', ') || 'None'}`);
                }
                addText(previewBody, 'p', 'codlet-local-copy', `Currently ${preview.existingEnabled ? 'enabled' : 'disabled'}. This ${importOperation} leaves the plugin disabled unless you select “Enable after import”. Confirm the source and every grant again.`);
            }
        } else addText(previewBody, 'p', 'codlet-local-copy', `The plugin runs from this development folder. Removing it keeps these files.\nAutomatic reload: ${preview.watchEnabled ? 'on while the plugin is enabled' : 'off in this session; use Reload after editing'}.`);
        if (preview.existingRegistration && importMode === 'local') {
            addText(previewBody, 'p', 'codlet-local-copy', `Already registered at this folder. Confirm all grants again to replace its permission settings.\nCurrent grants: ${preview.existingRegistration.grants.join(', ') || 'None'}. Stop the package before importing it again.`);
        }
        addText(previewBody, 'h2', 'codlet-section-title', 'Requested permissions');
        for (const permission of manifest.permissions ?? []) {
            const checkbox = localCheckbox(previewBody, `Grant ${permission}`, `${permission} — ${PERMISSION_COPY[permission] || permission}`);
            importGrants.set(permission, checkbox);
            ui.on(checkbox, 'change', importReady);
        }
        if (!(manifest.permissions ?? []).length) addText(previewBody, 'p', 'codlet-local-copy', 'No permissions requested.');
        for (const [permission, key, label] of [
            ['host.fs', 'readRoots', 'Allowed read folders — one full path per line'],
            ['host.network', 'networkOrigins', 'Allowed network origins — one HTTP(S) origin per line'],
            ['host.process', 'executables', 'Allowed child programs — one full .exe path per line']
        ]) {
            if (importGrants.has(permission)) scopeInputs.set(key, localInput(previewBody, label, true));
        }
        if (scopeInputs.size) addText(previewBody, 'p', 'codlet-local-copy', 'Empty lists grant no access through the file, network or child-process broker. Native Host code still runs with your OS user permissions.');
        importTrust = localCheckbox(previewBody, importMode === 'local' ? 'Trust this local plugin' : 'Trust this GitHub source', importMode === 'local' ? 'I trust this plugin’s author and this local folder.' : `I trust the author and this exact source: ${preview.source.repositoryUrl}, release ${preview.source.tag}, asset ${preview.source.assetName}.`);
        importEnable = localCheckbox(previewBody, 'Enable after import', importMode === 'local' || importOperation === 'install' ? 'Enable immediately after importing' : `Enable after ${importOperation}; otherwise keep disabled`);
        ui.on(importTrust, 'change', importReady);
        previewBody.hidden = false;
        importReady();
    }

    async function inspectLocal(context) {
        if (pendingOperation || importBusy || page !== 'import' || !panel?.open || panel.hidden) return;
        invalidatePreview();
        const path = importPath.value.trim();
        if (!path) { localStatus('Enter the full path to a plugin folder.'); focus(importPath); return; }
        importBusy = true; inspectButton.disabled = chooseFolderButton.disabled = true;
        const request = localRequest, epoch = lifecycle;
        localStatus('Checking the manifest and JavaScript entries...');
        try {
            const preview = await context.rpc.request(RUNTIME_MANAGE_CAPABILITY, 'previewLocal', { path });
            if (epoch !== lifecycle || request !== localRequest || page !== 'import' || !panel?.open || panel.hidden) return;
            if (preview?.schema !== 1 || preview.kind !== 'codlet.local-import-preview' || typeof preview.path !== 'string'
                || typeof preview.manifest?.id !== 'string' || typeof preview.manifest?.version !== 'string'
                || !Array.isArray(preview.manifest.permissions) || preview.manifest.permissions.some(permission => !Object.hasOwn(PERMISSION_COPY, permission))
                || !/^[0-9a-f]{64}$/.test(preview.contentDigest) || !/^[0-9a-f]{64}$/.test(preview.registrationDigest)) throw new Error('The import preview is incomplete.');
            importPreview = preview; importBusy = false;
            renderImportPreview(preview);
            localStatus('Review the folder and grant each requested permission to continue.');
            focus(importGrants.values().next().value ?? importTrust);
        } catch (error) {
            if (epoch === lifecycle && request === localRequest && page === 'import') localStatus(String(error?.message ?? error));
        } finally {
            if (epoch === lifecycle && request === localRequest) {
                importBusy = false; inspectButton.disabled = chooseFolderButton.disabled = false; importReady();
            }
        }
    }

    async function chooseLocalFolder(context) {
        if (pendingOperation || importBusy || page !== 'import' || !panel?.open || panel.hidden) return;
        invalidatePreview(); importBusy = true;
        chooseFolderButton.disabled = inspectButton.disabled = true;
        const request = localRequest, epoch = lifecycle;
        const current = () => epoch === lifecycle && request === localRequest && page === 'import' && panel?.open && !panel.hidden;
        localStatus('Choose a plugin folder in the Windows dialog.');
        const accept = async selection => {
            if (!current()) return;
            if (selection?.status === 'selecting' && typeof selection.selectionId === 'string') {
                pickerTimer = setTimeout(async () => {
                    pickerTimer = null;
                    if (!current()) return;
                    try { await accept(await context.rpc.request(RUNTIME_MANAGE_CAPABILITY, 'folderSelection', { selectionId: selection.selectionId })); }
                    catch (error) { fail(error); }
                }, 300);
            } else if (selection?.status === 'selected' && typeof selection.path === 'string') {
                importPath.value = selection.path; importBusy = false;
                await inspectLocal(context);
            } else {
                importBusy = false; chooseFolderButton.disabled = inspectButton.disabled = false;
                localStatus(selection?.status === 'cancelled' ? 'Folder selection cancelled.' : selection?.error || 'Folder selection failed. Enter the full path instead.');
            }
        };
        const fail = error => {
            if (!current()) return;
            importBusy = false; chooseFolderButton.disabled = inspectButton.disabled = false;
            localStatus(String(error?.message ?? error));
        };
        try { await accept(await context.rpc.request(RUNTIME_MANAGE_CAPABILITY, 'chooseLocalFolder', null)); }
        catch (error) { fail(error); }
    }

    function submitImport(context) {
        importReady();
        if (importSubmit.disabled || !importPreview || page !== 'import') return;
        const preview = importPreview;
        const brokerPolicy = Object.fromEntries([...scopeInputs].map(([key, input]) => [key, input.value.split(/\r?\n/).map(line => line.trim()).filter(Boolean)]));
        const selection = { path: preview.path, contentDigest: preview.contentDigest, registrationDigest: preview.registrationDigest,
            trusted: true, grants: [...importGrants].filter(([, input]) => input.checked).map(([permission]) => permission), brokerPolicy, enable: importEnable.checked,
            ...(importMode === 'github' ? { managed: importOperation } : {}) };
        const nextAction = importMode === 'github' && importOperation !== 'install' ? importOperation : 'import';
        cancelGitHubWork(); invalidatePreview(); page = 'plugins'; renderAction();
        return managePlugin(context, preview.manifest.id, nextAction, false, { local_import: selection }, preview.manifest.name || preview.manifest.id);
    }

    function renderManagedSource(parent, source, metadata) {
        addText(parent, 'p', 'codlet-local-copy', `Repository: ${source.repositoryUrl}\nRelease/tag: ${source.tag}\nAsset: ${source.assetName}\nSHA-256: ${source.sha256}\nGitHub digest: ${source.upstreamDigestVerified ? 'matched' : 'not available for verification'}`);
        addText(parent, 'p', 'codlet-local-copy', `Runtime compatibility: ${metadata?.runtimeApi === undefined || metadata.runtimeApi === null ? 'unknown (not declared)' : `author declared API ${metadata.runtimeApi}`}\nPlatforms: ${Array.isArray(metadata?.platforms) && metadata.platforms.length ? `author declared ${metadata.platforms.join(', ')}` : 'unknown (not declared)'}\nCodex builds tested: unknown; no verification claim is made by this importer.${metadata?.author ? `\nAuthor: ${metadata.author}` : ''}`);
    }

    function fillSelect(select, placeholder, options) {
        clearLocalBody(select);
        const blank = addText(select, 'option', '', placeholder); blank.value = '';
        for (const [value, label] of options) { const option = addText(select, 'option', '', label); option.value = String(value); }
        select.value = ''; select.disabled = options.length === 0;
    }

    function showGitHubImport(context, target = null) {
        if (pendingOperation || action !== 'idle' || !panel?.open || panel.hidden) return;
        resetGitHubSelection(); importMode = 'github'; importOperation = target ? 'update' : 'install'; importTarget = target;
        githubUrl.value = target?.managedSource?.repositoryUrl ?? '';
        page = 'import'; configureImportPage(); renderAction();
        localStatus(target ? 'Check releases, then explicitly choose a version and asset. Updating requires fresh source trust and grants.' : 'Enter a GitHub repository, release or release asset URL. Select a published ZIP package; repository source archives are not installable packages.');
        focus(githubUrl);
        if (target && githubUrl.value) return readGitHubReleases(context);
    }

    function githubControls() {
        githubRead.disabled = importBusy;
        githubRelease.disabled = importBusy || !githubCatalog?.releases.length;
        const release = githubCatalog?.releases.find(item => String(item.id) === githubRelease.value);
        githubAsset.disabled = importBusy || !release?.assets.some(asset => /\.zip$/i.test(asset.name));
        githubDownload.disabled = importBusy || !release || !release.assets.some(asset => String(asset.id) === githubAsset.value && /\.zip$/i.test(asset.name));
        githubCancel.hidden = !importBusy;
        importReady();
    }

    function acceptManagedPreview(preview, selection = null) {
        if (preview?.schema !== 1 || preview.kind !== 'codlet.managed-preview' || preview.operation !== importOperation
            || preview.ownership !== 'core-managed-github' || typeof preview.path !== 'string'
            || typeof preview.manifest?.id !== 'string' || typeof preview.manifest?.version !== 'string'
            || !Array.isArray(preview.manifest.permissions) || preview.manifest.permissions.some(permission => !Object.hasOwn(PERMISSION_COPY, permission))
            || !/^[0-9a-f]{64}$/.test(preview.contentDigest) || !/^[0-9a-f]{64}$/.test(preview.registrationDigest)
            || !/^[0-9a-f]{64}$/.test(preview.source?.sha256) || typeof preview.source.repositoryUrl !== 'string'
            || typeof preview.source.tag !== 'string' || typeof preview.source.assetName !== 'string'
            || (importTarget && preview.manifest.id !== importTarget.id)
            || (selection && (preview.source.repositoryUrl !== selection.repositoryUrl || preview.source.releaseId !== selection.releaseId || preview.source.assetId !== selection.assetId))) throw new Error('The managed package preview is incomplete or does not match the selected plugin and release asset.');
        importPreview = preview; importBusy = false;
        renderImportPreview(preview);
        localStatus('Review the exact source, compatibility, dependencies and permissions before confirming.');
        focus(importGrants.values().next().value ?? importTrust);
    }

    function acceptGitHubCatalog(catalog) {
        if (typeof catalog?.repository?.url !== 'string' || !Array.isArray(catalog.releases)
            || catalog.releases.some(release => !Number.isSafeInteger(release.id) || typeof release.tag !== 'string' || !Array.isArray(release.assets)
                || release.assets.some(asset => !Number.isSafeInteger(asset.id) || typeof asset.name !== 'string' || !Number.isSafeInteger(asset.size)))) throw new Error('The GitHub release list is incomplete.');
        githubCatalog = catalog;
        fillSelect(githubRelease, 'Choose a release', catalog.releases.map(release => [release.id, `${release.tag}${release.prerelease ? ' (prerelease)' : ''}${release.name ? ` — ${release.name}` : ''}`]));
        fillSelect(githubAsset, 'Choose a ZIP asset', []);
        localStatus(catalog.releases.length ? `Repository: ${catalog.repository.url}\nChoose the exact release and ZIP asset.${catalog.requestedTag ? `\nLink requests tag: ${catalog.requestedTag}${catalog.requestedAsset ? ` / ${catalog.requestedAsset}` : ''}. Confirm that selection below.` : ''}${catalog.truncated ? '\nOnly part of the release history is listed. Use an exact release URL for an older version.' : ''}` : 'No published releases found. Ask the author for a built plugin ZIP, or download and inspect a local plugin folder.');
    }

    async function runGitHubJob(context, method, params, kind) {
        if (pendingOperation || importBusy || page !== 'import' || importMode !== 'github' || !panel?.open || panel.hidden) return;
        invalidatePreview(); cancelGitHubWork();
        importBusy = true;
        const request = localRequest, epoch = lifecycle;
        const expected = { jobId: null, kind, request, epoch, checking: false, selection: kind === 'package' ? params : null };
        githubJob = expected; githubControls();
        localStatus(kind === 'releases' ? 'Reading GitHub releases...' : 'Downloading and validating the selected ZIP. No plugin is registered or enabled yet.');
        try {
            const reply = await context.rpc.request(RUNTIME_MANAGE_CAPABILITY, method, params);
            if (githubJob !== expected || epoch !== lifecycle || request !== localRequest) return;
            if (typeof reply?.jobId !== 'string' || !reply.jobId) throw new Error('GitHub task did not return a job ID. No installation was submitted.');
            expected.jobId = reply.jobId;
            await acceptGitHubJob(context, expected, reply);
        } catch (error) {
            if (githubJob === expected && epoch === lifecycle && request === localRequest) {
                githubJob = null; importBusy = false; githubControls(); localStatus(String(error?.message ?? error));
            }
        }
    }

    async function acceptGitHubJob(context, expected, reply) {
        if (githubJob !== expected || expected.epoch !== lifecycle || expected.request !== localRequest || page !== 'import' || !panel?.open || panel.hidden) return;
        if (reply?.jobId !== expected.jobId || reply.kind !== expected.kind) throw new Error('GitHub task response did not match the requested job.');
        if (reply.status === 'running') {
            localStatus(`${expected.kind === 'releases' ? 'Reading releases' : 'Preparing package'}${reply.stage ? `: ${reply.stage}` : '...'}\nNo installation has been submitted.`);
            githubTimer = setTimeout(() => { githubTimer = null; void pollGitHubJob(context, expected); }, 300);
            return;
        }
        if (reply.status === 'completed') {
            if (expected.kind === 'releases') acceptGitHubCatalog(reply.result);
            else acceptManagedPreview(reply.result, expected.selection);
        } else if (reply.status === 'cancelled') localStatus('GitHub task cancelled. No installation was submitted; temporary download files may remain.');
        else if (reply.status === 'failed') localStatus(reply.error?.message || 'GitHub task failed. No installation was submitted.');
        else throw new Error('GitHub task returned an unknown status.');
        githubJob = null; importBusy = false; githubRetry.hidden = true; githubControls();
    }

    async function pollGitHubJob(context, expected = githubJob) {
        if (!expected?.jobId || githubJob !== expected || expected.checking) return;
        expected.checking = true; githubRetry.hidden = true;
        try {
            const reply = await context.rpc.request(RUNTIME_MANAGE_CAPABILITY, 'githubJob', { jobId: expected.jobId });
            await acceptGitHubJob(context, expected, reply);
        } catch (error) {
            if (githubJob === expected && expected.epoch === lifecycle && expected.request === localRequest) {
                localStatus(`Task status unavailable: ${String(error?.message ?? error)}\nCheck the same task again, or cancel. No new download or installation is started by checking.`);
                githubRetry.hidden = false;
            }
        } finally { expected.checking = false; }
    }

    function readGitHubReleases(context) {
        if (importBusy) return;
        const url = githubUrl.value.trim();
        if (!url) { localStatus('Enter a GitHub URL.'); focus(githubUrl); return; }
        resetGitHubSelection();
        return runGitHubJob(context, 'githubReleases', { url }, 'releases');
    }

    function downloadGitHubAsset(context) {
        githubControls();
        if (githubDownload.disabled) return;
        return runGitHubJob(context, 'githubPrepare', { repositoryUrl: githubCatalog.repository.url, releaseId: Number(githubRelease.value), assetId: Number(githubAsset.value), operation: importOperation, ...(importTarget ? { pluginId: importTarget.id } : {}) }, 'package');
    }

    function requestLocalAction(plugin, nextAction, permission, origin) {
        if (pendingOperation || action !== 'idle' || !panel?.open || panel.hidden) return;
        const dependents = (plugin.disableDependents ?? []).filter(id => id !== plugin.id);
        confirmationSelection = { id: plugin.id, name: pluginName(plugin), action: nextAction, permission, cascade: nextAction === 'remove' && dependents.length > 0 };
        const dependentNames = dependents.map(id => pluginName(visiblePlugins.find(candidate => candidate.id === id) ?? { id }));
        confirmationCopy.textContent = nextAction === 'remove'
            ? `Remove this plugin’s registration and disable it. Its source folder and files will be kept.\n${plugin.path || ''}${dependentNames.length ? `\nAlso disable: ${dependentNames.join(', ')}.` : ''}`
            : `Revoke ${permission}. This stops the package and its running dependents. To grant it again, ${plugin.ownership === 'core-managed-github' ? 'select a managed version and confirm its permissions again' : 'import the local folder and confirm its permissions'}.${dependentNames.length ? `\nDependents: ${dependentNames.join(', ')}.` : ''}`;
        actionOrigin = origin; action = 'confirm'; renderAction(); focus(cancelButton);
    }

    async function showDetails(context, plugin) {
        if (pendingOperation || action !== 'idle' || !panel?.open || panel.hidden) return;
        cancelGitHubWork(); invalidatePreview(); page = 'details'; detailsPlugin = plugin;
        const request = localRequest, epoch = lifecycle;
        clearLocalBody(detailsBody); detailsStatus.textContent = 'Loading permissions...'; detailsStatus.hidden = false;
        renderAction();
        try {
            const reply = await context.rpc.request(RUNTIME_MANAGE_CAPABILITY, 'permissions', { pluginId: plugin.id });
            if (epoch !== lifecycle || request !== localRequest || page !== 'details' || !panel?.open || panel.hidden) return;
            if (reply?.pluginId !== plugin.id || !Array.isArray(reply.registration?.grants) || typeof reply.registration.path !== 'string') throw new Error('Permission details are unavailable.');
            const registration = reply.registration;
            detailsPlugin = { ...plugin, path: registration.path, grants: registration.grants, ...(reply.ownership ? { ownership: reply.ownership } : {}), ...(reply.managedSource ? { managedSource: reply.managedSource } : {}) };
            const managed = detailsPlugin.ownership === 'core-managed-github';
            addText(detailsBody, 'p', 'codlet-local-copy', `${plugin.id}${plugin.version ? ` · ${plugin.version}` : ''}\n${managed ? 'Codlet managed GitHub package' : 'Local development folder'}\n${registration.path}\nRemoving the plugin keeps this folder and plugin data.`);
            if (managed && detailsPlugin.managedSource) renderManagedSource(detailsBody, detailsPlugin.managedSource, reply.metadata);
            addText(detailsBody, 'h2', 'codlet-section-title', 'Granted permissions');
            if (!registration.grants.length) addText(detailsBody, 'p', 'codlet-local-copy', 'No permissions granted.');
            for (const permission of registration.grants) {
                const row = addText(detailsBody, 'div', 'codlet-permission-line', '');
                addText(row, 'p', 'codlet-local-copy', `${permission}\n${PERMISSION_COPY[permission] || ''}`);
                const revoke = addText(row, 'button', '', 'Revoke');
                revoke.setAttribute('aria-label', `Revoke ${permission}`);
                ui.on(revoke, 'click', () => requestLocalAction(detailsPlugin, 'revoke', permission, revoke));
            }
            for (const [key, label] of [['readRoots', 'Allowed read folders'], ['networkOrigins', 'Allowed network origins'], ['executables', 'Allowed child programs']]) {
                const values = registration.brokerPolicy?.[key] ?? [];
                addText(detailsBody, 'p', 'codlet-local-copy', `${label}\n${values.length ? values.join('\n') : 'None'}`);
            }
            const remove = ui.button({ text: 'Remove plugin', label: `Remove ${pluginName(plugin)}`, variant: 'danger' });
            detailsBody.appendChild(remove);
            ui.on(remove, 'click', () => requestLocalAction(detailsPlugin, 'remove', null, remove));
            detailsStatus.hidden = true;
            if (managed) {
                const target = detailsPlugin;
                const check = addText(detailsBody, 'button', '', 'Check GitHub versions');
                check.setAttribute('aria-label', 'Check GitHub versions');
                ui.on(check, 'click', () => showGitHubImport(context, target));
                addText(detailsBody, 'h2', 'codlet-section-title', 'Installed version history');
                const historyBody = addText(detailsBody, 'div', 'codlet-local-preview', '');
                await showManagedHistory(context, target, historyBody, request, epoch);
            }
        } catch (error) {
            if (epoch === lifecycle && request === localRequest && page === 'details') detailsStatus.textContent = String(error?.message ?? error);
        }
    }

    async function showManagedHistory(context, plugin, parent, request, epoch) {
        const current = () => epoch === lifecycle && request === localRequest && page === 'details' && detailsPlugin?.id === plugin.id && parent.isConnected && panel?.open && !panel.hidden;
        const status = addText(parent, 'p', 'codlet-local-copy', 'Loading retained versions...');
        const rows = addText(parent, 'div', 'codlet-local-preview', '');
        const more = addText(parent, 'button', '', 'Load more versions');
        more.setAttribute('aria-label', 'Load more versions'); more.hidden = true;
        let nextCursor = 0, currentVersion, busy = false;
        const seen = new Set();
        const load = async () => {
            if (!current() || busy || nextCursor === null) return;
            busy = true; more.disabled = true;
            const cursor = nextCursor;
            status.textContent = seen.size ? 'Loading more retained versions...' : 'Loading retained versions...';
            try {
                const report = await context.rpc.request(RUNTIME_MANAGE_CAPABILITY, 'managedHistory', { pluginId: plugin.id, ...(cursor ? { cursor } : {}) });
                if (!current()) return;
                const following = report?.nextCursor ?? null;
                if (report?.pluginId !== plugin.id || !Array.isArray(report.history) || report.history.length > 8
                    || (report.currentVersion !== null && typeof report.currentVersion !== 'string')
                    || (following !== null && (!Number.isSafeInteger(following) || following <= cursor || !report.history.length))) throw new Error('Managed version history is unavailable or its cursor is invalid.');
                if (currentVersion !== undefined && report.currentVersion !== currentVersion) throw new Error('The installed version changed. Reopen details to refresh the history.');
                if (report.history.some(version => typeof version.versionKey !== 'string' || typeof version.manifest?.version !== 'string' || typeof version.source?.tag !== 'string')) throw new Error('Managed version history is incomplete.');
                currentVersion = report.currentVersion;
                for (const version of report.history) {
                    if (seen.has(version.versionKey)) continue;
                    seen.add(version.versionKey);
                    const row = addText(rows, 'div', 'codlet-field', '');
                    addText(row, 'p', 'codlet-local-copy', `${version.manifest.version} · ${version.source.tag}${currentVersion === version.versionKey ? ' · Current' : ''}\n${version.source.repositoryUrl}\n${version.source.assetName}\nSHA-256: ${version.source.sha256}`);
                    if (currentVersion !== version.versionKey) {
                        const rollback = addText(row, 'button', '', 'Review rollback');
                        rollback.setAttribute('aria-label', `Review rollback ${version.versionKey}`);
                        ui.on(rollback, 'click', () => inspectRollback(context, plugin, version.versionKey));
                    }
                }
                nextCursor = following;
                status.textContent = seen.size ? 'Rollback uses an already retained package. Review its source and permissions again before applying.' : 'No retained versions.';
                more.hidden = nextCursor === null;
            } catch (error) {
                if (current()) { status.textContent = String(error?.message ?? error); more.hidden = false; }
            } finally {
                busy = false;
                if (current()) more.disabled = false;
            }
        };
        ui.on(more, 'click', load);
        await load();
    }

    async function inspectRollback(context, plugin, versionKey) {
        if (pendingOperation || action !== 'idle' || !panel?.open || panel.hidden) return;
        resetGitHubSelection(); importMode = 'github'; importOperation = 'rollback'; importTarget = plugin;
        page = 'import'; importBusy = true; configureImportPage(); renderAction();
        const request = localRequest, epoch = lifecycle;
        localStatus('Validating the retained package and comparing permissions...');
        try {
            const preview = await context.rpc.request(RUNTIME_MANAGE_CAPABILITY, 'previewRollback', { pluginId: plugin.id, versionKey });
            if (epoch !== lifecycle || request !== localRequest || page !== 'import' || !panel?.open || panel.hidden) return;
            acceptManagedPreview(preview);
        } catch (error) {
            if (epoch === lifecycle && request === localRequest && page === 'import') localStatus(String(error?.message ?? error));
        } finally { if (epoch === lifecycle && request === localRequest) { importBusy = false; importReady(); } }
    }

    function createLocalPages(context, parent) {
        importSection = addText(parent, 'section', 'codlet-local-page', '');
        importSection.hidden = true;
        const toolbar = addText(importSection, 'div', 'codlet-local-toolbar', '');
        const back = addText(toolbar, 'button', '', 'Back to plugins');
        ui.on(back, 'click', () => backToPlugins(context));
        chooseFolderButton = addText(toolbar, 'button', '', 'Choose folder');
        chooseFolderButton.setAttribute('aria-label', 'Choose plugin folder');
        ui.on(chooseFolderButton, 'click', () => chooseLocalFolder(context));
        importPath = localInput(importSection, 'Plugin folder');
        ui.on(importPath, 'input', () => { invalidatePreview(); localStatus('Inspect this folder before importing.'); });
        inspectButton = addText(importSection, 'button', '', 'Inspect folder');
        ui.on(inspectButton, 'click', () => inspectLocal(context));
        githubFields = addText(importSection, 'div', 'codlet-local-preview', ''); githubFields.hidden = true;
        githubUrl = localInput(githubFields, 'GitHub repository or release URL');
        ui.on(githubUrl, 'input', () => { resetGitHubSelection(); localStatus('Read releases for this source before downloading. Trust and grants have been cleared.'); });
        githubRead = addText(githubFields, 'button', '', 'Read releases');
        githubRead.setAttribute('aria-label', 'Read GitHub releases');
        ui.on(githubRead, 'click', () => readGitHubReleases(context));
        const select = label => {
            const field = addText(githubFields, 'label', 'codlet-field', '');
            addText(field, 'span', 'codlet-field-label', label);
            const control = ui.element('select'); control.className = 'codlet-field-input'; control.setAttribute('aria-label', label);
            field.appendChild(control); return control;
        };
        githubRelease = select('GitHub release'); fillSelect(githubRelease, 'Choose a release', []);
        githubAsset = select('GitHub ZIP asset'); fillSelect(githubAsset, 'Choose a ZIP asset', []);
        ui.on(githubRelease, 'change', () => {
            cancelGitHubWork(); invalidatePreview();
            const release = githubCatalog?.releases.find(item => String(item.id) === githubRelease.value);
            const assets = release?.assets.filter(asset => /\.zip$/i.test(asset.name)) ?? [];
            fillSelect(githubAsset, 'Choose a ZIP asset', assets.map(asset => [asset.id, `${asset.name} (${asset.size.toLocaleString()} bytes)`]));
            localStatus(release ? assets.length ? `Selected release: ${release.tag}. Choose the exact plugin ZIP asset.` : 'This release has no ZIP assets. Repository source archives are not plugin release packages. Ask the author for a built package or use local folder import.' : 'Choose an exact release.');
            githubControls();
        });
        ui.on(githubAsset, 'change', () => { cancelGitHubWork(); invalidatePreview(); githubControls(); localStatus('Download and validate this asset before granting permissions.'); });
        githubDownload = addText(githubFields, 'button', '', 'Download and inspect ZIP'); githubDownload.disabled = true;
        githubDownload.setAttribute('aria-label', 'Download selected GitHub asset');
        ui.on(githubDownload, 'click', () => downloadGitHubAsset(context));
        githubCancel = addText(githubFields, 'button', '', 'Cancel GitHub task'); githubCancel.hidden = true;
        githubCancel.setAttribute('aria-label', 'Cancel GitHub task');
        ui.on(githubCancel, 'click', () => {
            cancelGitHubWork(); invalidatePreview(); githubControls();
            localStatus('GitHub task cancelled. Late results will be ignored. No installation was submitted; temporary download files may remain.');
        });
        githubRetry = addText(githubFields, 'button', '', 'Check task status'); githubRetry.hidden = true;
        githubRetry.setAttribute('aria-label', 'Check GitHub task status');
        ui.on(githubRetry, 'click', () => pollGitHubJob(context));
        importStatus = addText(importSection, 'div', 'codlet-local-copy', '');
        importStatus.setAttribute('role', 'status'); importStatus.setAttribute('aria-live', 'polite');
        previewBody = addText(importSection, 'div', 'codlet-local-preview', ''); previewBody.hidden = true;
        importSubmit = ui.button({ text: 'Import plugin', label: 'Confirm local import', variant: 'primary', disabled: true });
        importSection.appendChild(importSubmit);
        ui.on(importSubmit, 'click', () => submitImport(context));
        detailsSection = addText(parent, 'section', 'codlet-local-page', ''); detailsSection.hidden = true;
        const detailsBack = addText(detailsSection, 'button', '', 'Back to plugins');
        ui.on(detailsBack, 'click', () => backToPlugins(context));
        detailsStatus = addText(detailsSection, 'div', 'codlet-local-copy', ''); detailsStatus.setAttribute('role', 'status');
        detailsBody = addText(detailsSection, 'div', 'codlet-local-preview', '');
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
            cancelGitHubWork(); invalidatePreview(); page = 'plugins'; detailsPlugin = null;
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
            button = ui.button({ text: 'Codlet', label: 'Codlet', variant: 'menu' });
            button.setAttribute(BUTTON_ATTRIBUTE, 'codlet');
            button.setAttribute('aria-label', 'Codlet');
            button.setAttribute('aria-haspopup', 'dialog');
            button.setAttribute('aria-controls', panel.id);
            button.setAttribute('aria-expanded', 'false');
            ui.on(button, 'keydown', keydown);
            ui.on(button, 'click', () => {
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
            if (epoch !== lifecycle) return;
            if (typeof capability?.available !== 'boolean' || capability.token !== CAPABILITY_TOKEN) throw new Error('Unsupported UI mount contract');
            const appearance = await context.rpc.request(APPEARANCE_CAPABILITY, 'describe', null);
            if (epoch !== lifecycle) return;
            if (context.ui?.api !== 1) throw new Error('Update the managed renderer runtime for UI helpers');
            ui = context.ui.create(appearance);
        } catch (error) {
            if (epoch === lifecycle) context.reportDiagnostic?.({ code: 'gui_ui_unavailable', message: String(error?.message ?? error) });
            return;
        }
        if (epoch !== lifecycle) return;
        mountToken = capability.token;
        runtimeContext = context;
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
        ui.on(panel, 'keydown', keydown);
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
        cancelGitHubWork();
        lifecycle += 1;
        panelRequest += 1;
        localRequest += 1;
        if (pickerTimer !== null) clearTimeout(pickerTimer);
        pickerTimer = null;
        importPreview = detailsPlugin = localManagement = null;
        importGrants.clear(); scopeInputs.clear();
        page = 'plugins'; importBusy = false;
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
        ui?.dispose(); ui = null;
        button?.remove();
        panel?.remove();
        style?.remove();
        if (restore) focus(target);
        style = button = panel = pluginList = managementStatus = refreshButton = closeButton = null;
        panelTitle = settingsSection = null;
        importButton = importSection = importPath = chooseFolderButton = inspectButton = importStatus = previewBody = importSubmit = null;
        importTrust = importEnable = detailsSection = detailsBody = detailsStatus = null;
        githubButton = githubFields = githubUrl = githubRead = githubRelease = githubAsset = githubDownload = githubCancel = githubRetry = null;
        githubCatalog = importTarget = runtimeContext = null; importMode = 'local'; importOperation = 'install';
        confirmation = confirmationCopy = confirmationStatus = confirmButton = cancelButton = actionOrigin = null;
        observer = keydown = focusin = resize = mountToken = returnFocus = outsideFocus = panelAnchor = null;
        action = 'idle';
        actionError = '';
    }

    return {
        activate(context) {
            deactivate();
            context.onDeactivate(deactivate);
            return start(context, lifecycle);
        },
        deactivate
    };
})();
