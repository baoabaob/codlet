import assert from 'node:assert/strict';
import test from 'node:test';
import {tagCatalog,tagAtCaret,suggestTags,insertTag} from '../frontend/src/codlet/tag-search.js';
import {createPreviewRuntime} from '../scripts/preview-runtime.mjs';
import {uiFixture,tick} from './support/ui-fixture.mjs';

test('tag completion respects token boundaries, caret position and selected literal labels',()=>{
  const catalog=tagCatalog([{tags:['UI','Adapter','工具']},{tags:['ui','Tool']},{}]);
  assert.deepEqual(catalog,['Adapter','Tool','UI','工具']);
  for(const query of ['plain','repo#UI','https://example.com/#UI','#UI '])assert.equal(tagAtCaret(query,query.length),null);
  assert.equal(tagAtCaret('#UI',1,3),null);
  const query='notes #To #UI',token=tagAtCaret(query,8);
  assert.deepEqual(token,{start:6,end:9,prefix:'T'});
  assert.deepEqual(suggestTags(catalog,query,token),['Tool']);
  assert.deepEqual(insertTag(query,'Tool',token),{query:'notes #Tool #UI',caret:12});
  assert.deepEqual(suggestTags(catalog,'#uI #',tagAtCaret('#uI #',5)),['Adapter','Tool','工具']);
  assert.deepEqual(insertTag('notes #uI','UI'),{query:'notes #uI',caret:9});
  assert.deepEqual(insertTag('notes','工具'),{query:'notes #工具 ',caret:10});
});

async function fixture(t,{locale='en',showTags=true}={}){
  const demo=createPreviewRuntime();demo.state.settings.showPluginTags=showTags;
  const f=uiFixture({locale,request:demo.request}),plugin=f.load('bundled/codlet/dist/renderer.js');
  t.after(()=>{plugin.deactivate();f.dispose();});await plugin.activate(f.context);await f.open();return {...f,demo};
}
const rows=f=>[...f.document.querySelectorAll('[data-codlet-plugin]')].map(n=>n.dataset.codletPlugin);
const options=f=>[...f.document.querySelectorAll('[role=option]')].map(n=>n.getAttribute('aria-label'));
const search=f=>f.document.querySelector('[data-codlet-plugin-search]');

test('clicking tags adds an intersection filter, preserves text, avoids duplicates and keeps search focus',async t=>{
  const f=await fixture(t);await f.input('Search plugins','adapter');
  await f.click('#UI');assert.equal(search(f).value,'adapter #UI ');assert.deepEqual(rows(f),['codex.ui.adapter']);assert.equal(f.document.activeElement,search(f));
  await f.click('#UI');assert.equal(search(f).value,'adapter #UI ');
  await f.click('#Adapter');assert.equal(search(f).value,'adapter #UI #Adapter ');assert.equal(f.control('#Adapter').getAttribute('aria-pressed'),'true');
  await f.click('Not enabled');assert.deepEqual(rows(f),[]);assert.equal(search(f).value,'adapter #UI #Adapter ');
  assert.equal(f.calls.some(c=>['prepare','submit','updatePlugins','newTaskDraft'].includes(c.method)),false);
});

test('hash suggestions use all installed tags and keyboard completion applies the highlighted tag',async t=>{
  const f=await fixture(t);await f.input('Search plugins','#');
  assert.deepEqual(options(f),['#Adapter','#Enhancement','#Tool','#UI']);assert.equal(search(f).getAttribute('aria-expanded'),'true');assert.equal(f.document.activeElement,search(f));
  await f.key(search(f),'ArrowDown');const selected=f.document.querySelector('[role=option][aria-selected=true]');assert.equal(selected.getAttribute('aria-label'),'#Enhancement');assert.equal(search(f).getAttribute('aria-activedescendant'),selected.id);
  await f.key(search(f),'Enter');assert.equal(search(f).value,'#Enhancement ');assert.deepEqual(rows(f),['managed.notes']);assert.equal(search(f).getAttribute('aria-expanded'),'false');assert.equal(search(f).selectionStart,13);
  await f.input('Search plugins','#aD');assert.deepEqual(options(f),['#Adapter']);await f.key(search(f),'Enter');assert.equal(search(f).value,'#Adapter ');assert.deepEqual(rows(f),['codex.ui.adapter','codex.desktop.adapter']);
  await f.input('Search plugins','#UI #');assert.deepEqual(options(f),['#Adapter','#Enhancement','#Tool']);
  await f.leave();assert.equal(f.document.querySelector('[role=listbox]'),null);
});

test('pointer completion replaces the token at the caret without deleting following text or tags',async t=>{
  const f=await fixture(t);await f.input('Search plugins','notes #To #Enhancement');
  search(f).setSelectionRange(9,9);await f.key(search(f),'ArrowRight');assert.deepEqual(options(f),['#Tool']);
  const option=f.document.querySelector('[role=option]');option.dispatchEvent(new f.window.PointerEvent('pointerdown',{bubbles:true,cancelable:true}));option.click();await tick();
  assert.equal(search(f).value,'notes #Tool #Enhancement');assert.equal(search(f).selectionStart,12);assert.equal(f.document.activeElement,search(f));assert.deepEqual(rows(f),['managed.notes']);
});

test('Escape dismisses suggestions before clearing search, Tab leaves normal navigation and blur closes the menu',async t=>{
  const f=await fixture(t);await f.input('Search plugins','#');await f.key(search(f),'Escape');assert.equal(search(f).value,'#');assert.equal(search(f).getAttribute('aria-expanded'),'false');
  await f.key(search(f),'Escape');assert.equal(search(f).value,'');assert.equal(rows(f).length,5);
  await f.input('Search plugins','#To');const key=new f.window.KeyboardEvent('keydown',{key:'Tab',bubbles:true,cancelable:true});search(f).dispatchEvent(key);await tick();assert.equal(key.defaultPrevented,false);assert.equal(search(f).value,'#To');assert.equal(search(f).getAttribute('aria-expanded'),'false');
  await f.input('Search plugins','#');f.control('Settings').focus();await tick();assert.equal(f.document.querySelector('[role=listbox]'),null);
});

test('IME composition cannot select a tag or filter before committing composed text',async t=>{
  const f=await fixture(t,{locale:'zh'}),input=search(f);
  input.dispatchEvent(new f.window.CompositionEvent('compositionstart',{bubbles:true}));await f.input('搜索插件','#U');await f.key(input,'Enter',{isComposing:true});
  assert.equal(rows(f).length,5);assert.equal(input.value,'#U');assert.equal(f.document.querySelector('[role=listbox]'),null);
  input.dispatchEvent(new f.window.CompositionEvent('compositionend',{bubbles:true}));await tick();assert.deepEqual(options(f),['#UI']);await f.key(input,'Enter');assert.equal(input.value,'#UI ');assert.equal(rows(f).length,2);
});

test('hidden row labels still offer localized suggestions and refresh cannot leave an invalid active option',async t=>{
  const f=await fixture(t,{showTags:false,locale:'zh'});assert.equal(f.document.querySelector('.codlet-plugin-tag'),null);
  await f.input('搜索插件','#');assert.deepEqual(options(f),['#Adapter','#Enhancement','#Tool','#UI']);await f.locale('en');assert.equal(f.document.querySelector('[role=listbox]').getAttribute('aria-label'),'Tag suggestions');
  await f.input('Search plugins','#missing');assert.equal(f.document.querySelector('.codlet-tag-empty').textContent,'No matching tags');assert.equal(search(f).hasAttribute('aria-activedescendant'),false);
  await f.input('Search plugins','#');f.overrides.set('list',async()=>{const reply=await f.demo.request(null,'list');reply.plugins=reply.plugins.map(p=>({...p,tags:[]}));return reply;});f.control('Refresh plugins').click();await tick();assert.deepEqual(options(f),[]);assert.equal(search(f).hasAttribute('aria-activedescendant'),false);assert.deepEqual(f.errors,[]);
});
