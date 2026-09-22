import assert from 'node:assert/strict';
import test from 'node:test';
import {uiFixture,tick,deferred} from './support/ui-fixture.mjs';
test('actual official controls preserve independent owners and synchronous teardown',async t=>{
  const f=uiFixture();t.after(()=>f.dispose());const a=f.context.ui.create(),b=f.context.ui.create(),h=a.React.createElement;
  const node=a.container();a.mount(node,h(a.components.Switch,{checked:true,'aria-label':'Enabled'}));
  b.mount(b.container(),h(b.components.Button,{color:'primary'},'Other'));
  assert.equal(f.control('Enabled').getAttribute('role'),'switch');assert.equal(f.control('Enabled').getAttribute('aria-checked'),'true');
  a.dispose();assert.equal(a.signal.aborted,true);assert.equal(f.control('Enabled'),undefined);assert.equal(f.document.querySelectorAll('[data-codlet-official-styles]').length,1);
  b.dispose();assert.equal(f.document.querySelectorAll('[data-codlet-official-styles]').length,0);assert.throws(()=>a.container(),{code:'ui_disposed'});
});
test('official portals stay within their owner; Escape closes them and does not escape to host',async t=>{
  const f=uiFixture();t.after(()=>f.dispose());const ui=f.context.ui.create(),h=ui.React.createElement,C=ui.components,node=ui.container();let hostEscapes=0;
  f.document.addEventListener('keydown',event=>{if(event.key==='Escape')hostEscapes++;});
  ui.mount(node,h(C.Popover,null,h(C.Popover.Trigger,null,h(C.Button,{'aria-label':'Info',color:'secondary'},'Info')),h(C.Popover.Content,null,h('p',null,'Compatibility'))));
  await f.click('Info');assert.ok(node.querySelector('[data-radix-popper-content-wrapper]'));
  const trigger=f.control('Info');await f.key(f.document.activeElement,'Escape');assert.equal(trigger.getAttribute('aria-expanded'),'false');assert.equal(hostEscapes,0);
  await f.key(f.document.getElementById('host-editor'),'Escape');assert.equal(hostEscapes,1);
  ui.dispose();assert.equal(f.document.querySelector('[data-radix-popper-content-wrapper]'),null);
});
test('modified and composing Escape do not close a plugin confirmation',async t=>{
  const f=uiFixture();t.after(()=>f.dispose());const ui=f.context.ui.create(),h=ui.React.createElement;let count=0;
  function View(){ui.useEscCloseStack(true,()=>count++);return h(ui.components.Button,{'aria-label':'Confirm',color:'primary'},'Confirm');}
  ui.mount(ui.container(),h(View));await tick();
  for(const modifier of [{isComposing:true},{ctrlKey:true},{metaKey:true},{shiftKey:true},{altKey:true}])await f.key(f.control('Confirm'),'Escape',modifier);
  assert.equal(count,0);await f.key(f.control('Confirm'),'Escape');assert.equal(count,1);
});
test('native page departures unmount controls, retire portals and remount with fresh effects',async t=>{
  const f=uiFixture();t.after(()=>f.dispose());const ui=f.context.ui.create(),h=ui.React.createElement;let mounted=0,unmounted=0,opens=0,closes=0;
  function View(){ui.React.useEffect(()=>{mounted++;return()=>unmounted++;},[]);return h(ui.components.Input,{'aria-label':'Page input'});}
  await ui.page({label:'Page',render:()=>h(View),onActivate:()=>opens++,onDeactivate:()=>closes++});assert.equal(f.control('Page input'),undefined);
  await f.open();assert.equal(mounted,1);assert.equal(opens,1);await f.leave();assert.equal(unmounted,1);assert.equal(closes,1);assert.equal(f.control('Page input'),undefined);
  await f.open();assert.equal(mounted,2);ui.dispose();assert.equal(unmounted,2);assert.equal(f.document.querySelector('[data-codlet-page-lease]'),null);
});
test('a retired page registration cannot mount or leak its lifetime marker',async t=>{
  const f=uiFixture();t.after(()=>f.dispose());const reply=deferred();f.overrides.set('register',()=>reply.promise);const ui=f.context.ui.create();
  const result=ui.page({label:'Page',render:()=>null});ui.dispose();assert.equal(f.document.querySelector('[data-codlet-page-lease]'),null);reply.resolve({api:1,token:'late',path:'/codlet/late'});await assert.rejects(result);
  assert.equal(f.document.querySelector('[data-codlet-page-lease]'),null);assert.equal(f.document.querySelector('[data-codlet-official-ui]'),null);
});
test('inactive pages skip message mutations and still discover nested hosts, toolbar replacements and retirement',async t=>{
  const f=uiFixture();t.after(()=>f.dispose());const ui=f.context.ui.create(),h=ui.React.createElement;
  await ui.page({label:'Page',toolbar:true,render:({toolbar})=>h(ui.React.Fragment,null,h('p',null,'Profile page'),ui.createPortal(h('b',null,'Toolbar'),toolbar))});await tick();
  const original=f.document.querySelectorAll.bind(f.document);let scans=0;
  f.document.querySelectorAll=(selector,...args)=>{if(selector==='[data-codlet-page-host]')scans++;return original(selector,...args);};
  const stream=f.document.createElement('article');f.document.querySelector('main').append(stream);await tick();scans=0;
  for(let i=0;i<30;i++){stream.textContent=String(i);await Promise.resolve();await Promise.resolve();}
  assert.equal(scans,0);
  const lease=f.document.querySelector('[data-codlet-page-lease]'),wrapper=f.document.createElement('div'),host=f.document.createElement('section'),toolbar=f.document.createElement('header');
  host.dataset.codletPageHost=lease.dataset.codletPageLease;toolbar.dataset.codletPageToolbar=lease.dataset.codletPageLease;wrapper.append(host,toolbar);f.document.body.append(wrapper);await tick();
  assert.equal(host.textContent,'Profile page');assert.equal(toolbar.textContent,'Toolbar');
  const replacement=toolbar.cloneNode(false);toolbar.replaceWith(replacement);await tick();assert.equal(replacement.textContent,'Toolbar');
  wrapper.remove();await tick();assert.equal(f.document.querySelector('[data-codlet-official-ui]'),null);
  lease.remove();await tick();ui.dispose();assert.equal(f.mediaListeners.size,0);assert.equal(f.errors.length,0);
  f.document.querySelectorAll=original;
});
test('locale/theme sync is scoped and never rewrites the host',async t=>{
  const f=uiFixture();t.after(()=>f.dispose());const ui=f.context.ui.create(),node=ui.container();f.document.documentElement.dataset.theme='dark';await f.locale('zh');
  assert.equal(node.dataset.theme,'dark');assert.equal(node.lang,'zh');assert.equal(f.document.documentElement.dataset.theme,'dark');
  assert.equal(f.document.getElementById('host-editor').getAttribute('data-theme'),null);
});
test('host semantic colors bridge to official tokens and follow host theme changes',async t=>{
  const f=uiFixture();t.after(()=>f.dispose());const body=f.document.body;
  body.style.setProperty('--color-chart-blue','rgb(173, 81, 21)');body.style.setProperty('--color-control-thumb-on-accent','rgb(255, 253, 249)');body.style.setProperty('--color-ring','rgb(165, 79, 18)');
  // The audited native .bg-page-search utility reads this exact host token.
  body.style.setProperty('--color-background-page-search','rgb(45, 45, 45)');
  body.style.setProperty('--color-page-search','rgb(200, 0, 0)'); // Wrong host name must not win.
  const ui=f.context.ui.create(),node=ui.container();
  assert.equal(node.style.getPropertyValue('--switch-track-color-checked'),'rgb(173, 81, 21)');assert.equal(node.style.getPropertyValue('--switch-thumb-color'),'rgb(255, 253, 249)');assert.equal(node.style.getPropertyValue('--color-ring'),'rgb(165, 79, 18)');
  assert.equal(node.style.getPropertyValue('--color-page-search'),'rgb(45, 45, 45)');
  assert.match(node.style.getPropertyValue('--switch-track-color-checked-disabled'),/var\(--switch-track-color-checked\)/);
  body.style.setProperty('--color-chart-blue','rgb(128, 175, 237)');f.document.documentElement.dataset.theme='dark';await tick();assert.equal(node.style.getPropertyValue('--switch-track-color-checked'),'rgb(128, 175, 237)');assert.equal(node.style.colorScheme,'dark');
  body.style.removeProperty('--color-chart-blue');await tick();assert.equal(node.style.getPropertyValue('--switch-track-color-checked'),'');assert.equal(body.style.getPropertyValue('--switch-track-color-checked'),'');assert.equal(node.style.getPropertyValue('--switch-track-color-checked-disabled'),'');
});
for(const failure of ['callback','react'])for(const exit of ['navigation','page','owner'])test(`${exit} cleanup survives a throwing ${failure} and retires every owned resource`,async t=>{
  const f=uiFixture();t.after(()=>f.dispose());const baseline={observers:f.observers.size,media:f.mediaListeners.size,cleanups:f.cleanups.size};
  const a=f.context.ui.create(),b=f.context.ui.create(),h=a.React.createElement;let effects=0,callbacks=0,siblings=0;
  function Broken(){a.React.useLayoutEffect(()=>()=>{effects++;if(failure==='react')throw Error('React cleanup failed');},[]);return h(a.components.Input,{'aria-label':'Broken page'});}
  function Sibling(){a.React.useEffect(()=>()=>{siblings++;},[]);return h(a.components.Button,{color:'secondary'},'Sibling');}
  a.mount(a.container(),h(Sibling));b.mount(b.container(),h(b.components.Button,{'aria-label':'Surviving owner',color:'primary'},'Other'));
  const page=await a.page({label:'Page',render:()=>h(Broken),onDeactivate(){callbacks++;if(failure==='callback')throw Error('Page callback failed');}});await f.open();
  const expected=failure==='react'?/React cleanup failed/:/Page callback failed/;
  if(exit==='navigation'){await f.leave();assert.match(f.errors.find(error=>error.code==='ui_cleanup_failed')?.message??'',expected);}
  else assert.throws(()=>exit==='page'?page.dispose():a.dispose(),expected);
  assert.equal(effects,1);assert.equal(callbacks,1);assert.equal(f.control('Broken page'),undefined);assert.equal(f.document.querySelector('[data-codlet-page-lease]'),null);
  assert.doesNotThrow(()=>page.dispose());assert.doesNotThrow(()=>a.dispose());assert.equal(siblings,1);assert.equal(a.signal.aborted,true);
  assert.ok(f.control('Surviving owner'));assert.equal(f.document.querySelectorAll('[data-codlet-official-styles]').length,1);
  b.dispose();assert.equal(f.document.querySelector('[data-codlet-official-ui]'),null);assert.equal(f.document.querySelector('[data-codlet-official-styles]'),null);
  assert.equal(f.observers.size,baseline.observers);assert.equal(f.mediaListeners.size,baseline.media);assert.equal(f.cleanups.size,baseline.cleanups);
  const fresh=f.context.ui.create();fresh.mount(fresh.container(),h(fresh.components.Button,{color:'primary'},'Fresh'));fresh.dispose();assert.equal(f.document.querySelector('[data-codlet-official-styles]'),null);
});
test('owner teardown aggregates multiple page failures and still retires later pages and roots',async t=>{
  const f=uiFixture();t.after(()=>f.dispose());const ui=f.context.ui.create(),h=ui.React.createElement;let first=0,second=0;
  function BrokenRoot(){ui.React.useLayoutEffect(()=>()=>{throw Error('Standalone React cleanup failed');},[]);return h('p',null,'Standalone');}
  ui.mount(ui.container(),h(BrokenRoot));
  await ui.page({label:'First',render:()=>h('p',null,'First'),onDeactivate(){first++;throw Error('First callback failed');}});await f.open();
  await ui.page({label:'Second',render:()=>h('p',null,'Second'),onDeactivate(){second++;throw Error('Second callback failed');}});
  // Both native hosts are deliberately connected to exercise teardown of
  // multiple live pages even if the host is in a transient navigation state.
  const lease=[...f.document.querySelectorAll('[data-codlet-page-lease]')].at(-1),host=f.document.createElement('div');host.dataset.codletPageHost=lease.dataset.codletPageLease;f.document.querySelector('main').append(host);await tick();
  assert.throws(()=>ui.dispose(),error=>/First callback failed/.test(error.message)&&/Second callback failed/.test(error.message)&&/Standalone React cleanup failed/.test(error.message));
  assert.equal(first,1);assert.equal(second,1);assert.equal(f.document.querySelector('[data-codlet-page-lease]'),null);assert.equal(f.document.querySelector('[data-codlet-official-ui]'),null);assert.equal(f.document.querySelector('[data-codlet-official-styles]'),null);assert.doesNotThrow(()=>ui.dispose());
});
test('a native toolbar portal shares page state and is removed on departure and callback failure',async t=>{
  for(const fail of [false,true]){
    const f=uiFixture();t.after(()=>f.dispose());const ui=f.context.ui.create(),h=ui.React.createElement;let cleanups=0;
    function View({toolbar}){const [count,setCount]=ui.React.useState(0);ui.React.useEffect(()=>()=>cleanups++,[]);return h(ui.React.Fragment,null,h('output',{'data-counter':''},count),ui.createPortal(h(ui.components.Button,{color:'secondary','aria-label':'Toolbar increment',onClick:()=>setCount(count+1)},'Add'),toolbar));}
    const page=await ui.page({label:'Page',toolbar:true,render:surface=>h(View,surface),onDeactivate(){if(fail)throw Error('toolbar page cleanup failed');}});
    await f.open();assert.equal(f.document.querySelectorAll('[data-codlet-official-ui]').length,3);assert.ok(f.control('Toolbar increment').closest('[data-codlet-page-toolbar]'));
    await f.click('Toolbar increment');assert.equal(f.document.querySelector('[data-counter]').textContent,'1');await f.leave();assert.equal(cleanups,1);assert.equal(f.control('Toolbar increment'),undefined);
    if(fail){assert.match(f.errors.find(error=>error.code==='ui_cleanup_failed').message,/toolbar page cleanup failed/);assert.equal(f.document.querySelector('[data-codlet-page-lease]'),null);}
    else{await f.open();assert.equal(f.document.querySelector('[data-counter]').textContent,'0');}
    if(fail)page.dispose();else await f.leave();ui.dispose();assert.equal(f.document.querySelector('[data-codlet-official-ui]'),null);assert.equal(f.document.querySelector('[data-codlet-official-styles]'),null);
  }
});
test('an auxiliary toolbar page retires both pending containers without calling render',async t=>{
  const f=uiFixture();t.after(()=>f.dispose());f.overrides.set('register',args=>({api:1,token:args.token,path:null,available:false}));const ui=f.context.ui.create();let renders=0;
  const page=await ui.page({label:'No page',toolbar:true,render:()=>{renders++;return null;}});assert.equal(page.path,null);assert.equal(renders,0);assert.equal(f.document.querySelector('[data-codlet-official-ui]'),null);assert.equal(f.document.querySelector('[data-codlet-page-lease]'),null);ui.dispose();
});
test('page tooltips escape toolbar clipping and keep owner theme and teardown',async t=>{
  const f=uiFixture();t.after(()=>f.dispose());const ui=f.context.ui.create(),h=ui.React.createElement,C=ui.components;
  await ui.page({label:'Page',toolbar:true,render:({toolbar})=>ui.createPortal(h(C.Tooltip,{content:'Visible outside header',forceOpen:true},h(C.Button,{'aria-label':'Refresh'},'Refresh')),toolbar)});
  await f.open();await tick();const overlay=f.document.querySelector('[data-codlet-page-overlays]');assert.ok(overlay.querySelector('[data-radix-popper-content-wrapper]'));assert.equal(overlay.parentElement,f.document.body);assert.equal(overlay.closest('[data-codlet-page-toolbar]'),null);
  f.document.documentElement.dataset.theme='dark';await tick();assert.equal(overlay.dataset.theme,'dark');await f.leave();assert.equal(overlay.isConnected,false);assert.equal(overlay.childElementCount,0);
  await f.open();assert.ok(f.document.querySelector('[data-codlet-page-overlays] [data-radix-popper-content-wrapper]'));ui.dispose();assert.equal(f.document.querySelector('[data-codlet-page-overlays]'),null);
});
