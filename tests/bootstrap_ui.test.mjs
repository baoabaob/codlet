import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import vm from 'node:vm';
import test from 'node:test';
import { domFixture } from './support/dom-fixture.mjs';
import { appearance } from './support/ui-fixture.mjs';

const bootstrap = readFileSync(new URL('../bundled/runtime/bootstrap.js', import.meta.url), 'utf8');
const factory = readFileSync(new URL('../bundled/runtime/ui.js', import.meta.url), 'utf8');
for (const world of ['isolated', 'main']) test(`managed ${world} context retires UI on replacement and final deactivation`, async () => {
    const dom = domFixture(), scope = vm.createContext({ ...dom.scope, TextEncoder, MessageChannel });
    vm.runInContext(`(${bootstrap})({ world: '${world}' }, (${factory}))`, scope);
    const runtime = scope.__codletRendererV1, owners = [], contexts = [];
    const definition = { activate(ctx) {
        const ui = ctx.ui.create(appearance), dialog = ui.dialog({ title: 'Owned dialog' });
        dialog.show(); owners.push(ui); contexts.push(ctx);
    }, deactivate() {} };
    assert.equal((await runtime.activate({ id: 'test.ui', generation: 1 }, definition)).ok, true);
    assert.equal(dom.modalDialogs.size, 1);
    assert.equal((await runtime.activate({ id: 'test.ui', generation: 2 }, definition)).ok, true);
    assert.equal(owners[0].signal.aborted, true); assert.equal(owners[1].signal.aborted, false);
    assert.equal(dom.modalDialogs.size, 1);
    const listeners = dom.document.listenerCount();
    assert.throws(() => contexts[0].ui.create(appearance), { code: 'plugin_deactivated' });
    assert.equal(dom.document.listenerCount(), listeners, 'retired contexts must not attach a UI listener');
    assert.equal((await runtime.deactivate('test.ui', 2)).ok, true);
    assert.equal(owners[1].signal.aborted, true); assert.equal(dom.modalDialogs.size, 0);
    assert.equal(dom.document.listenerCount(), 0); assert.equal(dom.document.activeElement, dom.editor);
});
