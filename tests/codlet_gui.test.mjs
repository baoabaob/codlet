import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import vm from 'node:vm';
import test from 'node:test';

const source = readFileSync(new URL('../bundled/codlet/dist/renderer.js', import.meta.url), 'utf8');
const token = 'codex.ui.titlebar.afterMenu@1';
const deferred = () => {
    let resolve, reject;
    const promise = new Promise((done, fail) => { resolve = done; reject = fail; });
    return { promise, resolve, reject };
};

test('a timed-out plugin list shows a retry action and a later refresh can succeed', async () => {
    const f = fixture();
    await f.plugin.activate(f.context);
    f.override('list', () => { throw Object.assign(new Error('RPC deadline'), { code: 'rpc_timeout' }); });
    await f.open();
    assert.equal(f.byClass('codlet-status').textContent, 'Plugin list timed out. Refresh to try again.');
    assert.equal(f.byClass('codlet-plugin-list').getAttribute('aria-busy'), 'false');
    f.override('list', () => ({ plugins: [{ id: 'recovered' }] }));
    await f.refresh().emit('click');
    assert.equal(f.byClass('codlet-plugin-list').hidden, false);
    f.plugin.deactivate();
});

function fixture({ mounted = true, ready = true } = {}) {
    let mutations = 0;
    let layoutReads = 0;
    const observers = new Set();
    const modalDialogs = new Set();
    const closeEvents = [];
    class Target {
        constructor() { this.listeners = new Map(); }
        addEventListener(name, listener, options) {
            if (!listener) return;
            const handlers = this.listeners.get(name) ?? new Map();
            handlers.set(listener, options);
            this.listeners.set(name, handlers);
        }
        removeEventListener(name, listener) { this.listeners.get(name)?.delete(listener); }
        async emit(name, options = {}) {
            const event = {
                target: this, defaultPrevented: false, stopped: false, ...options,
                preventDefault() { this.defaultPrevented = true; },
                stopPropagation() { this.stopped = true; }
            };
            const path = [this];
            let parent = this.parentElement;
            while (parent) { path.push(parent); parent = parent.parentElement; }
            if (this.isConnected) path.push(document);
            const pending = [];
            for (const target of path) {
                for (const [listener, config] of target.listeners.get(name) ?? []) {
                    if (config?.once) target.removeEventListener(name, listener);
                    pending.push(listener(event));
                }
                if (event.stopped) break;
            }
            await Promise.all(pending);
            return event;
        }
        listenerCount() { return [...this.listeners.values()].reduce((sum, handlers) => sum + handlers.size, 0); }
    }
    class Element extends Target {
        constructor(tag) {
            super();
            this.tagName = tag;
            this.children = [];
            this.parentElement = null;
            this.attributes = new Map();
            this.style = new Proxy({ setProperty(property, value) { this[property] = value; } }, {
                set(target, property, value) { mutations++; target[property] = value; return true; }
            });
            this.className = '';
            this.text = '';
            this.bottom = 36;
            for (const property of ['hidden', 'checked', 'disabled', 'open']) {
                let value = false;
                Object.defineProperty(this, property, {
                    get() { return value; },
                    set(next) { mutations++; value = next; }
                });
            }
        }
        set textContent(value) { mutations++; this.replaceChildren(); this.text = String(value); }
        get textContent() { return this.text + this.children.map(child => child.textContent).join(' '); }
        get isConnected() { return this === document.documentElement || this.parentElement?.isConnected === true; }
        contains(element) { return element === this || this.children.some(child => child.contains(element)); }
        appendChild(child) {
            mutations++;
            child.remove();
            child.parentElement = this;
            this.children.push(child);
            return child;
        }
        replaceChildren(...children) {
            mutations++;
            for (const child of [...this.children]) child.remove();
            this.text = '';
            for (const child of children) this.appendChild(child);
        }
        remove() {
            mutations++;
            if (this.parentElement) {
                if (this.contains(document.activeElement)) document.activeElement = document.body;
                const siblings = this.parentElement.children;
                siblings.splice(siblings.indexOf(this), 1);
                this.parentElement = null;
            }
        }
        setAttribute(name, value) { mutations++; this.attributes.set(name, String(value)); }
        getAttribute(name) { return this.attributes.get(name) ?? null; }
        removeAttribute(name) { mutations++; this.attributes.delete(name); }
        focus() {
            if (!this.isConnected || this.disabled) return;
            const modal = [...modalDialogs].at(-1);
            if (modal && !modal.contains(this)) return;
            let ancestor = this;
            while (ancestor) { if (ancestor.hidden) return; ancestor = ancestor.parentElement; }
            document.activeElement = this;
            this.emit('focusin');
        }
        showModal() {
            if (!this.isConnected) throw new Error('Dialog is not connected');
            if (this.showModalError) throw new Error(this.showModalError);
            this.open = true;
            modalDialogs.add(this);
        }
        close() {
            if (!this.open) return;
            this.open = false;
            modalDialogs.delete(this);
            closeEvents.push(() => this.emit('close'));
        }
        getBoundingClientRect() {
            layoutReads++;
            return this.tagName === 'dialog' ? { left: 100, right: 700, top: 100, bottom: 500 } : { bottom: this.bottom };
        }
    }
    function descendants(root) { return root.children.flatMap(child => [child, ...descendants(child)]); }
    const document = new Target();
    document.documentElement = new Element('html');
    const body = new Element('body');
    document.body = ready ? body : null;
    document.activeElement = body;
    document.createElement = tag => new Element(tag);
    document.createTextNode = text => { const node = new Element('#text'); node.textContent = text; return node; };
    document.createElementNS = (_namespace, tag) => new Element(tag);
    document.querySelectorAll = selector => {
        assert.equal(selector, '[data-codlet-capability]');
        return descendants(document.documentElement).filter(element => element.attributes.has('data-codlet-capability'));
    };
    document.documentElement.appendChild(body);
    const toolbar = body.appendChild(new Element('div'));
    const mount = new Element('div');
    mount.setAttribute('data-codlet-capability', token);
    if (mounted) toolbar.appendChild(mount);
    const editor = body.appendChild(new Element('textarea'));
    editor.focus();
    const window = new Target();
    const scope = {
        module: { exports: {} }, document, Error, innerHeight: 720,
        MutationObserver: class {
            constructor(callback) { this.callback = callback; }
            observe() { observers.add(this); }
            disconnect() { observers.delete(this); }
        },
        addEventListener: window.addEventListener.bind(window),
        removeEventListener: window.removeEventListener.bind(window),
        confirm() { throw new Error('Global confirm must not be used'); }
    };
    vm.runInNewContext(source, scope, { filename: 'codlet-renderer.js' });
    const plugin = scope.module.exports;
    let active = false;
    const overrides = {};
    const calls = [];
    const context = {
        pluginId: 'codlet-gui', generation: 1,
        rpc: { async request(capability, method, args) {
            const name = method === 'ping' ? 'codlet.runtime.ping'
                : method === 'getMount' ? 'codex.ui.titlebar.afterMenu' : 'codlet.runtime.manage';
            assert.deepEqual(JSON.parse(JSON.stringify(capability)), { name, api: 1, scope: 'target' });
            assert.equal(args, null);
            calls.push(method);
            if (overrides[method]) return overrides[method]();
            if (method === 'ping') return { pong: true, abi: 1 };
            if (method === 'getMount') return { available: mount.isConnected, token };
            if (method === 'list') return { plugins: [
                { id: 'codlet-gui', version: '1', source: 'bundled', enabled: true, active, validation: { status: 'ok' } },
                { id: 'dev.broken', version: null, source: 'local', path: 'C:/fixture/missing', enabled: false, active: false,
                    validation: { status: 'failed', error: { message: 'Missing renderer entry' } } }
            ] };
            if (method === 'disableSelf') {
                plugin.deactivate();
                return { pluginId: 'codlet-gui', enabled: false };
            }
            throw new Error('Unexpected method');
        } }
    };
    const nodes = () => descendants(document.documentElement);
    const byClass = className => nodes().find(element => element.className === className);
    const control = label => nodes().find(element => element.getAttribute('aria-label') === label);
    return {
        plugin, context, calls, document, mount, toolbar, editor, window,
        nodes, byClass, control,
        button: () => nodes().find(element => element.attributes.has('data-codlet-titlebar-button')),
        panel: () => nodes().find(element => element.attributes.has('data-codlet-panel')),
        refresh: () => control('Refresh plugins'),
        close: () => control('Close Codlet'),
        toggle: () => control('Enable Codlet GUI'),
        confirm: () => byClass('codlet-confirm'),
        cancel: () => nodes().find(element => element.tagName === 'button' && element.textContent === 'Cancel'),
        setActive(value) { active = value; },
        override(method, handler) { overrides[method] = handler; },
        mutations: () => mutations,
        layoutReads: () => layoutReads,
        observerCount: () => observers.size,
        modalCount: () => modalDialogs.size,
        async flushCloseEvents() { for (const notify of closeEvents.splice(0)) await notify(); },
        flushObserver() { for (const observer of observers) observer.callback(); },
        async ready() { document.body = body; await document.emit('DOMContentLoaded'); },
        async open() { this.button().focus(); await this.button().emit('click'); },
        async requestDisable() { this.toggle().focus(); this.toggle().checked = false; await this.toggle().emit('change'); }
    };
}

test('activation mounts before list; opening uses the current Host Active snapshot', async () => {
    const f = fixture();
    await f.plugin.activate(f.context);
    assert.deepEqual(f.calls, ['ping', 'getMount']);
    assert.equal(f.toggle(), undefined);
    await f.open();
    assert.match(f.panel().textContent, /Not active/);
    assert.equal(f.toggle(), undefined);
    await f.close().emit('click');
    f.setActive(true);
    await f.open();
    assert.ok(f.toggle());
    assert.doesNotMatch(f.panel().textContent, /undefined|null|Runtime connected/);
    assert.match(f.panel().textContent, /Missing renderer entry/);
    assert.equal(f.panel().getAttribute('role'), 'dialog');
    assert.equal(f.panel().tagName, 'dialog');
    assert.equal(f.panel().getAttribute('aria-modal'), 'true');
    assert.equal(f.panel().open, true);
    assert.equal(f.modalCount(), 1);
    assert.equal(f.panel().getAttribute('data-codlet-ui-theme'), token);
    assert.equal(f.panel().getAttribute('data-codlet-generation'), '1');
    assert.equal(f.button().getAttribute('aria-controls'), f.panel().id);
    assert.equal(f.button().getAttribute('aria-haspopup'), 'dialog');
    assert.equal(f.button().getAttribute('aria-expanded'), 'true');
    f.plugin.deactivate();
});

test('the first list failure leaves an entry and recovers through the visible refresh control', async () => {
    const f = fixture();
    const pending = deferred();
    f.override('list', () => pending.promise);
    await f.plugin.activate(f.context);
    const opening = f.open();
    assert.equal(f.panel().hidden, false);
    assert.match(f.byClass('codlet-status').textContent, /Loading plugins/);
    assert.equal(f.byClass('codlet-plugin-list').getAttribute('aria-busy'), 'true');
    pending.reject(new Error('List failed'));
    await opening;
    assert.ok(f.button());
    assert.equal(f.byClass('codlet-status').textContent, 'List failed');
    assert.equal(f.byClass('codlet-plugin-list').getAttribute('aria-busy'), 'false');
    f.override('list', undefined);
    f.setActive(true);
    await f.refresh().emit('click');
    assert.ok(f.toggle());
    assert.equal(f.byClass('codlet-status').hidden, true);
    f.plugin.deactivate();
});

test('empty and malformed lists report honest recoverable states', async () => {
    const f = fixture();
    await f.plugin.activate(f.context);
    for (const invalid of [null, {}, { plugins: null }, { plugins: [null] }, { plugins: [{ id: '' }] }]) {
        f.override('list', () => invalid);
        await f.open();
        assert.equal(f.byClass('codlet-status').textContent, 'Plugin list unavailable');
        assert.equal(f.byClass('codlet-plugin-list').hidden, true);
        await f.close().emit('click');
    }
    f.override('list', () => ({ plugins: [] }));
    await f.open();
    assert.equal(f.byClass('codlet-status').textContent, 'No plugins');
    assert.equal(f.byClass('codlet-plugin-list').hidden, false);
    f.plugin.deactivate();
});

test('refresh removes forgotten rows and distinguishes an unregistered loaded plugin', async () => {
    const f = fixture();
    let rows = [
        { id: 'codlet-gui', enabled: true, active: true, source: 'bundled' },
        { id: 'dev.removed', enabled: false, active: false, source: 'local' }
    ];
    f.override('list', () => ({ plugins: rows }));
    await f.plugin.activate(f.context);
    await f.open();
    assert.match(f.panel().textContent, /codlet-gui/);
    assert.match(f.panel().textContent, /dev\.removed/);
    rows = [rows[0],
        { id: 'dev.still-running', enabled: false, active: true, loaded: true, registered: false,
            source: 'local', loadedPath: 'C:/fixture/loaded', validation: { status: 'ok' } },
        { id: 'dev.new', enabled: true, active: false, loaded: false, registered: true,
            source: 'local', validation: { status: 'not_loaded' } }
    ];
    await f.refresh().emit('click');
    assert.doesNotMatch(f.panel().textContent, /dev\.removed/);
    assert.match(f.panel().textContent, /dev\.still-running/);
    assert.match(f.panel().textContent, /Registration removed; still loaded/);
    assert.match(f.panel().textContent, /Registered, not loaded/);
    assert.doesNotMatch(f.panel().textContent, /Plugin validation failed/);
    const unregisteredRow = f.nodes().find(element => element.className === 'codlet-plugin-row' && element.textContent.includes('dev.still-running'));
    assert.equal(unregisteredRow.children[0].title, 'C:/fixture/loaded');
    await f.requestDisable();
    assert.match(f.panel().textContent, /codlet plugin enable codlet-gui/);
    f.plugin.deactivate();
});

test('host execution observations show lifecycle and errors without adding controls to renderer rows', async () => {
    const f = fixture();
    const rows = [
        { id: 'codlet-gui', enabled: true, active: true, source: 'bundled' },
        { id: 'dev.starting', enabled: true, active: false, execution: { kind: 'host', state: 'starting', processId: 41, error: null } },
        { id: 'dev.stopping', enabled: false, active: false, loaded: true, registered: false,
            execution: { kind: 'host', state: 'stopping', processId: 45, error: 'Stopping after worker failure' } },
        { id: 'dev.running', enabled: false, active: true, loaded: true, registered: false,
            execution: { kind: 'host', state: 'active', processId: 42, error: null } },
        { id: 'dev.combined-waiting', enabled: true, active: false,
            execution: { kind: 'host', state: 'active', rendererActive: false, processId: 46, error: null } },
        { id: 'dev.combined-active', enabled: true, active: true,
            execution: { kind: 'host', state: 'active', rendererActive: true, processId: 47, error: null } },
        { id: 'dev.failed', enabled: true, active: false, loaded: false,
            validation: { status: 'failed', error: { message: 'Older catalog problem' } },
            execution: { kind: 'host', state: 'failed', processId: 43, error: 'Worker exited with code 12' } },
        { id: 'dev.exited', enabled: true, active: false, loaded: false,
            execution: { kind: 'host', state: 'exited', processId: 44, error: null } },
        { id: 'dev.renderer', enabled: false, active: false,
            validation: { status: 'failed', error: { message: 'Missing renderer entry' } } }
    ];
    f.override('list', () => ({ plugins: rows }));
    await f.plugin.activate(f.context);
    await f.open();
    const pluginRow = id => f.nodes().find(element => element.className === 'codlet-plugin-row'
        && element.children[0].textContent.includes(id));
    for (const [id, state] of [['dev.starting', 'Starting'], ['dev.stopping', 'Stopping'], ['dev.running', 'Active'], ['dev.combined-waiting', 'Waiting for renderer'], ['dev.combined-active', 'Active'], ['dev.failed', 'Failed'], ['dev.exited', 'Exited'], ['dev.renderer', 'Unavailable']]) {
        assert.equal(pluginRow(id).children.at(-1).textContent, state);
        assert.equal(pluginRow(id).children.some(element => element.tagName === 'input'), false);
    }
    assert.match(pluginRow('dev.running').textContent, /Registration removed; still loaded/);
    assert.match(pluginRow('dev.stopping').textContent, /Registration removed; still loaded/);
    assert.match(pluginRow('dev.stopping').textContent, /Stopping after worker failure/);
    assert.match(pluginRow('dev.failed').textContent, /Worker exited with code 12/);
    assert.doesNotMatch(pluginRow('dev.failed').textContent, /Older catalog problem/);
    assert.match(pluginRow('dev.renderer').textContent, /Missing renderer entry/);
    assert.ok(f.toggle());
    assert.deepEqual(f.calls, ['ping', 'getMount', 'list']);
    f.plugin.deactivate();
});

test('overlapping refreshes commit only the latest response without moving focus', async () => {
    const f = fixture();
    await f.plugin.activate(f.context);
    const old = deferred();
    f.override('list', () => old.promise);
    const opening = f.open();
    f.override('list', () => ({ plugins: [{ id: 'latest', active: true }] }));
    await f.refresh().emit('click');
    f.refresh().focus();
    const mutations = f.mutations();
    old.resolve({ plugins: [{ id: 'obsolete' }] });
    await opening;
    assert.equal(f.mutations(), mutations);
    assert.match(f.panel().textContent, /latest/);
    assert.doesNotMatch(f.panel().textContent, /obsolete/);
    assert.equal(f.document.activeElement, f.refresh());
    f.plugin.deactivate();
});

test('closing and reopening invalidates both old list successes and failures', async () => {
    for (const fails of [false, true]) {
        const f = fixture();
        await f.plugin.activate(f.context);
        const old = deferred();
        f.override('list', () => old.promise);
        const opening = f.open();
        await f.close().emit('click');
        assert.equal(f.panel().hidden, true);
        f.override('list', () => ({ plugins: [{ id: 'reopened' }] }));
        await f.open();
        const mutations = f.mutations();
        if (fails) old.reject(new Error('Obsolete failure'));
        else old.resolve({ plugins: [] });
        await opening;
        assert.equal(f.mutations(), mutations);
        assert.equal(f.panel().hidden, false);
        assert.match(f.panel().textContent, /reopened/);
        f.plugin.deactivate();
    }
});

test('unload and reactivation reject list callbacks from the old lifecycle', async () => {
    const f = fixture();
    await f.plugin.activate(f.context);
    const old = deferred();
    f.override('list', () => old.promise);
    const opening = f.open();
    f.plugin.deactivate();
    f.override('list', undefined);
    await f.plugin.activate({ ...f.context, generation: 2 });
    await f.open();
    const mutations = f.mutations();
    old.resolve({ plugins: [{ id: 'obsolete' }] });
    await opening;
    assert.equal(f.mutations(), mutations);
    assert.equal(f.panel().getAttribute('data-codlet-generation'), '2');
    assert.doesNotMatch(f.panel().textContent, /obsolete/);
    f.plugin.deactivate();
});

test('unload during startup cancels stale ping and getMount continuations', async () => {
    for (const method of ['ping', 'getMount']) {
        const f = fixture();
        const waiting = deferred();
        const entered = deferred();
        f.override(method, () => { entered.resolve(); return waiting.promise; });
        const activation = f.plugin.activate(f.context);
        await entered.promise;
        f.plugin.deactivate();
        const mutations = f.mutations();
        waiting.resolve(method === 'ping' ? { pong: true, abi: 1 } : { available: true, token });
        await activation;
        assert.equal(f.mutations(), mutations);
        assert.equal(f.panel(), undefined);
        assert.equal(f.observerCount(), 0);
        assert.equal(f.document.listenerCount(), 0);
        assert.equal(f.window.listenerCount(), 0);
    }
});

test('unload cancels the DOMContentLoaded wait without leaving a listener', async () => {
    const f = fixture({ ready: false });
    const activation = f.plugin.activate(f.context);
    assert.equal(f.document.listenerCount(), 1);
    f.plugin.deactivate();
    await activation;
    assert.equal(f.document.listenerCount(), 0);
    assert.deepEqual(f.calls, []);
    await f.ready();
    assert.equal(f.panel(), undefined);
});

test('mount negotiation rejects an unknown token without guessing another mount', async () => {
    const f = fixture();
    f.override('getMount', () => ({ available: true, token: 'unknown@1' }));
    await f.plugin.activate(f.context);
    assert.equal(f.button(), undefined);
    assert.equal(f.panel(), undefined);
    assert.equal(f.observerCount(), 0);
});

test('available:false with a valid token waits for a late mount without polling', async () => {
    const f = fixture({ mounted: false });
    await f.plugin.activate(f.context);
    assert.ok(f.panel());
    assert.equal(f.panel().hidden, true);
    assert.equal(f.button(), undefined);
    assert.equal(f.observerCount(), 1);
    f.toolbar.appendChild(f.mount);
    f.flushObserver();
    assert.equal(f.button().parentElement, f.mount);
    await f.open();
    assert.equal(f.panel().style.top, '36px');
    assert.equal(f.calls.filter(method => method === 'getMount').length, 1);
    f.plugin.deactivate();
    f.flushObserver();
    assert.equal(f.button(), undefined);
});

test('a connected stale mount is replaced, and reparenting the same mount relayouts the open panel', async () => {
    const f = fixture();
    f.toolbar.bottom = 84;
    await f.plugin.activate(f.context);
    await f.open();
    const button = f.button();
    const close = f.close();
    assert.equal(f.panel().style.top, '84px');
    const menuLine = f.document.body.appendChild(f.document.createElement('div'));
    menuLine.bottom = 36;
    menuLine.appendChild(f.mount);
    f.flushObserver();
    assert.equal(f.panel().style.top, '36px');
    assert.equal(f.panel().hidden, false);
    assert.equal(f.document.activeElement, close);
    const reads = f.layoutReads();
    f.document.body.appendChild(f.document.createElement('div'));
    f.flushObserver();
    assert.equal(f.layoutReads(), reads, 'unrelated host DOM updates do not force layout');
    f.mount.removeAttribute('data-codlet-capability');
    const replacement = menuLine.appendChild(f.document.createElement('div'));
    replacement.setAttribute('data-codlet-capability', token);
    f.flushObserver();
    assert.equal(f.mount.isConnected, true);
    assert.equal(f.button(), button);
    assert.equal(button.parentElement, replacement);
    assert.equal(f.document.activeElement, close);
    f.plugin.deactivate();
});

test('mount removal closes the panel, restores external focus, and can recover later', async () => {
    const f = fixture();
    await f.plugin.activate(f.context);
    await f.open();
    const button = f.button();
    f.mount.remove();
    f.flushObserver();
    assert.equal(f.panel().hidden, true);
    assert.equal(f.document.activeElement, f.editor);
    f.toolbar.appendChild(f.mount);
    f.flushObserver();
    assert.equal(f.button(), button);
    await f.open();
    assert.equal(f.panel().hidden, false);
    f.plugin.deactivate();
});

test('Escape is consumed locally before an earlier host document handler, restoring opener focus', async () => {
    const f = fixture();
    let hostEscapes = 0;
    f.document.addEventListener('keydown', event => { if (event.key === 'Escape') hostEscapes++; });
    await f.plugin.activate(f.context);
    await f.open();
    assert.equal(f.document.activeElement, f.close());
    const event = await f.close().emit('keydown', { key: 'Escape' });
    assert.equal(event.defaultPrevented, true);
    assert.equal(hostEscapes, 0);
    assert.equal(f.panel().hidden, true);
    assert.equal(f.document.activeElement, f.button());
    assert.equal(f.button().getAttribute('aria-expanded'), 'false');
    await f.open();
    f.editor.focus();
    const external = await f.editor.emit('keydown', { key: 'Escape' });
    assert.equal(external.defaultPrevented, false);
    assert.equal(hostEscapes, 1);
    assert.equal(f.panel().hidden, false);
    f.plugin.deactivate();
});

test('handled, modified, composing and unrelated keys remain available to the host', async () => {
    const f = fixture();
    let hostKeys = 0;
    f.document.addEventListener('keydown', () => hostKeys++);
    await f.plugin.activate(f.context);
    await f.open();
    for (const options of [
        { key: 'Escape', defaultPrevented: true }, { key: 'Escape', isComposing: true },
        { key: 'Escape', ctrlKey: true }, { key: 'Escape', metaKey: true },
        { key: 'Escape', altKey: true }, { key: 'Escape', shiftKey: true },
        { key: 'Tab' }, { key: 'Tab', shiftKey: true }, { key: 'k', ctrlKey: true }
    ]) {
        const event = await f.close().emit('keydown', options);
        assert.equal(event.stopped, false);
        assert.equal(f.panel().hidden, false);
    }
    assert.equal(hostKeys, 9);
    f.plugin.deactivate();
});

test('close restores a surviving opener; removal falls back to the entry', async () => {
    const f = fixture();
    await f.plugin.activate(f.context);
    await f.button().emit('click');
    await f.close().emit('click');
    assert.equal(f.document.activeElement, f.editor);
    await f.button().emit('click');
    f.editor.remove();
    await f.close().emit('click');
    assert.equal(f.document.activeElement, f.button());
    f.plugin.deactivate();
});

test('closing or unloading preserves a newer host modal and its focus', async () => {
    const f = fixture();
    await f.plugin.activate(f.context);
    await f.open();
    const hostModal = f.document.body.appendChild(f.document.createElement('dialog'));
    const hostInput = hostModal.appendChild(f.document.createElement('input'));
    hostModal.showModal();
    hostInput.focus();
    await f.close().emit('click');
    assert.equal(f.document.activeElement, hostInput);
    assert.equal(hostModal.open, true);
    hostModal.close();
    await f.open();
    hostModal.showModal();
    hostInput.focus();
    f.plugin.deactivate();
    assert.equal(f.document.activeElement, hostInput);
    assert.equal(hostModal.open, true);
    assert.equal(f.observerCount(), 0);
    assert.equal(f.document.listenerCount(), 0);
    assert.equal(f.window.listenerCount(), 0);
    hostModal.close();
});

test('inline disable confirmation preserves enabled state, and Escape first cancels only confirmation', async () => {
    const f = fixture();
    await f.plugin.activate(f.context);
    f.setActive(true);
    await f.open();
    const toggle = f.toggle();
    await f.requestDisable();
    assert.equal(toggle.checked, true);
    assert.equal(f.document.activeElement, f.cancel());
    assert.equal(f.byClass('codlet-confirmation').hidden, false);
    assert.equal(f.calls.includes('disableSelf'), false);
    await f.cancel().emit('keydown', { key: 'Escape' });
    assert.equal(f.panel().hidden, false);
    assert.equal(f.byClass('codlet-confirmation').hidden, true);
    assert.equal(toggle.disabled, false);
    assert.equal(f.document.activeElement, toggle);
    await f.requestDisable();
    await f.cancel().emit('click');
    assert.equal(f.calls.includes('disableSelf'), false);
    assert.equal(f.document.activeElement, toggle);
    f.plugin.deactivate();
    assert.equal(f.document.activeElement, f.editor);
});

test('disable is sent once while pending, shows failure, and supports explicit retry', async () => {
    const f = fixture();
    await f.plugin.activate(f.context);
    f.setActive(true);
    await f.open();
    await f.requestDisable();
    const pending = deferred();
    f.override('disableSelf', () => pending.promise);
    f.confirm().focus();
    const disabling = f.confirm().emit('click');
    assert.equal(f.confirm().disabled, true);
    assert.equal(f.cancel().disabled, true);
    assert.equal(f.refresh().disabled, true);
    assert.equal(f.document.activeElement, f.close());
    await f.confirm().emit('click');
    await f.refresh().emit('click');
    assert.equal(f.calls.filter(method => method === 'disableSelf').length, 1);
    assert.equal(f.calls.filter(method => method === 'list').length, 1);
    pending.reject(new Error('Registry write failed'));
    await disabling;
    assert.match(f.byClass('codlet-confirmation').textContent, /Registry write failed/);
    assert.equal(f.confirm().disabled, false);
    assert.equal(f.toggle().checked, true);
    f.override('disableSelf', undefined);
    f.confirm().focus();
    await f.confirm().emit('click');
    assert.equal(f.calls.filter(method => method === 'disableSelf').length, 2);
    assert.equal(f.panel(), undefined);
    assert.equal(f.document.activeElement, f.editor);
});

test('a disable error arriving while closed is saved for reopen without touching hidden DOM', async () => {
    const f = fixture();
    await f.plugin.activate(f.context);
    f.setActive(true);
    await f.open();
    await f.requestDisable();
    const pending = deferred();
    f.override('disableSelf', () => pending.promise);
    const disabling = f.confirm().emit('click');
    await f.close().emit('click');
    const mutations = f.mutations();
    pending.reject(new Error('Write failed while closed'));
    await disabling;
    assert.equal(f.mutations(), mutations);
    await f.open();
    assert.match(f.byClass('codlet-confirmation').textContent, /Write failed while closed/);
    assert.equal(f.calls.filter(method => method === 'disableSelf').length, 1);
    assert.equal(f.calls.filter(method => method === 'list').length, 1);
    f.plugin.deactivate();
});

test('old disable responses cannot mutate or poison a reactivated GUI', async () => {
    for (const fails of [true, false]) {
        const f = fixture();
        await f.plugin.activate(f.context);
        f.setActive(true);
        await f.open();
        await f.requestDisable();
        const pending = deferred();
        f.override('disableSelf', () => pending.promise);
        const disabling = f.confirm().emit('click');
        f.plugin.deactivate();
        await f.plugin.activate({ ...f.context, generation: 2 });
        await f.open();
        const mutations = f.mutations();
        if (fails) pending.reject(new Error('Old disable failure'));
        else pending.resolve({ pluginId: 'codlet-gui', enabled: false });
        await disabling;
        assert.equal(f.mutations(), mutations);
        assert.equal(f.byClass('codlet-confirmation').hidden, true);
        assert.equal(f.refresh().disabled, false);
        assert.equal(f.toggle().disabled, false);
        f.plugin.deactivate();
    }
});

test('an unconfirmed disable response is not displayed as success', async () => {
    const f = fixture();
    await f.plugin.activate(f.context);
    f.setActive(true);
    await f.open();
    await f.requestDisable();
    f.override('disableSelf', () => ({ enabled: true }));
    await f.confirm().emit('click');
    assert.match(f.byClass('codlet-confirmation').textContent, /Disable was not confirmed/);
    assert.equal(f.confirm().disabled, false);
    f.plugin.deactivate();
});

test('native modal lifecycle releases its top layer on close and on pending-request unload', async () => {
    const f = fixture();
    await f.plugin.activate(f.context);
    assert.equal(f.panel().open, false);
    assert.equal(f.panel().hidden, true);
    await f.open();
    f.editor.focus();
    assert.equal(f.document.activeElement, f.close(), 'the browser modal keeps the host inert');
    await f.close().emit('click');
    assert.equal(f.modalCount(), 0);
    assert.equal(f.panel().open, false);
    assert.equal(f.panel().hidden, true);
    assert.equal(f.document.activeElement, f.button());
    const pending = deferred();
    f.override('list', () => pending.promise);
    const opening = f.open();
    const oldPanel = f.panel();
    assert.equal(f.modalCount(), 1);
    f.plugin.deactivate();
    assert.equal(f.modalCount(), 0);
    assert.equal(oldPanel.open, false);
    assert.equal(oldPanel.hidden, true);
    assert.equal(f.document.activeElement, f.editor);
    const mutations = f.mutations();
    pending.resolve({ plugins: [] });
    await opening;
    await f.flushCloseEvents();
    assert.equal(f.mutations(), mutations);
});

test('showModal failure and a detached dialog do not publish expanded state or issue list requests', async () => {
    const f = fixture();
    await f.plugin.activate(f.context);
    const panel = f.panel();
    panel.showModalError = 'Modal opening failed';
    await f.open();
    assert.equal(f.modalCount(), 0);
    assert.equal(panel.open, false);
    assert.equal(panel.hidden, true);
    assert.equal(f.button().getAttribute('aria-expanded'), 'false');
    assert.match(f.button().title, /Modal opening failed/);
    assert.equal(f.document.activeElement, f.button());
    assert.equal(f.calls.includes('list'), false);
    panel.showModalError = null;
    panel.remove();
    await f.open();
    assert.equal(panel.open, false);
    assert.equal(panel.hidden, true);
    assert.equal(f.modalCount(), 0);
    assert.equal(f.calls.includes('list'), false);
    f.document.body.appendChild(panel);
    await f.open();
    assert.equal(panel.open, true);
    assert.equal(panel.hidden, false);
    assert.equal(f.button().title, 'Codlet');
    assert.equal(f.calls.filter(method => method === 'list').length, 1);
    f.plugin.deactivate();
});

test('late native close events cannot close a reopened dialog or write into a new generation', async () => {
    const f = fixture();
    await f.plugin.activate(f.context);
    await f.open();
    await f.close().emit('click');
    await f.open();
    const beforeReopenEvent = f.mutations();
    await f.flushCloseEvents();
    assert.equal(f.mutations(), beforeReopenEvent);
    assert.equal(f.panel().open, true);
    assert.equal(f.panel().hidden, false);
    f.plugin.deactivate();
    await f.plugin.activate({ ...f.context, generation: 2 });
    await f.open();
    const beforeOldEvent = f.mutations();
    await f.flushCloseEvents();
    assert.equal(f.mutations(), beforeOldEvent);
    assert.equal(f.panel().getAttribute('data-codlet-generation'), '2');
    assert.equal(f.modalCount(), 1);
    f.plugin.deactivate();
});

test('native close before its close event rejects list responses and synchronizes the entry', async () => {
    const f = fixture();
    await f.plugin.activate(f.context);
    const pending = deferred();
    f.override('list', () => pending.promise);
    const opening = f.open();
    f.panel().close();
    const mutations = f.mutations();
    pending.resolve({ plugins: [{ id: 'too late' }] });
    await opening;
    assert.equal(f.mutations(), mutations);
    await f.flushCloseEvents();
    assert.equal(f.panel().hidden, true);
    assert.equal(f.button().getAttribute('aria-expanded'), 'false');
    assert.equal(f.modalCount(), 0);
    f.plugin.deactivate();
});

test('native cancel returns confirmation to settings, then closes the settings modal', async () => {
    const f = fixture();
    await f.plugin.activate(f.context);
    f.setActive(true);
    await f.open();
    await f.requestDisable();
    assert.equal(f.byClass('codlet-settings-section').hidden, true);
    assert.equal(f.panel().getAttribute('aria-label'), 'Disable Codlet?');
    assert.ok(f.panel().getAttribute('aria-describedby'));
    const cancelled = await f.panel().emit('cancel');
    assert.equal(cancelled.defaultPrevented, true);
    assert.equal(f.panel().open, true);
    assert.equal(f.byClass('codlet-settings-section').hidden, false);
    assert.equal(f.panel().getAttribute('aria-label'), 'Codlet');
    assert.equal(f.panel().getAttribute('aria-describedby'), null);
    assert.equal(f.document.activeElement, f.toggle());
    await f.panel().emit('cancel');
    assert.equal(f.panel().open, false);
    assert.equal(f.panel().hidden, true);
    assert.equal(f.calls.includes('disableSelf'), false);
    f.plugin.deactivate();
});

test('outside primary pointer cancels confirmation or closes settings without leaking to the host', async () => {
    const f = fixture();
    let hostPointerDowns = 0;
    f.document.addEventListener('pointerdown', () => hostPointerDowns++);
    await f.plugin.activate(f.context);
    f.setActive(true);
    await f.open();
    for (const options of [
        { button: 0, clientX: 200, clientY: 200 },
        { button: 2, clientX: 0, clientY: 0 },
        { button: 0, ctrlKey: true, clientX: 0, clientY: 0 },
        { button: 0, isPrimary: false, clientX: 0, clientY: 0 },
        { button: 0, defaultPrevented: true, clientX: 0, clientY: 0 }
    ]) {
        await f.panel().emit('pointerdown', options);
        assert.equal(f.panel().open, true);
    }
    hostPointerDowns = 0;
    await f.requestDisable();
    const outside = { button: 0, clientX: 0, clientY: 0 };
    const event = await f.panel().emit('pointerdown', outside);
    assert.equal(event.defaultPrevented, true);
    assert.equal(f.panel().open, true);
    assert.equal(f.byClass('codlet-confirmation').hidden, true);
    assert.equal(f.document.activeElement, f.toggle());
    await f.panel().emit('pointerdown', outside);
    assert.equal(f.panel().open, false);
    assert.equal(f.panel().hidden, true);
    assert.equal(hostPointerDowns, 0);
    assert.equal(f.calls.includes('disableSelf'), false);
    f.plugin.deactivate();
});
