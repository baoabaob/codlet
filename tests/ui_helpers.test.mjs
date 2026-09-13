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
  const result=ui.page({label:'Page',render:()=>null});ui.dispose();reply.resolve({api:1,token:'late',path:'/codlet/late'});await assert.rejects(result);
  assert.equal(f.document.querySelector('[data-codlet-page-lease]'),null);assert.equal(f.document.querySelector('[data-codlet-official-ui]'),null);
});
test('locale/theme sync is scoped and never rewrites the host',async t=>{
  const f=uiFixture();t.after(()=>f.dispose());const ui=f.context.ui.create(),node=ui.container();f.document.documentElement.dataset.theme='dark';await f.locale('zh');
  assert.equal(node.dataset.theme,'dark');assert.equal(node.lang,'zh');assert.equal(f.document.documentElement.dataset.theme,'dark');
  assert.equal(f.document.getElementById('host-editor').getAttribute('data-theme'),null);
});
