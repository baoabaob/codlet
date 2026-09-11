import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import vm from 'node:vm';
import test from 'node:test';
import { domFixture } from './support/dom-fixture.mjs';
import { appearance, withUi } from './support/ui-fixture.mjs';

function fixture() {
    const dom = domFixture();
    const lifecycle = withUi(dom.scope);
    return { ...dom, ...lifecycle, ui: lifecycle.context.ui.create(appearance) };
}

test('UI owns local controls, IDs, listeners, timers and its deactivation hook', async () => {
    const f = fixture(), ui = f.ui;
    let clicks = 0, delayed = 0;
    const row = ui.row({ label: '<script>plain text</script>' });
    const button = ui.button({ text: 'Run', onClick: () => clicks++ });
    row.controls.appendChild(button); f.document.body.appendChild(row.element);
    assert.equal(row.label.textContent, '<script>plain text</script>');
    assert.equal(row.description.hidden, true);
    assert.equal(button.type, 'button');
    assert.equal(button.getAttribute('data-codlet-ui-theme'), appearance.themeToken);
    await button.emit('click'); assert.equal(clicks, 1);
    ui.after(15, () => delayed++);
    assert.equal(f.cleanups.size, 1);
    f.deactivate(); f.deactivate();
    await button.emit('click');
    await new Promise(resolve => setTimeout(resolve, 25));
    assert.equal(clicks, 1); assert.equal(delayed, 0);
    assert.equal(ui.signal.aborted, true);
    assert.equal(f.cleanups.size, 0); assert.equal(f.timers.size, 0);
    assert.equal(button.listenerCount(), 0); assert.equal(f.document.listenerCount(), 0);
    assert.equal(row.element.isConnected, false);
    assert.throws(() => ui.button({ text: 'Late' }), { code: 'ui_disposed' });
});

test('removing an owned subtree retires descendant listeners but leaves other owners alone', async () => {
    const f = fixture(), other = f.context.ui.create(appearance);
    const row = f.ui.row({ label: 'Row' }), button = f.ui.button({ text: 'Action' });
    let clicks = 0;
    f.ui.on(button, 'click', () => clicks++);
    row.controls.appendChild(button); f.document.body.appendChild(row.element);
    const foreign = other.button({ text: 'Other' }); f.document.body.appendChild(foreign);
    assert.throws(() => f.ui.remove(foreign), { code: 'ui_owner_mismatch' });
    f.ui.remove(row.element); await button.emit('click');
    assert.equal(clicks, 0); assert.equal(button.listenerCount(), 0); assert.equal(foreign.isConnected, true);
    f.deactivate();
});

test('busy preserves an already disabled control, and a disabled switch cannot fire callbacks', async () => {
    const f = fixture(), ui = f.ui;
    let checked;
    const toggle = ui.switch({ label: 'Enabled', disabled: true, onChange: value => { checked = value; } });
    ui.busy(toggle, true); ui.busy(toggle, true); ui.busy(toggle, false);
    assert.equal(toggle.disabled, true); assert.equal(toggle.getAttribute('aria-busy'), 'false');
    await toggle.emit('change'); assert.equal(checked, undefined);
    toggle.disabled = false; toggle.checked = true;
    await toggle.emit('change'); assert.equal(checked, true);
    ui.busy(toggle, true); ui.busy(toggle, false); assert.equal(toggle.disabled, false);
    const error = ui.status({ text: 'Failed', tone: 'error' }); assert.equal(error.getAttribute('role'), 'alert');
    f.deactivate();
});

test('nested dialogs consume Escape and return focus first to Cancel origin, then to the native editor on unload', async () => {
    const f = fixture(), ui = f.ui;
    const parent = ui.dialog({ title: 'Settings' }), child = ui.dialog({ title: 'Confirm', variant: 'confirmation' });
    const trigger = ui.button({ text: 'Open' }), cancel = ui.button({ text: 'Cancel' });
    parent.actions.appendChild(trigger); child.actions.appendChild(cancel);
    let hostEscape = 0; f.document.addEventListener('keydown', () => hostEscape++);
    parent.show(); trigger.focus(); child.show({ trigger, initialFocus: cancel });
    assert.equal(f.document.activeElement, cancel); assert.equal(f.modalDialogs.size, 2);
    const event = await cancel.emit('keydown', { key: 'Escape' });
    assert.equal(event.defaultPrevented, true); assert.equal(hostEscape, 0);
    assert.equal(f.document.activeElement, trigger); assert.equal(f.modalDialogs.size, 1);
    assert.notEqual(parent.title.id, child.title.id);
    child.show({ trigger, initialFocus: cancel }); f.deactivate();
    assert.equal(f.modalDialogs.size, 0); assert.equal(f.document.activeElement, f.editor);
});

test('cancel veto and backdrop bounds are respected; queued close events cannot close a reopened dialog', async () => {
    const f = fixture(); let veto = true; const reasons = [];
    const dialog = f.ui.dialog({ title: 'Pending', onRequestClose: () => !veto, onClose: reason => reasons.push(reason) });
    dialog.show(); await dialog.element.emit('cancel'); assert.equal(dialog.element.open, true);
    veto = false;
    await dialog.element.emit('pointerdown', { button: 0, clientX: 200, clientY: 200 }); assert.equal(dialog.element.open, true);
    await dialog.element.emit('pointerdown', { button: 0, clientX: 20, clientY: 20 }); assert.equal(dialog.element.open, false);
    assert.deepEqual(reasons, ['backdrop']);
    dialog.show(); for (const close of f.closeEvents.splice(0)) await close();
    assert.equal(dialog.element.open, true);
    dialog.dispose(); dialog.dispose();
    assert.throws(() => dialog.show(), { code: 'ui_disposed' });
    f.deactivate();
});

test('native close, another owner focus, and a failed show do not steal focus or leave modal state', async () => {
    const f = fixture(), dialog = f.ui.dialog({ title: 'Modal' });
    dialog.show(); dialog.element.close();
    const other = f.document.body.appendChild(f.document.createElement('button')); other.focus();
    for (const close of f.closeEvents.splice(0)) await close();
    assert.equal(f.document.activeElement, other); assert.equal(dialog.element.hidden, true);
    dialog.element.showModalError = 'Native failed';
    assert.throws(() => dialog.show(), /Native failed/);
    assert.equal(f.modalDialogs.size, 0); assert.equal(dialog.element.hidden, true);
    f.deactivate(); assert.equal(f.document.activeElement, other);
});

test('a later host modal keeps its top layer and focus when an earlier plugin unloads', () => {
    const f = fixture(), dialog = f.ui.dialog({ title: 'Plugin' }); dialog.show();
    const host = f.document.body.appendChild(f.document.createElement('dialog'));
    const action = host.appendChild(f.document.createElement('button')); host.showModal(); action.focus();
    f.deactivate(); assert.equal(host.open, true); assert.equal(f.modalDialogs.size, 1); assert.equal(f.document.activeElement, action);
    host.close();
});

test('once listeners retire immediately and pending consumer work receives an aborted signal', async () => {
    const f = fixture(), button = f.ui.button({ text: 'Async' });
    let resolve, seen;
    const gate = new Promise(done => { resolve = done; });
    f.ui.on(button, 'click', async (_event, signal) => { await gate; seen = signal.aborted; }, { once: true });
    const pending = button.emit('click'); assert.equal(button.listenerCount(), 0);
    f.deactivate(); resolve(); await pending; assert.equal(seen, true);
});

test('unsupported contracts and invalid controls fail before publishing usable UI', () => {
    const f = fixture();
    assert.throws(() => f.context.ui.create({ ...appearance, available: false }), { code: 'ui_appearance_unavailable' });
    assert.throws(() => f.context.ui.create({ ...appearance, roles: { button: 'default' } }), { code: 'invalid_ui_argument' });
    assert.throws(() => f.ui.element('script'), { code: 'invalid_ui_argument' });
    assert.throws(() => f.ui.button({}), { code: 'invalid_ui_argument' });
    assert.throws(() => f.ui.element('div', { role: 'privateNativeThing' }), { code: 'unsupported_ui_role' });
    assert.throws(() => f.ui.after(60001, () => {}), { code: 'invalid_ui_argument' });
    const one = f.ui.dialog({ title: 'One' }), two = f.context.ui.create(appearance).dialog({ title: 'Two' });
    assert.notEqual(one.title.id, two.title.id);
    assert.throws(() => one.show({ initialFocus: f.editor }), { code: 'ui_owner_mismatch' });
    f.deactivate();
});

test('ordinary plugin consumes only public capabilities and leaves no modal, listener, observer or timer on unload', async () => {
    const dom = domFixture(), lifecycle = withUi(dom.scope);
    const calls = [];
    lifecycle.context.rpc = { async request(capability, method) {
        calls.push([capability.name, method]);
        if (capability.name === 'codex.ui.appearance' && method === 'describe') return appearance;
        if (capability.name === 'codex.ui.titlebar.afterMenu' && method === 'getMount') return { token: 'codex.ui.titlebar.afterMenu@1', available: true };
        throw Error('Unexpected capability');
    } };
    vm.runInNewContext(readFileSync(new URL('../examples/ui-controls/renderer.js', import.meta.url), 'utf8'), dom.scope);
    await dom.scope.module.exports.activate(lifecycle.context);
    const nodes = () => dom.descendants(dom.document.documentElement);
    const button = text => nodes().find(node => node.tagName === 'button' && node.textContent === text);
    await button('UI').emit('click'); assert.equal(dom.modalDialogs.size, 1);
    await button('Increment').emit('click'); await button('Run').emit('click');
    assert.equal(dom.timers.size, 1);
    await button('Reset…').emit('click'); assert.equal(dom.document.activeElement, button('Cancel'));
    assert.equal(dom.modalDialogs.size, 2);
    lifecycle.deactivate(); dom.scope.module.exports.deactivate();
    assert.equal(dom.modalDialogs.size, 0); assert.equal(dom.observers.size, 0); assert.equal(dom.timers.size, 0);
    assert.equal(dom.document.listenerCount(), 0); assert.equal(dom.document.activeElement, dom.editor);
    assert.equal(nodes().some(node => node.getAttribute('data-codlet-ui-owner')), false);
    assert.deepEqual(calls, [['codex.ui.appearance', 'describe'], ['codex.ui.titlebar.afterMenu', 'getMount']]);
});
