import assert from 'node:assert/strict';
import { randomUUID } from 'node:crypto';

export function domFixture({ mounted = true, ready = true } = {}) {
    const token = 'codex.ui.titlebar.afterMenu@1';
    let mutations = 0;
    let layoutReads = 0;
    const observers = new Set();
    const modalDialogs = new Set();
    const closeEvents = [];
    const timers = new Set();
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
        insertBefore(child, reference) {
            if (reference === null) return this.appendChild(child);
            assert.ok(this.children.includes(reference));
            if (child === reference) return child;
            mutations++;
            child.remove();
            child.parentElement = this;
            this.children.splice(this.children.indexOf(reference), 0, child);
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
        module: { exports: {} }, document, Error, URL, AbortController, crypto: { randomUUID }, innerHeight: 720,
        setTimeout(callback, delay) {
            const timer = globalThis.setTimeout(() => { timers.delete(timer); callback(); }, delay);
            timers.add(timer);
            return timer;
        },
        clearTimeout(timer) { timers.delete(timer); globalThis.clearTimeout(timer); },
        MutationObserver: class {
            constructor(callback) { this.callback = callback; }
            observe() { observers.add(this); }
            disconnect() { observers.delete(this); }
        },
        addEventListener: window.addEventListener.bind(window),
        removeEventListener: window.removeEventListener.bind(window),
        confirm() { throw new Error('Global confirm must not be used'); }
    };
    return { scope, document, body, mount, toolbar, editor, window, descendants, observers, modalDialogs, timers, closeEvents, mutations: () => mutations, layoutReads: () => layoutReads };
}
