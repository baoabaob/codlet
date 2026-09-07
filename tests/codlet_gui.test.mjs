import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import vm from 'node:vm';
import test from 'node:test';

const source = readFileSync(new URL('../bundled/codlet/dist/renderer.js', import.meta.url), 'utf8');

function fixture() {
    let mutations = 0;
    class Element {
        constructor(tag) {
            this.tagName = tag;
            this.children = [];
            this.parentElement = null;
            this.attributes = new Map();
            this.listeners = new Map();
            this.style = {};
            this.hidden = false;
            this.className = '';
            this.text = '';
        }
        set textContent(value) {
            mutations += 1;
            this.replaceChildren();
            this.text = String(value);
        }
        get textContent() { return this.text + this.children.map(child => child.textContent).join(' '); }
        get isConnected() { return this === document.documentElement || this.parentElement?.isConnected === true; }
        appendChild(child) {
            mutations += 1;
            child.remove();
            child.parentElement = this;
            this.children.push(child);
            return child;
        }
        replaceChildren(...children) {
            mutations += 1;
            for (const child of [...this.children]) child.remove();
            this.text = '';
            for (const child of children) this.appendChild(child);
        }
        remove() {
            mutations += 1;
            if (this.parentElement) {
                const siblings = this.parentElement.children;
                siblings.splice(siblings.indexOf(this), 1);
                this.parentElement = null;
            }
        }
        setAttribute(name, value) { mutations += 1; this.attributes.set(name, String(value)); }
        getAttribute(name) { return this.attributes.get(name) ?? null; }
        addEventListener(name, listener) { this.listeners.set(name, listener); }
        removeEventListener(name) { this.listeners.delete(name); }
        async emit(name) { await this.listeners.get(name)?.({}); }
        getBoundingClientRect() { return { bottom: 40 }; }
    }
    function descendants(root) {
        return root.children.flatMap(child => [child, ...descendants(child)]);
    }
    const document = {
        documentElement: new Element('html'),
        body: new Element('body'),
        createElement: tag => new Element(tag),
        addEventListener() {},
        removeEventListener() {},
        querySelectorAll(selector) {
            assert.equal(selector, '[data-codlet-capability]');
            return descendants(this.documentElement).filter(element => element.attributes.has('data-codlet-capability'));
        }
    };
    document.documentElement.appendChild(document.body);
    const mount = document.createElement('div');
    mount.setAttribute('data-codlet-capability', 'codex.ui.titlebar.afterMenu@1');
    document.body.appendChild(mount);
    const scope = {
        module: { exports: {} }, document, Error,
        MutationObserver: class { observe() {} disconnect() {} },
        addEventListener() {}, removeEventListener() {}, confirm() { return true; }
    };
    vm.runInNewContext(source, scope, { filename: 'codlet-renderer.js' });
    const plugin = scope.module.exports;
    let active = false;
    let listOverride;
    const calls = [];
    const context = {
        pluginId: 'codlet', generation: 1,
        rpc: {
            async request(_capability, method) {
                calls.push(method);
                if (method === 'ping') return { pong: true, abi: 1 };
                if (method === 'getMount') return { available: true, token: 'codex.ui.titlebar.afterMenu@1' };
                if (method === 'list') return listOverride ? listOverride() : { plugins: [
                    { id: 'codlet', version: '1', source: 'bundled', enabled: true, active, validation: { status: 'ok' } },
                    { id: 'dev.broken', version: null, source: 'local', path: 'C:/fixture/missing', enabled: false, active: false, validation: { status: 'failed', error: { message: 'Missing renderer entry' } } }
                ] };
                if (method === 'disableSelf') {
                    plugin.deactivate();
                    return { pluginId: 'codlet', enabled: false };
                }
                throw new Error('Unexpected method');
            }
        }
    };
    return {
        plugin, context, calls, document,
        nodes: () => descendants(document.documentElement),
        button: () => descendants(document.documentElement).find(element => element.attributes.has('data-codlet-titlebar-button')),
        panel: () => descendants(document.documentElement).find(element => element.attributes.has('data-codlet-panel')),
        setActive(value) { active = value; },
        setList(value) { listOverride = value; },
        mutations: () => mutations,
    };
}

test('opening refreshes Activating snapshot and enables self-disable after Host Active', async () => {
    const f = fixture();
    await f.plugin.activate(f.context);
    assert.equal(f.nodes().some(node => node.tagName === 'input'), false);
    f.setActive(true);
    await f.button().emit('click');
    assert.equal(f.panel().hidden, false);
    const toggle = f.nodes().find(node => node.tagName === 'input');
    assert.ok(toggle);
    assert.equal(f.panel().textContent.includes('undefined'), false);
    assert.equal(f.panel().textContent.includes('null'), false);
    assert.match(f.panel().textContent, /Missing renderer entry/);
    toggle.checked = false;
    await toggle.emit('change');
    assert.equal(f.calls.filter(call => call === 'list').length, 2);
    assert.equal(f.calls.filter(call => call === 'disableSelf').length, 1);
    assert.equal(f.panel(), undefined);
});

test('loading and error states recover on the next open', async () => {
    const f = fixture();
    await f.plugin.activate(f.context);
    let reject;
    f.setList(() => new Promise((_resolve, fail) => { reject = fail; }));
    const opening = f.button().emit('click');
    assert.match(f.panel().textContent, /Loading plugins/);
    reject(new Error('List failed'));
    await opening;
    assert.match(f.panel().textContent, /List failed/);
    await f.button().emit('click');
    f.setList(undefined);
    f.setActive(true);
    await f.button().emit('click');
    assert.equal(f.nodes().some(node => node.tagName === 'input'), true);
    f.plugin.deactivate();
});

test('late list response does not mutate an unloaded panel', async () => {
    const f = fixture();
    await f.plugin.activate(f.context);
    let resolve;
    f.setList(() => new Promise(done => { resolve = done; }));
    const opening = f.button().emit('click');
    f.plugin.deactivate();
    const afterUnload = f.mutations();
    resolve({ plugins: [] });
    await opening;
    assert.equal(f.mutations(), afterUnload);
    assert.equal(f.panel(), undefined);
});

test('closing while loading prevents an old response from reopening the panel', async () => {
    const f = fixture();
    await f.plugin.activate(f.context);
    let resolve;
    f.setList(() => new Promise(done => { resolve = done; }));
    const opening = f.button().emit('click');
    await f.button().emit('click');
    resolve({ plugins: [] });
    await opening;
    assert.equal(f.panel().hidden, true);
    f.plugin.deactivate();
});
