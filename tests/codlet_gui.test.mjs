import assert from 'node:assert/strict';
import test from 'node:test';
import {createPreviewRuntime} from '../scripts/preview-runtime.mjs';
import {uiFixture,tick,deferred} from './support/ui-fixture.mjs';
async function fixture(t,locale='en'){const demo=createPreviewRuntime(),f=uiFixture({locale,request:demo.request}),plugin=f.load('bundled/codlet/dist/renderer.js');t.after(()=>{plugin.deactivate();f.dispose();});await plugin.activate(f.context);return {...f,demo,plugin};}
test('Codlet loads only on its native page and tears down on route changes',async t=>{
  const f=await fixture(t);assert.equal(f.calls.some(c=>c.method==='list'),false);assert.equal(f.document.querySelector('[data-codlet-panel]'),null);await f.open();assert.ok(f.document.querySelector('section[data-codlet-panel]'));assert.equal(f.document.querySelector('dialog'),null);assert.equal(f.document.activeElement,f.control('Search plugins'));await f.leave();assert.equal(f.document.querySelector('[data-codlet-panel]'),null);await f.open();assert.ok(f.control('Search plugins'));
});
test('rows show names, adjacent versions and descriptions without normal state labels or row tooltips',async t=>{
  const f=await fixture(t,'zh');await f.open();const row=f.document.querySelector('[data-codlet-plugin="codex.ui.adapter"]');assert.match(row.textContent,/Codex 界面适配器0\.1\.0/);assert.match(row.textContent,/将插件页面接入 Codex 主导航/);assert.equal(row.hasAttribute('title'),false);assert.doesNotMatch(row.textContent,/running|运行正常|not active/i);
});
test('search matches ID/name/description, Escape clears only search, and refresh preserves focus',async t=>{
  const f=await fixture(t);await f.open();await f.input('Search plugins','navigation');assert.equal(f.document.querySelectorAll('[data-codlet-plugin]').length,1);assert.equal(f.document.querySelector('[data-codlet-plugin]').dataset.codletPlugin,'codex.ui.adapter');
  await f.key(f.control('Search plugins'),'Escape');assert.equal(f.control('Search plugins').value,'');assert.ok(f.document.querySelector('[data-codlet-panel]'));f.control('Refresh plugins').click();await tick();assert.equal(f.document.activeElement,f.control('Search plugins'));
});
test('search keeps IME drafts until composition ends',async t=>{
  const f=await fixture(t,'zh');await f.open();const input=f.control('搜索插件');input.dispatchEvent(new f.window.CompositionEvent('compositionstart',{bubbles:true}));await f.input('搜索插件','笔记');assert.equal(f.document.querySelectorAll('[data-codlet-plugin]').length,5);input.dispatchEvent(new f.window.CompositionEvent('compositionend',{bubbles:true}));await tick();assert.equal(f.document.querySelectorAll('[data-codlet-plugin]').length,0);
});
test('automatic folder preview, official grants and language changes preserve current form state',async t=>{
  const f=await fixture(t);await f.open();await f.click('Import plugins');await f.click('Choose plugin folder');assert.equal(f.control('Plugin folder').value,'C:/Projects/Local Notes');assert.equal(f.control('Confirm local import').disabled,true);await f.click('Trust this local plugin');await f.click('Grant ui.dom');assert.equal(f.control('Confirm local import').disabled,false);await f.locale('zh');assert.equal(f.control('插件文件夹').value,'C:/Projects/Local Notes');assert.equal(f.control('确认导入本地插件').disabled,false);assert.equal(f.document.querySelectorAll('a[href="https://github.com/topics/codlet-plugin"]').length,1);
});
test('compatibility is an owned official popover; leaving the page removes its portal',async t=>{
  const f=await fixture(t);await f.open();await f.click('Version and compatibility');assert.match(f.document.body.textContent,/matches the latest client version/);assert.ok(f.document.querySelector('[data-radix-popper-content-wrapper]'));await f.leave();assert.equal(f.document.querySelector('[data-radix-popper-content-wrapper]'),null);
});
test('details show actual grants without the raw source path; folder opening passes only plugin ID',async t=>{
  const f=await fixture(t);await f.open();await f.click('Details for Local Notes');const panel=f.document.querySelector('[data-codlet-panel]');assert.match(panel.textContent,/ui.dom/);assert.doesNotMatch(panel.textContent,/C:\/Projects\/Local Notes/);assert.doesNotMatch(panel.textContent,/Allowed network origins/);await f.click('Open plugin folder');assert.deepEqual(f.calls.find(c=>c.method==='openFolder').args,{pluginId:'local.notes'});
});
test('remove confirmation uses official unchecked checkbox and Escape cancels only the confirmation',async t=>{
  const f=await fixture(t);await f.open();await f.click('Details for Local Notes');await f.click('Remove Local Notes');assert.equal(f.control('Delete source files').getAttribute('aria-checked'),'false');assert.equal(f.calls.some(c=>c.method==='prepare'),false);await f.key(f.document.activeElement,'Escape');assert.equal(f.control('Delete source files'),undefined);assert.ok(f.control('Open plugin folder'));assert.ok(f.document.querySelector('[data-codlet-panel]'));
});
test('successful operations leave no persistent banner and leave other controls usable',async t=>{
  const f=await fixture(t);await f.open();await f.click('Enable Local Notes');assert.equal(f.control('Enable Local Notes').getAttribute('aria-checked'),'true');assert.equal(f.document.querySelector('.codlet-status.codlet-error'),null);assert.equal(f.control('Import plugins').disabled,false);
});
test('departing the page ignores late list errors and a new entry loads current state',async t=>{
  const f=await fixture(t),late=deferred();f.overrides.set('list',()=>late.promise);await f.open();await f.leave();f.overrides.delete('list');await f.open();late.reject(Error('old error'));await tick();assert.doesNotMatch(f.document.body.textContent,/old error/);assert.equal(f.document.querySelectorAll('[data-codlet-plugin]').length,5);
});
