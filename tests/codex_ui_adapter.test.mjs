import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import vm from 'node:vm';
import test from 'node:test';

const source = readFileSync(new URL('../bundled/codex-ui-adapter/dist/renderer.js', import.meta.url), 'utf8');
const token = 'codex.ui.titlebar.afterMenu@1';
const mountSelector = `[data-codlet-capability="${token}"][data-codlet-provider="codex.ui.adapter"]`;
const styleSelector = `style[data-codlet-ui-adapter-style="${token}"]`;

function fixture({ ready = true, chrome = 'application-menu' } = {}) {
    const jobs = [];
    const observers = new Set();
    const endpoints = [];
    let mutations = 0;
    let queries = 0;
    function mutate(record) {
        mutations += 1;
        for (const observer of observers) {
            if (!observer.root || !(observer.root === record.target ||
                observer.options.subtree && observer.root.contains(record.target))) continue;
            if (!observer.options[record.type]) continue;
            if (record.type === 'attributes' && observer.options.attributeFilter &&
                !observer.options.attributeFilter.includes(record.attributeName)) continue;
            observer.records.push(record);
            if (observer.queued) continue;
            observer.queued = true;
            jobs.push(() => {
                observer.queued = false;
                const records = observer.records.splice(0);
                if (records.length) observer.callback(records);
            });
        }
    }
    class Element {
        constructor(tagName) {
            this.tagName = tagName;
            this.children = [];
            this.attributes = new Map();
            this.parentElement = null;
            this.text = '';
            this.style = {};
        }
        get isConnected() { return this === document.documentElement || this.parentElement?.isConnected === true; }
        get firstChild() { return this.children[0] ?? null; }
        get firstElementChild() { return this.firstChild; }
        get nextSibling() { return this.parentElement?.children[this.parentElement.children.indexOf(this) + 1] ?? null; }
        get previousElementSibling() { return this.parentElement?.children[this.parentElement.children.indexOf(this) - 1] ?? null; }
        get textContent() { return this.text + this.children.map(child => child.textContent).join(''); }
        set textContent(value) {
            for (const child of [...this.children]) child.remove();
            this.text = String(value);
            mutate({ type: 'childList', target: this });
        }
        getAttribute(name) { return this.attributes.get(name) ?? null; }
        setAttribute(name, value) {
            this.attributes.set(name, String(value));
            mutate({ type: 'attributes', target: this, attributeName: name });
        }
        removeAttribute(name) {
            this.attributes.delete(name);
            mutate({ type: 'attributes', target: this, attributeName: name });
        }
        contains(node) { return this === node || this.children.some(child => child.contains(node)); }
        insertBefore(child, before) {
            if (child === before) return child;
            assert.ok(before === null || before.parentElement === this);
            child.remove();
            const index = before === null ? this.children.length : this.children.indexOf(before);
            this.children.splice(index, 0, child);
            child.parentElement = this;
            mutate({ type: 'childList', target: this });
            return child;
        }
        appendChild(child) { return this.insertBefore(child, null); }
        remove() {
            if (!this.parentElement) return;
            const parent = this.parentElement;
            parent.children.splice(parent.children.indexOf(this), 1);
            this.parentElement = null;
            mutate({ type: 'childList', target: parent });
        }
        matches(selector) {
            const tag = selector.match(/^[a-z]+/)?.[0];
            if (tag && this.tagName !== tag) return false;
            const attributes = [...selector.matchAll(/\[([\w-]+)(?:="([^"]*)")?\]/g)];
            assert.equal((tag ?? '') + attributes.map(match => match[0]).join(''), selector,
                `Fixture must implement the selector used by the adapter: ${selector}`);
            return attributes.every(([, name, value]) => value === undefined ?
                this.attributes.has(name) : this.getAttribute(name) === value);
        }
        querySelectorAll(selector) {
            queries += 1;
            return descendants(this).filter(node => node.matches(selector));
        }
        querySelector(selector) { return this.querySelectorAll(selector)[0] ?? null; }
    }
    function descendants(root) { return root.children.flatMap(child => [child, ...descendants(child)]); }
    const listeners = new Map();
    const document = {
        documentElement: null, head: null, body: null,
        createElement: tag => new Element(tag),
        addEventListener(name, listener) {
            if (!listeners.has(name)) listeners.set(name, new Set());
            listeners.get(name).add(listener);
        },
        removeEventListener(name, listener) { listeners.get(name)?.delete(listener); },
        querySelectorAll(selector) {
            queries += 1;
            return [this.documentElement, ...descendants(this.documentElement)].filter(node => node.matches(selector));
        },
    };
    document.documentElement = new Element('html');
    document.documentElement.setAttribute('data-codex-window-chrome', chrome);
    document.head = document.documentElement.appendChild(new Element('head'));
    if (ready) document.body = document.documentElement.appendChild(new Element('body'));
    const scope = {
        module: { exports: {} }, document,
        queueMicrotask(callback) { jobs.push(callback); },
        MutationObserver: class {
            constructor(callback) { this.callback = callback; this.records = []; observers.add(this); }
            observe(root, options) { this.root = root; this.options = options; }
            disconnect() { this.root = null; this.records = []; }
        },
    };
    vm.runInNewContext(source, scope, { filename: 'codex-ui-adapter.js' });
    const plugin = scope.module.exports;
    const f = {
        document, plugin, endpoints,
        async activate(generation = 1) {
            await plugin.activate({ generation, rpc: {
                provide(capability, method, handler) {
                    assert.deepEqual(JSON.parse(JSON.stringify(capability)), {
                        name: 'codex.ui.titlebar.afterMenu', api: 1, scope: 'target',
                    });
                    assert.equal(method, 'getMount');
                    endpoints.push(handler);
                },
            } });
        },
        getMount() { return JSON.parse(JSON.stringify(endpoints.at(-1)())); },
        mount() { return document.querySelectorAll(mountSelector)[0] ?? null; },
        style() { return document.querySelectorAll(styleSelector)[0] ?? null; },
        nodes(selector) { return document.querySelectorAll(selector); },
        step() {
            assert.ok(jobs.length);
            jobs.shift()();
        },
        flush() {
            let runs = 0;
            while (jobs.length) {
                assert.ok(++runs < 100, 'MutationObserver must settle instead of triggering itself indefinitely');
                jobs.shift()();
            }
            return runs;
        },
        ready() {
            if (!document.body) document.body = document.documentElement.appendChild(new Element('body'));
            for (const listener of listeners.get('DOMContentLoaded') ?? []) listener();
        },
        readyListeners() { return listeners.get('DOMContentLoaded')?.size ?? 0; },
        activeObservers() { return [...observers].filter(observer => observer.root).length; },
        mutations: () => mutations,
        queries: () => queries,
        element(tag, attributes = {}) {
            const element = new Element(tag);
            for (const [name, value] of Object.entries(attributes)) element.setAttribute(name, value);
            return element;
        },
        menu() {
            const row = document.body.appendChild(new Element('div'));
            row.appendChild(new Element('span'));
            const menu = row.appendChild(f.element('div', { role: 'menubar' }));
            const triggers = ['file', 'edit', 'view', 'help'].map(name => menu.appendChild(f.element('button', {
                role: 'menuitem', id: `application-menu-trigger-${name}-menu`,
            })));
            menu.appendChild(f.element('button', {
                id: 'application-menu-content-anchor', role: 'menuitem', 'aria-hidden': 'true',
            }));
            const trailing = row.appendChild(new Element('span'));
            return { row, menu, triggers, trailing };
        },
        legacy() {
            const header = document.body.appendChild(f.element('header', { 'data-app-shell-header-layout': 'thread' }));
            const surface = header.appendChild(f.element('div', { 'data-testid': 'app-shell-header-context-menu-surface' }));
            const action = surface.appendChild(new Element('button'));
            return { header, surface, action };
        },
    };
    return f;
}

test('mount follows the official application menubar, outside its menuitem collection', async () => {
    const f = fixture();
    f.legacy();
    const { row, menu, trailing } = f.menu();
    const original = [...menu.children];
    await f.activate(7);
    f.flush();
    assert.deepEqual(f.getMount(), { available: true, token, placement: 'application-menu' });
    const mount = f.mount();
    assert.equal(mount.parentElement, row);
    assert.equal(menu.nextSibling, mount);
    assert.equal(mount.nextSibling, trailing);
    assert.equal(mount.getAttribute('data-codlet-generation'), '7');
    assert.deepEqual(menu.children, original);
    assert.equal(mount.getAttribute('role'), null);
    assert.equal(f.nodes(mountSelector).length, 1);
    assert.equal(f.nodes(styleSelector).length, 1);
});

test('unknown, incomplete, nested or reordered menus do not match the application menu', async () => {
    for (const change of [
        f => f.document.documentElement.setAttribute('data-codex-window-chrome', 'native'),
        (_f, menu) => menu.triggers[3].remove(),
        (_f, menu) => menu.triggers[0].setAttribute('id', 'file'),
        (f, menu) => menu.menu.appendChild(f.element('div')).appendChild(menu.triggers[0]),
        (_f, menu) => menu.menu.appendChild(menu.triggers[0]),
    ]) {
        const f = fixture();
        change(f, f.menu());
        f.document.body.appendChild(f.element('header')).appendChild(f.element('div', {
            'data-testid': 'app-shell-header-context-menu-surface',
        }));
        await f.activate();
        f.flush();
        assert.deepEqual(f.getMount(), { available: false, token, placement: null });
        assert.equal(f.mount(), null);
        f.plugin.deactivate();
    }
});

test('late menu upgrades the precise legacy fallback and preserves consumer nodes', async () => {
    const f = fixture();
    const legacy = f.legacy();
    await f.activate();
    f.flush();
    const mount = f.mount();
    const consumer = mount.appendChild(f.element('button'));
    assert.equal(legacy.surface.firstChild, mount);
    assert.equal(mount.nextSibling, legacy.action);
    assert.equal(f.getMount().placement, 'legacy-header');
    const menu = f.menu();
    f.flush();
    assert.equal(f.getMount().placement, 'application-menu');
    assert.equal(f.mount(), mount);
    assert.equal(mount.firstChild, consumer);
    f.document.documentElement.setAttribute('data-codex-window-chrome', 'native');
    f.flush();
    assert.equal(f.mount(), mount);
    assert.equal(mount.parentElement, legacy.surface);
    assert.equal(menu.menu.children.length, 5);
});

test('toolbar removal and replacement reuse the mount without duplicates or lost consumers', async () => {
    const f = fixture();
    const old = f.menu();
    await f.activate();
    f.flush();
    const mount = f.mount();
    const consumer = mount.appendChild(f.element('button'));
    old.row.remove();
    assert.deepEqual(f.getMount(), { available: false, token, placement: null });
    f.flush();
    assert.equal(mount.parentElement, null);
    const replacement = f.menu();
    f.flush();
    assert.equal(f.mount(), mount);
    assert.equal(replacement.menu.nextSibling, mount);
    assert.equal(mount.firstChild, consumer);
    assert.equal(f.nodes(mountSelector).length, 1);
});

test('legacy header rebuilds and structural attribute changes are reconciled', async () => {
    const f = fixture();
    const old = f.legacy();
    await f.activate();
    f.flush();
    const mount = f.mount();
    old.header.remove();
    const replacement = f.legacy();
    f.flush();
    assert.equal(f.mount(), mount);
    assert.equal(replacement.surface.firstChild, mount);
    replacement.surface.removeAttribute('data-testid');
    f.flush();
    assert.equal(f.getMount().available, false);
    replacement.surface.setAttribute('data-testid', 'app-shell-header-context-menu-surface');
    f.flush();
    assert.equal(f.mount(), mount);
    const menu = f.menu();
    menu.triggers[3].removeAttribute('role');
    f.flush();
    assert.equal(f.getMount().placement, 'legacy-header');
    menu.triggers[3].setAttribute('role', 'menuitem');
    f.flush();
    assert.equal(f.getMount().placement, 'application-menu');
});

test('stale owned artifacts are removed and displaced mounts and styles recover', async () => {
    const f = fixture();
    const menu = f.menu();
    const staleMount = menu.row.appendChild(f.element('span', {
        'data-codlet-capability': token, 'data-codlet-provider': 'codex.ui.adapter',
    }));
    const staleStyle = f.document.head.appendChild(f.element('style', { 'data-codlet-ui-adapter-style': token }));
    const unrelated = f.document.body.appendChild(f.element('span', { 'data-codlet-provider': 'another' }));
    await f.activate();
    f.flush();
    assert.equal(staleMount.isConnected, false);
    assert.equal(staleStyle.isConnected, false);
    const mount = f.mount();
    const style = f.style();
    menu.row.appendChild(mount);
    style.remove();
    assert.equal(f.getMount().available, false);
    f.flush();
    assert.equal(menu.menu.nextSibling, mount);
    assert.equal(f.style(), style);
    menu.row.appendChild(staleMount);
    f.document.head.appendChild(staleStyle);
    f.flush();
    assert.equal(f.nodes(mountSelector).length, 1);
    assert.equal(f.nodes(styleSelector).length, 1);
    assert.equal(unrelated.isConnected, true);
});

test('observer batches settle and consumer rendering does not cause reconciliation', async () => {
    const f = fixture();
    f.menu();
    await f.activate();
    assert.ok(f.flush() <= 3);
    const consumer = f.mount().appendChild(f.element('button'));
    const before = f.queries();
    consumer.textContent = 'Codlet';
    f.flush();
    assert.equal(f.queries(), before);
    const unrelated = f.document.body.appendChild(f.element('div'));
    for (let index = 0; index < 50; index += 1) unrelated.appendChild(f.element('span'));
    const afterHostChanges = f.mutations();
    assert.ok(f.flush() <= 3);
    assert.equal(f.mutations(), afterHostChanges);
    assert.equal(f.flush(), 0);
});

test('deactivation cancels waiting for the document and late readiness cannot publish', async () => {
    const f = fixture({ ready: false });
    const activating = f.activate();
    assert.equal(f.readyListeners(), 1);
    assert.deepEqual(f.getMount(), { available: false, token, placement: null });
    f.plugin.deactivate();
    await activating;
    assert.equal(f.readyListeners(), 0);
    f.ready();
    f.menu();
    f.flush();
    assert.equal(f.mount(), null);
    assert.equal(f.style(), null);
    assert.equal(f.activeObservers(), 0);
});

test('a new generation supersedes pending activation and retires the old getMount handler', async () => {
    const f = fixture({ ready: false });
    const oldActivation = f.activate(1);
    const oldHandler = f.endpoints[0];
    const activation = f.activate(2);
    f.ready();
    f.menu();
    await Promise.all([oldActivation, activation]);
    f.flush();
    assert.equal(f.mount().getAttribute('data-codlet-generation'), '2');
    assert.equal(oldHandler().available, false);
    assert.equal(oldHandler().token, token);
    assert.equal(f.activeObservers(), 1);
});

test('unloading with pending observer work removes all provider artifacts without resurrection', async () => {
    const f = fixture();
    const menu = f.menu();
    await f.activate();
    f.flush();
    menu.row.remove();
    f.menu();
    f.step();
    f.plugin.deactivate();
    const afterUnload = f.mutations();
    f.flush();
    assert.equal(f.mutations(), afterUnload);
    assert.equal(f.mount(), null);
    assert.equal(f.style(), null);
    assert.equal(f.activeObservers(), 0);
    assert.deepEqual(f.getMount(), { available: false, token, placement: null });
    await f.activate(2);
    f.flush();
    assert.equal(f.getMount().available, true);
    assert.equal(f.nodes(mountSelector).length, 1);
});

test('theme contract is scoped to owned mounts and opted-in portals with native CSS references', async () => {
    const f = fixture();
    f.menu();
    f.document.documentElement.style.userSetting = 'untouched';
    f.document.body.style.userSetting = 'untouched';
    await f.activate();
    f.flush();
    const css = f.style().textContent;
    const rules = [...css.matchAll(/([^{}]+)\{([^{}]*)\}/g)];
    assert.equal(rules.length, 2);
    assert.equal(rules[0][1].trim(), `${mountSelector}, [data-codlet-ui-theme="${token}"]`);
    const variables = [...rules[0][2].matchAll(/--codlet-ui-([\w-]+):\s*([^;]+);/g)];
    assert.deepEqual(variables.map(([, name]) => name).sort(),
        ['bg', 'fg', 'muted', 'border', 'hover', 'active', 'focus', 'font', 'font-size', 'menu-height', 'radius'].sort());
    for (const [, , value] of variables) assert.match(value, /^var\(--[\w-]+, .+\)$/);
    assert.equal(rules[1][1].trim(), mountSelector);
    assert.match(rules[1][2], /-webkit-app-region:\s*no-drag/);
    assert.match(rules[1][2], /pointer-events:\s*auto/);
    assert.deepEqual(f.document.documentElement.style, { userSetting: 'untouched' });
    assert.deepEqual(f.document.body.style, { userSetting: 'untouched' });
    f.plugin.deactivate();
    assert.equal(f.style(), null);
});
