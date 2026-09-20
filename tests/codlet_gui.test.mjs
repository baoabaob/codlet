import assert from 'node:assert/strict';
import test from 'node:test';
import {createPreviewRuntime} from '../scripts/preview-runtime.mjs';
import {uiFixture,tick,deferred} from './support/ui-fixture.mjs';
import {displayPath} from '../frontend/src/codlet/paths.js';
async function fixture(t,locale='en'){const demo=createPreviewRuntime(),f=uiFixture({locale,request:demo.request}),plugin=f.load('bundled/codlet/dist/renderer.js');t.after(()=>{plugin.deactivate();f.dispose();});await plugin.activate(f.context);return {...f,demo,plugin};}
async function importPlugins(f){const add=f.control('Add');add.focus();await f.key(add,'ArrowDown');await f.click('Import plugin');}
test('Codlet loads only on its native page and tears down on route changes',async t=>{
  const f=await fixture(t);assert.equal(f.calls.some(c=>c.method==='list'),false);assert.equal(f.document.querySelector('[data-codlet-panel]'),null);await f.open();assert.ok(f.document.querySelector('section[data-codlet-panel]'));assert.equal(f.document.querySelector('dialog'),null);assert.equal(f.document.activeElement,f.control('Search plugins'));await f.leave();assert.equal(f.document.querySelector('[data-codlet-panel]'),null);await f.open();assert.ok(f.control('Search plugins'));
});
test('rows show names, adjacent versions and descriptions without normal state labels or row tooltips',async t=>{
  const f=await fixture(t,'zh');await f.open();const row=f.document.querySelector('[data-codlet-plugin="codex.ui.adapter"]');assert.match(row.textContent,/Codex 界面适配器0\.1\.0/);assert.match(row.textContent,/将插件页面接入 Codex 主导航/);assert.equal(row.hasAttribute('title'),false);assert.doesNotMatch(row.textContent,/running|运行正常|not active/i);
});
test('search matches ID/name/description, Escape clears only search, and refresh preserves focus',async t=>{
  const f=await fixture(t);await f.open();await f.input('Search plugins','navigation');assert.equal(f.document.querySelectorAll('[data-codlet-plugin]').length,1);assert.equal(f.document.querySelector('[data-codlet-plugin]').dataset.codletPlugin,'codex.ui.adapter');
  assert.equal(f.control('Search plugins').type,'text');assert.equal(f.control('Search plugins').getAttribute('role'),'combobox');
  await f.click('Clear search');assert.equal(f.control('Search plugins').value,'');assert.equal(f.document.activeElement,f.control('Search plugins'));
  await f.input('Search plugins','navigation');await f.key(f.control('Search plugins'),'Escape');assert.equal(f.control('Search plugins').value,'');assert.ok(f.document.querySelector('[data-codlet-panel]'));f.control('Refresh plugins').click();await tick();assert.equal(f.document.activeElement,f.control('Search plugins'));
});
test('literal tags follow versions, survive locale changes, and remain searchable beside update controls',async t=>{
  const f=await fixture(t,'zh');await f.open();
  const row=()=>f.document.querySelector('[data-codlet-plugin="codex.ui.adapter"]');
  const labels=()=>[...row().querySelectorAll('.codlet-plugin-tag')].map(el=>el.getAttribute('aria-label'));
  assert.deepEqual(labels(),['#UI','#Adapter']);
  assert.equal(row().querySelector('.codlet-version').nextElementSibling.className,'codlet-plugin-tags');
  assert.equal(f.document.querySelector('[data-codlet-plugin="local.notes"] .codlet-plugin-tags'),null);
  await f.locale('en');assert.deepEqual(labels(),['#UI','#Adapter']);
  await f.input('Search plugins','#aDapTer');assert.deepEqual([...f.document.querySelectorAll('[data-codlet-plugin]')].map(el=>el.dataset.codletPlugin),['codex.ui.adapter','codex.desktop.adapter']);
  await f.click('Clear search');await f.click('Check for plugin updates');
  const managed=f.document.querySelector('[data-codlet-plugin="managed.notes"]');
  assert.ok(managed.querySelector('.codlet-plugin-tags'));assert.ok(f.control('Update GitHub Notes'));
});
test('search keeps IME drafts until composition ends',async t=>{
  const f=await fixture(t,'zh');await f.open();const input=f.control('搜索插件');input.dispatchEvent(new f.window.CompositionEvent('compositionstart',{bubbles:true}));await f.input('搜索插件','笔记');assert.equal(f.document.querySelectorAll('[data-codlet-plugin]').length,5);input.dispatchEvent(new f.window.CompositionEvent('compositionend',{bubbles:true}));await tick();assert.equal(f.document.querySelectorAll('[data-codlet-plugin]').length,0);
});
test('automatic folder preview, official grants and language changes preserve current form state',async t=>{
  const f=await fixture(t);await f.open();await importPlugins(f);await f.click('Choose plugin folder');assert.equal(f.control('Plugin folder').value,'C:/Projects/Local Notes');assert.equal(f.control('Confirm local import').disabled,true);await f.click('Trust this local plugin');await f.click('Grant ui.dom');assert.equal(f.control('Confirm local import').disabled,false);await f.locale('zh');assert.equal(f.control('插件文件夹').value,'C:/Projects/Local Notes');assert.equal(f.control('确认导入本地插件').disabled,false);assert.equal(f.document.querySelectorAll('a[href="https://github.com/topics/codlet-plugin"]').length,1);
});
test('Windows picker paths hide only display prefixes and retain the original preview path',async t=>{
  const f=await fixture(t);await f.open();await importPlugins(f);
  const cases=[['\\\\?\\C:\\Projects\\插件','C:\\Projects\\插件'],['\\\\?\\UNC\\server\\share\\plugin','\\\\server\\share\\plugin']];
  for(const [original,shown] of cases) {
    f.overrides.set('chooseLocalFolder',()=>({selectionId:'picked',status:'selected',path:original}));await f.click('Choose plugin folder');
    assert.equal(f.control('Plugin folder').value,shown);assert.equal(f.calls.filter(c=>c.method==='previewLocal').at(-1).args.path,original);
  }
  for(const unchanged of ['C:\\Author\\plugin','\\\\server\\share\\plugin','\\\\?\\Volume{123}\\plugin','\\\\.\\pipe\\example','/home/author/plugin'])assert.equal(displayPath(unchanged),unchanged);
  await f.input('Plugin folder','C:\\Edited\\plugin');await new Promise(resolve=>setTimeout(resolve,450));await tick();
  assert.equal(f.calls.filter(c=>c.method==='previewLocal').at(-1).args.path,'C:\\Edited\\plugin');assert.equal(f.control('Plugin folder').value,'C:\\Edited\\plugin');
});
test('normal versions have no extra header info; navigation and actions use the owned native toolbar',async t=>{
  const f=await fixture(t);await f.open();assert.equal(f.control('Version and compatibility'),undefined);assert.equal(f.document.querySelector('.codlet-warning-icon'),null);assert.doesNotMatch(f.document.querySelector('.codlet-brand').textContent,/Development/);
  assert.ok(f.control('Settings').closest('[data-codlet-page-toolbar]'));assert.ok(f.control('Add').closest('[data-codlet-page-toolbar]'));
  await f.click('Settings');assert.deepEqual([...f.document.querySelectorAll('.codlet-version-details dt')].map(el=>el.textContent),['Codlet version','Current client version','Codlet adapted version']);assert.deepEqual([...f.document.querySelectorAll('.codlet-version-details dd')].map(el=>el.textContent),['0.1.0','26.908.4834.0','26.908.4834.0']);assert.doesNotMatch(f.document.getElementById('codlet-version-section').textContent,/Update channel|Latest client|Official published client|Check for client updates|Installed client|Next automatic check/);await f.leave();assert.equal(f.document.querySelector('.codlet-top-toolbar'),null);assert.equal(f.document.querySelector('[data-codlet-panel]'),null);
});
test('version navigation waits for delayed settings layout before scrolling to the actual section',async t=>{
  const f=await fixture(t),loading=deferred(),scrolls=[];f.demo.state.phase='available';f.overrides.set('getSettings',()=>loading.promise);
  f.window.HTMLElement.prototype.scrollIntoView=function(options){scrolls.push({target:this,options,rows:f.document.querySelectorAll('.codlet-setting-row').length});};
  await f.open();const warning=f.document.querySelector('.codlet-warning-icon').closest('button');warning.focus();warning.click();await tick();
  assert.equal(scrolls.length,0);assert.equal(f.document.querySelector('.codlet-version-highlight'),null);
  loading.resolve(await f.demo.request(null,'getSettings',null));await tick();await tick();
  assert.equal(scrolls.length,1);assert.equal(scrolls[0].target,f.document.getElementById('codlet-version-section'));assert.equal(scrolls[0].rows,6);assert.equal(scrolls[0].options.block,'start');
  assert.equal(f.document.activeElement,f.document.getElementById('codlet-version-heading'));assert.ok(f.document.querySelector('#codlet-version-section .codlet-sr-only[role=status]'));
});
test('switching internal pages resets the scroll position without losing their headers',async t=>{
  const f=await fixture(t);await f.open();await f.click('Settings');const scroll=f.document.querySelector('.codlet-scroll');scroll.scrollTop=260;
  await f.click('Plugin management');assert.equal(scroll.scrollTop,0);scroll.scrollTop=180;await importPlugins(f);assert.equal(scroll.scrollTop,0);
  scroll.scrollTop=120;await f.click('Back');assert.equal(scroll.scrollTop,0);
});
test('a focused row leaving the selected filter restores focus to that filter only',async t=>{
  const f=await fixture(t);await f.open();await f.click('Not enabled');assert.equal(f.document.querySelectorAll('[data-codlet-plugin]').length,1);
  await f.click('Enable Local Notes');assert.equal(f.document.querySelectorAll('[data-codlet-plugin]').length,0);assert.equal(f.document.activeElement,f.control('Not enabled'));
  const search=f.control('Search plugins');search.focus();f.control('Refresh plugins').click();await tick();assert.equal(f.document.activeElement,search);
});
test('settings replaces interval and plugin checking with truthful counts, and Codlet check works without opening another view',async t=>{
  const f=await fixture(t);await f.open();await f.click('Settings');
  assert.equal(f.control('Check interval'),undefined);assert.equal(f.control('Check for plugin updates'),undefined);
  assert.deepEqual([...f.document.querySelectorAll('.codlet-plugin-summary dd')].map(n=>n.textContent),['5','4','1','0']);
  assert.equal(f.control('Check for Codlet updates').disabled,false);await f.click('Check for Codlet updates');
  assert.equal(f.calls.filter(c=>c.method==='checkRuntimeUpdate').length,1);assert.equal(f.calls.filter(c=>c.method==='checkPluginUpdates').length,0);
});
test('plugin tag visibility is enabled by default, persists through settings, and updates the list immediately',async t=>{
  const f=await fixture(t);await f.open();
  assert.ok(f.document.querySelector('[data-codlet-plugin="codex.ui.adapter"] .codlet-plugin-tags'));
  await f.click('Settings');assert.equal(f.control('Show plugin tags').getAttribute('aria-checked'),'true');
  await f.click('Show plugin tags');assert.equal(f.demo.state.settings.showPluginTags,false);
  await f.click('Plugin management');assert.equal(f.document.querySelector('[data-codlet-plugin="codex.ui.adapter"] .codlet-plugin-tags'),null);
  await f.click('Settings');assert.equal(f.control('Show plugin tags').getAttribute('aria-checked'),'false');
  await f.click('Show plugin tags');await f.click('Plugin management');assert.ok(f.document.querySelector('[data-codlet-plugin="codex.ui.adapter"] .codlet-plugin-tags'));
});
test('details show actual grants without the raw source path; folder opening passes only plugin ID',async t=>{
  const f=await fixture(t);await f.open();await f.click('Details for Local Notes');const panel=f.document.querySelector('[data-codlet-panel]');assert.match(panel.textContent,/ui.dom/);assert.doesNotMatch(panel.textContent,/C:\/Projects\/Local Notes/);assert.doesNotMatch(panel.textContent,/Allowed network origins/);await f.click('Open plugin folder');assert.deepEqual(f.calls.find(c=>c.method==='openFolder').args,{pluginId:'local.notes'});
});
test('remove confirmation uses official unchecked checkbox and Escape cancels only the confirmation',async t=>{
  const f=await fixture(t);await f.open();await f.click('Details for Local Notes');await f.click('Remove Local Notes');assert.equal(f.control('Delete source files').getAttribute('aria-checked'),'false');assert.equal(f.calls.some(c=>c.method==='prepare'),false);await f.key(f.document.activeElement,'Escape');assert.equal(f.control('Delete source files'),undefined);assert.ok(f.control('Open plugin folder'));assert.ok(f.document.querySelector('[data-codlet-panel]'));
});
test('removal lists the full Core dependent closure with localized names and keeps source deletion optional',async t=>{
  const f=await fixture(t,'zh');
  f.overrides.set('list',async args=>{const reply=await f.demo.request(null,'list',args);reply.plugins.find(p=>p.id==='local.notes').disableDependents=['managed.notes','dev.extra','managed.notes'];reply.plugins.push({id:'dev.extra',name:'Extra panel',i18n:{zh:{name:'附加面板'}},version:'1.0.0',enabled:true,source:'local'});return reply;});
  await f.open();await f.click('Local Notes 的详情');await f.click('移除 Local Notes');
  const affected=f.document.querySelector('.codlet-affected-plugins');assert.ok(affected);
  assert.deepEqual([...affected.querySelectorAll('.codlet-plugin-name')].map(el=>el.textContent),['GitHub Notes','附加面板']);
  assert.match(affected.parentElement.textContent,/间接依赖|安装记录和文件会保留/);
  assert.equal(f.calls.some(c=>c.method==='prepare'),false);await f.click('取消');assert.equal(f.calls.some(c=>c.method==='submit'),false);
});
test('successful operations leave no persistent banner and leave other controls usable',async t=>{
  const f=await fixture(t);await f.open();await f.click('Enable Local Notes');assert.equal(f.control('Enable Local Notes').getAttribute('aria-checked'),'true');assert.equal(f.document.querySelector('.codlet-status.codlet-error'),null);assert.equal(f.control('Add').disabled,false);
});
test('official Add menu follows refresh and opens creation as an editable native draft',async t=>{
  const f=await fixture(t);await f.open();const button=f.control('Add');assert.ok(button.querySelector('svg'));assert.equal(button.textContent,'Add');
  assert.deepEqual([...button.closest('.codlet-toolbar-actions').querySelectorAll('button')].map(el=>el.getAttribute('aria-label')),['Refresh plugins','Add']);
  button.focus();await f.key(button,'ArrowDown');const menu=f.document.querySelector('[role=menu]');assert.ok(menu);const create=[...menu.querySelectorAll('[role=menuitem]')].find(el=>el.textContent.startsWith('Create plugin'));assert.notEqual(create.getAttribute('aria-disabled'),'true');
  assert.equal(menu.closest('[data-codlet-page-overlays]').parentElement,f.document.body);assert.equal(menu.closest('[data-codlet-page-toolbar]'),null);
  await f.key(f.document.activeElement,'Escape');assert.equal(button.getAttribute('aria-expanded'),'false');assert.equal(f.document.activeElement,button);
  await f.key(button,'ArrowDown');await f.click('Create plugin');assert.equal(f.demo.state.draft,'[$codlet](C:/Preview/runtime-skills/codlet/SKILL.md) Help me create a plugin:');assert.equal(f.calls.filter(c=>c.method==='newTaskDraft').length,1);assert.equal(f.calls.some(c=>['prepare','submit','turns.start'].includes(c.method)),false);
  await importPlugins(f);await f.click('Import from GitHub');assert.equal(f.control('Find versions').textContent,'Find versions');await f.locale('zh');assert.equal(f.control('查找版本').textContent,'查找版本');
});
test('descriptions have no terminal periods in either locale and preserve internal punctuation',async t=>{
  const f=await fixture(t);await f.open();
  for(const language of ['en','zh']){await f.locale(language);for(const node of f.document.querySelectorAll('.codlet-subtitle,.codlet-plugin-description'))assert.doesNotMatch(node.textContent,/[。.]$/);}
  await f.locale('en');await f.click('Settings');for(const node of f.document.querySelectorAll('.codlet-setting-copy .codlet-copy'))assert.doesNotMatch(node.textContent,/[。.]$/);
});
test('startup plugin update preference persists and Update all installs without manual download steps',async t=>{
  const f=await fixture(t);await f.open();await f.click('Settings');await f.click('Check for plugin updates at startup');
  assert.equal(f.demo.state.settings.checkPluginUpdatesOnStartup,false);await f.click('Plugin management');await f.click('Settings');assert.equal(f.control('Check for plugin updates at startup').getAttribute('aria-checked'),'false');
  await f.click('Plugin management');await f.click('Check for plugin updates');assert.equal(f.calls.filter(c=>c.method==='checkPluginUpdates').length,1);assert.ok(f.control('Update GitHub Notes'));
  assert.equal(f.control('Update all (1)').closest('.codlet-list-toolbar'),f.control('All').closest('.codlet-list-toolbar'));assert.equal(f.control('Update all (1)').closest('[data-codlet-page-toolbar]'),null);
  await f.locale('zh');assert.equal(f.control('更新 GitHub Notes').textContent,'更新');assert.ok(f.control('全部更新 (1)'));
  await f.click('全部更新 (1)');assert.equal(f.calls.filter(c=>c.method==='updatePlugins').length,1);assert.equal(f.calls.some(c=>['githubPrepare','prepare','submit'].includes(c.method)),false);assert.equal(f.document.querySelector('[data-codlet-plugin="managed.notes"] .codlet-version').textContent,'3.0.0');
  assert.equal(f.control('全部更新 (1)'),undefined);assert.equal(f.control('更新 GitHub Notes'),undefined);
});
test('completed mutation plus failed refresh shows an error and disables stale switches until refreshed',async t=>{
  const f=await fixture(t);await f.open();f.demo.state.failure=true;await f.click('Enable Local Notes');
  assert.match(f.document.querySelector('[role=alert]').textContent,/Displayed values may be out of date/);assert.equal(f.control('Enable Local Notes').disabled,true);assert.equal(f.control('Enable Local Notes').getAttribute('aria-checked'),'false');
  f.demo.state.failure=false;await f.click('Refresh plugins');assert.equal(f.control('Enable Local Notes').disabled,false);assert.equal(f.control('Enable Local Notes').getAttribute('aria-checked'),'true');assert.equal(f.calls.filter(c=>c.method==='submit').length,1);
});
test('cancel and Escape restore the confirmation trigger, with search as fallback after removal',async t=>{
  const f=await fixture(t);await f.open();await f.click('Enable Codlet GUI');await f.key(f.document.activeElement,'Escape');assert.equal(f.document.activeElement,f.control('Enable Codlet GUI'));
  await f.click('Details for Local Notes');
  for(const label of ['Remove Local Notes','Revoke ui.dom']) {
    await f.click(label);await f.locale('zh');await f.locale('en');await f.click('Cancel');assert.equal(f.document.activeElement,f.control(label));
    await f.click(label);await f.key(f.document.activeElement,'Escape');assert.equal(f.document.activeElement,f.control(label));
  }
  await f.click('Remove Local Notes');await f.click('Remove');assert.equal(f.document.activeElement,f.control('Search plugins'));assert.equal(f.control('Remove Local Notes'),undefined);
});
test('departing the page ignores late list errors and a new entry loads current state',async t=>{
  const f=await fixture(t),late=deferred();f.overrides.set('list',()=>late.promise);await f.open();await f.leave();f.overrides.delete('list');await f.open();late.reject(Error('old error'));await tick();assert.doesNotMatch(f.document.body.textContent,/old error/);assert.equal(f.document.querySelectorAll('[data-codlet-plugin]').length,5);
});
