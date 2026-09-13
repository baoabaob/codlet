import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import vm from 'node:vm';
import test from 'node:test';

const source = readFileSync(new URL('../bundled/runtime/i18n.js', import.meta.url), 'utf8');
const bootstrap = readFileSync(new URL('../bundled/runtime/bootstrap.js', import.meta.url), 'utf8');
function fixture(lang = 'zh-CN') {
    const root = { lang }, observers = new Set(), cleanups = [];
    class MutationObserver {
        constructor(callback) { this.callback = callback; }
        observe(target, options) { assert.equal(target, root); assert.deepEqual(Array.from(options.attributeFilter), ['lang']); observers.add(this); }
        disconnect() { observers.delete(this); }
    }
    const context = { onDeactivate(callback) { cleanups.push(callback); } };
    const create = vm.runInNewContext(source, { document: { documentElement: root }, navigator: { language: 'zh-CN' }, MutationObserver });
    return { i18n: create(context), observers, setLanguage(lang) { root.lang = lang; for (const observer of observers) observer.callback(); }, close() { cleanups.forEach(callback => callback()); } };
}
const messages = { zh: { hello: '你好，{name}' }, en: { hello: 'Hello, {name}', fallback: 'English fallback' } };
test('resolved client language wins over browser locale; every non-Chinese language falls back to English', () => {
    const f = fixture();
    assert.equal(f.i18n.t(messages, 'hello', { name: 'Codlet' }), '你好，Codlet');
    for (const lang of ['zh-TW', 'zh-Hans', 'ZH-cn']) { f.setLanguage(lang); assert.equal(f.i18n.locale, 'zh'); }
    for (const lang of ['en-US', 'ja', 'de', '', 'zho']) { f.setLanguage(lang); assert.equal(f.i18n.locale, 'en'); }
    f.setLanguage('zh');
    assert.equal(f.i18n.t(messages, 'fallback'), 'English fallback');
    assert.equal(f.i18n.t(messages, 'missing'), 'missing');
    assert.equal(f.i18n.t(messages, 'hello', { name: '<b>text</b>' }), '你好，<b>text</b>');
});
test('language changes are deduplicated and subscriptions retire with their generation', () => {
    const f = fixture(), seen = [];
    const unsubscribe = f.i18n.onChange(locale => seen.push(locale));
    f.i18n.onChange(() => { throw new Error('consumer failure'); });
    f.setLanguage('zh-TW');
    f.setLanguage('fr');
    f.setLanguage('en');
    assert.deepEqual(seen, ['en']);
    unsubscribe();
    f.setLanguage('zh-CN');
    assert.deepEqual(seen, ['en']);
    f.close();
    assert.equal(f.observers.size, 0);
    assert.throws(() => f.i18n.onChange(() => {}), /retired/);
});

for (const world of ['isolated', 'main']) test(`${world} renderer language observers retire on replacement and activation failure`, async () => {
    const observers = new Set();
    class MutationObserver {
        constructor(callback) { this.callback = callback; }
        observe() { observers.add(this); }
        disconnect() { observers.delete(this); }
    }
    const scope = vm.createContext({ document: { documentElement: { lang: 'zh-CN' } }, MutationObserver, TextEncoder, MessageChannel, setTimeout, clearTimeout });
    vm.runInContext(`(${bootstrap})({world:'${world}'},null,(${source}))`, scope);
    const runtime = scope.__codletRendererV1, contexts = [];
    const plugin = { activate(context) { contexts.push(context); assert.equal(context.i18n.locale, 'zh'); }, deactivate() {} };
    assert.equal((await runtime.activate({id:'test.locale',version:'1',generation:1}, plugin)).ok, true);
    assert.equal(observers.size, 1);
    assert.equal((await runtime.activate({id:'test.locale',version:'1',generation:2}, plugin)).ok, true);
    assert.equal(observers.size, 1);
    assert.throws(() => contexts[0].i18n.onChange(() => {}), /retired/);
    assert.equal((await runtime.deactivate('test.locale',2)).ok, true);
    assert.equal(observers.size, 0);
    assert.equal((await runtime.activate({id:'test.locale',version:'1',generation:3}, { activate(context) { context.i18n.onChange(() => {}); throw new Error('fixture'); }, deactivate() {} })).ok, false);
    assert.equal(observers.size, 0);
});
