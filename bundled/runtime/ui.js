(() => {
    const focusOwners = new WeakMap();
    const externalFocus = node => {
        const seen = new Set();
        while (node && !seen.has(node)) {
            seen.add(node);
            let owner = node;
            while (owner && !focusOwners.has(owner)) owner = owner.parentElement;
            if (!owner) return node;
            node = focusOwners.get(owner)();
        }
        return null;
    };
    return (context, appearance) => {
    'use strict';
    const error = (code, message) => Object.assign(new Error(message), { code });
    if (appearance?.api !== 1 || appearance.available !== true || typeof appearance.themeToken !== 'string' || !/^[a-zA-Z0-9_.@-]{1,128}$/.test(appearance.themeToken) || !appearance.roles || typeof appearance.roles !== 'object') throw error('ui_appearance_unavailable', 'A supported appearance contract is required');
    const entries = Object.entries(appearance.roles);
    if (entries.length > 64 || !entries.every(([role, variants]) => /^[a-zA-Z][a-zA-Z0-9]{0,63}$/.test(role) && Array.isArray(variants) && variants.length <= 32 && variants.every(variant => typeof variant === 'string' && /^[a-zA-Z][a-zA-Z0-9-]{0,63}$/.test(variant)))) throw error('invalid_ui_argument', 'Invalid appearance roles');
    const roles = new Map(entries.map(([role, variants]) => [role, new Set(variants)]));
    const nodes = new Map(), controllers = new Set(), timers = new Set(), listeners = new Set();
    const abort = new AbortController();
    const instance = `${context.pluginId}-${context.generation}-${crypto.randomUUID()}`;
    let alive = true, retiring = false, serial = 0;
    let outsideFocus = externalFocus(document.activeElement);
    const ownsFocus = node => [...nodes.keys()].some(owned => owned === node || owned.contains(node));
    const priorDisabled = new WeakMap();
    const assertLive = () => { if (!alive) throw error('ui_disposed', 'This UI owner has retired'); };
    const text = (value, label = 'text') => { if (typeof value !== 'string' || value.length > 65536) throw error('invalid_ui_argument', `${label} must be a bounded string`); return value; };
    const role = (node, name, variant = 'default') => {
        if (!roles.get(name)?.has(variant)) throw error('unsupported_ui_role', `Unsupported UI role ${name}/${variant}`);
        node.setAttribute('data-codlet-ui-role', name);
        node.setAttribute('data-codlet-ui-variant', variant);
    };
    function ownElement(node, options = {}) {
        assertLive();
        if (nodes.size >= 4096) throw error('ui_resource_limit', 'UI element limit reached');
        if (options.role) role(node, options.role, options.variant);
        if (options.text !== undefined) node.textContent = text(options.text);
        if (options.className !== undefined) node.className = text(options.className, 'className');
        node.setAttribute('data-codlet-ui-owner', `${instance}:${++serial}`);
        node.setAttribute('data-codlet-ui-theme', appearance.themeToken);
        nodes.set(node, new Set());
        focusOwners.set(node, () => outsideFocus);
        return node;
    }
    function createElement(tag, options = {}) { return ownElement(document.createElement(tag), options); }
    function element(tag, options = {}) {
        if (!['div', 'span', 'p', 'section', 'h1', 'h2', 'label', 'button', 'input', 'dialog', 'textarea', 'select', 'option', 'details', 'summary'].includes(tag)) throw error('invalid_ui_argument', 'Unsupported UI element');
        return createElement(tag, options);
    }
    function externalLink(options) {
        let url;
        try { url = new URL(text(options?.href, 'href')); } catch (_) { throw error('invalid_ui_argument', 'An absolute HTTPS URL is required'); }
        if (url.protocol !== 'https:' || url.username || url.password) throw error('invalid_ui_argument', 'An HTTPS URL without credentials is required');
        const caption = text(options?.text);
        if (!caption.trim()) throw error('invalid_ui_argument', 'A link requires visible text');
        const label = options?.label === undefined ? null : text(options.label, 'label');
        const node = createElement('a', { text: caption });
        node.setAttribute('href', url.href);
        node.setAttribute('target', '_blank');
        node.setAttribute('rel', 'noopener noreferrer');
        if (label !== null) node.setAttribute('aria-label', label);
        return node;
    }
    const iconPaths = Object.freeze({
        close: ['M6 6l12 12M6 18L18 6'],
        back: ['M19 12H5m6-6-6 6 6 6'],
        refresh: ['M20 7v5h-5', 'M20 12a8 8 0 1 1-2.3-5.7L20 9'],
        update: ['M12 16V4m-5 5 5-5 5 5', 'M5 16v4h14v-4'],
        restart: ['M20 6v6h-6', 'M20 12a8 8 0 1 1-3-6.25L20 8'],
        spinner: ['M20 12a8 8 0 1 1-8-8'],
        download: ['M12 4v12m-5-5 5 5 5-5', 'M5 16v4h14v-4'],
        import: ['M4 19V5h8l2 3h6v11H4', 'M12 11v6m-3-3 3 3 3-3'],
        folder: ['M3 19V5h7l3 3h8v3', 'M3 19l3-8h16l-3 8H3'],
        external: ['M14 4h6v6m0-6L10 14', 'M10 4H4v16h16v-6'],
        search: ['M16 16l5 5', 'M18 10a8 8 0 1 1-16 0 8 8 0 0 1 16 0']
    });
    function icon(name, { size = 16 } = {}) {
        if (!Object.hasOwn(iconPaths, name) || ![16, 18].includes(size)) throw error('invalid_ui_argument', 'Unsupported icon or size');
        const node = ownElement(document.createElementNS('http://www.w3.org/2000/svg', 'svg'));
        for (const [key, value] of Object.entries({ width: size, height: size, viewBox: '0 0 24 24', fill: 'none', stroke: 'currentColor', 'stroke-width': 1.6, 'stroke-linecap': 'round', 'stroke-linejoin': 'round', 'aria-hidden': 'true', focusable: 'false' })) node.setAttribute(key, String(value));
        node.style.flexShrink = '0';
        for (const d of iconPaths[name]) { const path = document.createElementNS('http://www.w3.org/2000/svg', 'path'); path.setAttribute('d', d); node.appendChild(path); }
        return node;
    }
    function backButton({ text: caption = 'Back', label = caption, onClick } = {}) {
        const node = button({ text: caption, label, onClick });
        node.textContent = '';
        node.appendChild(icon('back'));
        node.appendChild(element('span', { text: caption }));
        node.setAttribute('data-codlet-back-button', '');
        node.style.cssText = 'display:inline-flex;align-items:center;gap:6px;min-height:32px;padding:4px 0;border:0;background:transparent;box-shadow:none;align-self:flex-start;';
        return node;
    }
    function on(target, type, handler, options) {
        assertLive();
        if (typeof target?.addEventListener !== 'function' || typeof handler !== 'function') throw error('invalid_ui_argument', 'An event target and listener are required');
        if (listeners.size >= 8192) throw error('ui_resource_limit', 'UI listener limit reached');
        let active = true;
        const wrapped = event => {
            if (!alive || !active) return;
            if (options?.once) remove();
            return handler(event, abort.signal);
        };
        const remove = () => { if (!active) return; active = false; target.removeEventListener(type, wrapped, options); listeners.delete(remove); nodes.get(target)?.delete(remove); };
        target.addEventListener(type, wrapped, options); listeners.add(remove); nodes.get(target)?.add(remove);
        return remove;
    }
    function remove(node) {
        assertLive();
        if (!nodes.has(node)) throw error('ui_owner_mismatch', 'Only this UI owner can remove this element');
        for (const [child, cleanups] of [...nodes].reverse()) if (child === node || node.contains(child)) {
            for (const cleanup of [...cleanups]) cleanup();
            child.remove(); nodes.delete(child); focusOwners.delete(child);
        }
    }
    function button(options) {
        const node = element('button', { role: 'button', variant: options?.variant ?? 'default', text: options?.text ?? '' });
        node.type = 'button';
        if (options?.label != null) node.setAttribute('aria-label', text(options.label, 'label'));
        if (!node.textContent && !options?.label) { remove(node); throw error('invalid_ui_argument', 'A button requires text or an accessible label'); }
        node.disabled = options?.disabled === true;
        if (options?.onClick) on(node, 'click', event => { if (!node.disabled) return options.onClick(event, abort.signal); });
        return node;
    }
    function toggle(options) {
        if (!options?.label) throw error('invalid_ui_argument', 'A switch requires an accessible label');
        const node = element('input', { role: 'switch' });
        node.type = 'checkbox'; node.checked = options.checked === true; node.disabled = options.disabled === true;
        node.setAttribute('role', 'switch'); node.setAttribute('aria-label', text(options.label, 'label'));
        if (options.onChange) on(node, 'change', event => { if (!node.disabled) return options.onChange(node.checked, event, abort.signal); });
        return node;
    }
    function row(options) {
        const node = element('div', { role: 'row' }), copy = element('div', { role: 'copy' });
        const label = element('div', { role: 'label', text: options.label });
        const description = element('div', { role: 'description', text: options.description ?? '' });
        const controls = element('div', { role: 'actions' });
        description.hidden = !options.description;
        copy.appendChild(label); copy.appendChild(description); node.appendChild(copy); node.appendChild(controls);
        return Object.freeze({ element: node, copy, label, description, controls });
    }
    function status(options = {}) {
        const node = element('div', { role: 'status', variant: options.tone ?? 'default', text: options.text ?? '' });
        node.setAttribute('role', options.tone === 'error' ? 'alert' : 'status');
        node.setAttribute('aria-live', options.tone === 'error' ? 'assertive' : 'polite');
        return node;
    }
    function dialog(options) {
        const node = element('dialog', { role: 'dialog', variant: options.variant ?? 'settings' });
        const header = element('div', { role: 'dialogHeader' }), title = element('h1', { role: 'heading', text: options.title });
        title.id = `codlet-ui-title-${instance}-${serial}`;
        node.setAttribute('aria-labelledby', title.id); node.setAttribute('aria-modal', 'true');
        const closeButton = button({ text: '×', label: options.closeLabel ?? 'Close', variant: 'close' });
        const body = element('div', { role: 'dialogBody' }), actions = element('div', { role: 'dialogActions' });
        header.appendChild(title); header.appendChild(closeButton); node.appendChild(header); node.appendChild(body); body.appendChild(actions);
        node.hidden = true;
        let session = null;
        const finish = reason => {
            if (!session) { node.hidden = true; return; }
            const current = session; session = null;
            node.hidden = true;
            if (current.restore && current.trigger?.isConnected) current.trigger.focus({ preventScroll: true });
            if (alive && !retiring) options.onClose?.(reason);
        };
        const close = (reason = 'close') => {
            if (!session && !node.open) return false;
            if (session) session.restore = node.contains(document.activeElement) || document.activeElement === document.body;
            if (node.open) node.close();
            finish(reason); return true;
        };
        const requestClose = reason => { if (options.onRequestClose?.(reason) !== false) close(reason); };
        on(closeButton, 'click', () => requestClose('button'));
        on(node, 'keydown', event => {
            if (event.key !== 'Escape' || event.defaultPrevented || event.isComposing || event.altKey || event.ctrlKey || event.metaKey || event.shiftKey) return;
            event.preventDefault(); event.stopPropagation(); requestClose('escape');
        });
        on(node, 'cancel', event => { event.preventDefault(); event.stopPropagation(); requestClose('escape'); });
        on(node, 'close', () => {
            if (node.open) return;
            if (session) session.restore = node.contains(document.activeElement) || document.activeElement === document.body;
            finish('native');
        });
        on(node, 'pointerdown', event => {
            if (event.target !== node || event.button !== 0 || event.defaultPrevented) return;
            const box = node.getBoundingClientRect();
            if (event.clientX >= box.left && event.clientX <= box.right && event.clientY >= box.top && event.clientY <= box.bottom) return;
            event.preventDefault(); event.stopPropagation(); requestClose('backdrop');
        });
        const controller = {
            element: node, header, title, body, actions, closeButton,
            show({ trigger = document.activeElement, initialFocus = closeButton } = {}) {
                assertLive(); if (node.open) return false;
                if (!nodes.has(node)) throw error('ui_disposed', 'This dialog has retired');
                if (trigger != null && typeof trigger.focus !== 'function') throw error('invalid_ui_argument', 'Invalid focus return target');
                if (initialFocus != null && !node.contains(initialFocus)) throw error('ui_owner_mismatch', 'Initial focus must belong to this dialog');
                if (!node.isConnected) document.body.appendChild(node);
                session = { trigger, restore: true }; node.hidden = false;
                controllers.delete(controller); controllers.add(controller);
                try { node.showModal(); initialFocus?.focus({ preventScroll: true }); }
                catch (failure) { finish('failed'); throw failure; }
                return true;
            },
            close,
            dispose() { close('dispose'); controllers.delete(controller); if (nodes.has(node)) remove(node); }
        };
        controllers.add(controller);
        nodes.get(node).add(() => { close('dispose'); controllers.delete(controller); });
        return Object.freeze(controller);
    }
    function busy(node, value) {
        assertLive(); if (!nodes.has(node)) throw error('ui_owner_mismatch', 'Unknown UI control');
        if (value === true && !priorDisabled.has(node)) priorDisabled.set(node, node.disabled);
        node.setAttribute('aria-busy', String(value === true));
        if ('disabled' in node) node.disabled = value === true ? true : priorDisabled.get(node) ?? node.disabled;
        if (value !== true) priorDisabled.delete(node);
    }
    function after(delay, callback) {
        assertLive(); if (!Number.isFinite(delay) || delay < 0 || delay > 60000 || typeof callback !== 'function') throw error('invalid_ui_argument', 'Expected a callback and delay in 0..60000');
        if (timers.size >= 64) throw error('ui_resource_limit', 'UI timer limit reached');
        const timer = setTimeout(() => { timers.delete(timer); if (alive) callback(abort.signal); }, delay);
        timers.add(timer); return () => { clearTimeout(timer); timers.delete(timer); };
    }
    function dispose() {
        if (!alive || retiring) return;
        retiring = true;
        const restore = ownsFocus(document.activeElement);
        let failure;
        // Close modal boundaries before removing their DOM and listeners.
        for (const controller of [...controllers].reverse()) { try { controller.close('dispose'); } catch (error) { failure ??= error; } }
        alive = false; abort.abort();
        for (const timer of timers) clearTimeout(timer);
        timers.clear();
        for (const cleanup of [...listeners]) { try { cleanup(); } catch (error) { failure ??= error; } }
        for (const [node] of [...nodes].reverse()) { try { node.remove(); } catch (error) { failure ??= error; } focusOwners.delete(node); }
        nodes.clear(); controllers.clear(); unregister();
        if (restore && outsideFocus?.isConnected) { try { outsideFocus.focus({ preventScroll: true }); } catch (error) { failure ??= error; } }
        if (failure) throw failure;
    }
    const unregister = context.onDeactivate(dispose);
    try { on(document, 'focusin', event => { if (!ownsFocus(event.target)) outsideFocus = externalFocus(event.target); }); }
    catch (failure) { dispose(); throw failure; }
    return Object.freeze({ api: 1, signal: abort.signal, element, on, remove, button, icon, backButton, externalLink, switch: toggle, row, status, dialog, busy, after, dispose });
    };
})()
