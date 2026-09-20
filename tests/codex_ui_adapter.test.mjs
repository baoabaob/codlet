import assert from 'node:assert/strict';
import test from 'node:test';
import {readFileSync} from 'node:fs';
import {createRequire} from 'node:module';
import {fileURLToPath} from 'node:url';
import {uiFixture,tick,deferred} from './support/ui-fixture.mjs';
const require=createRequire(new URL('../frontend/package.json',import.meta.url)),{buildSync}=require('esbuild');
const cwd=fileURLToPath(new URL('../frontend',import.meta.url));
const compile=(path,name)=>buildSync({absWorkingDir:cwd,stdin:{contents:readFileSync(new URL(path,import.meta.url),'utf8'),resolveDir:path.includes('native-shell')?cwd:cwd+'/src/adapter',sourcefile:path},bundle:true,write:false,format:'iife',globalName:name,platform:'browser',loader:{'.svg':'text'},define:{'process.env.NODE_ENV':'"production"'}}).outputFiles[0].text;
const shellSource=compile('./support/native-shell.js','NativeShell'),adapterSource=compile('../frontend/src/adapter/navigation.js','Adapter');
function fixture(t,options){const f=uiFixture();const native={...f.window.eval(shellSource+';NativeShell;')},shell=native.mount(options),adapter=f.window.eval(adapterSource+';Adapter;');
  const toolbarOutlet=f.document.createElement('header');toolbarOutlet.dataset.nativeHeaderOutlet='';f.document.body.appendChild(toolbarOutlet);
  native.Header=({children})=>native.DOM.createPortal(children,toolbarOutlet);
  native.HeaderToolbar=({children,inset})=>native.React.createElement('div',{'data-native-header-toolbar':inset?'inset':'flush'},children);
  const drafts=[];native.useStartNewConversation=()=>options=>{drafts.push(options);shell.navigator.push('/',{prefillPrompt:options.prefillPrompt});};
  const navigation=adapter.createNavigation(f.context,native,adapter.locateHost());t.after(()=>{navigation.dispose();shell.dispose();toolbarOutlet.remove();f.dispose();});return {...f,native,shell,adapter,navigation,toolbarOutlet,drafts};}
function register(f,{id='codlet-gui',generation=1,token='test-owner-token-123456',toolbar}={}){const lease=f.document.createElement('span');Object.assign(lease.dataset,{codletPageLease:token,codletPageOwner:id,codletGeneration:String(generation)});f.document.body.appendChild(lease);const reply=f.navigation.register({label:'Codlet',icon:'Cube',token,...(toolbar===undefined?{}:{toolbar})},{caller:{pluginId:id,generation}});return {lease,reply};}
test('build 9771 fragment-wrapped routes retain their native Route and authenticated collection',async t=>{
  const f=fixture(t,{fragmentRouteRoot:true});const host=f.adapter.locateHost();assert.equal(host.Route,f.shell.Route);assert.equal(host.routes,f.shell.routes);
  const {lease,reply}=register(f,{toolbar:true});await tick();f.control('Codlet').click();await tick();
  assert.equal(f.shell.navigator.location.pathname,reply.path);assert.ok(f.document.querySelector('[data-codlet-page-host]'));assert.ok(f.document.querySelector('[data-codlet-page-toolbar]'));
  lease.remove();await tick();assert.equal(f.document.querySelector('[data-codlet-page-host]'),null);assert.ok(f.document.getElementById('native-composer'));
});
test('native router receives one stable page route; navigation unmounts the original content and follows back/forward',async t=>{
  const f=fixture(t),original=[...f.shell.routes],methods=['push','replace','go'].map(k=>f.shell.navigator[k]);const {reply}=register(f);await tick();
  original.forEach((route,i)=>assert.equal(f.shell.routes[i],route));assert.equal(f.shell.routes.length,original.length+1);
  f.control('Codlet').click();await tick();assert.equal(f.shell.navigator.location.pathname,reply.path);assert.equal(f.document.getElementById('native-composer'),null);assert.ok(f.document.querySelector('[data-codlet-page-host]'));assert.equal(f.control('Codlet').getAttribute('aria-current'),'page');
  f.shell.navigator.go(-1);await tick();assert.ok(f.document.getElementById('native-composer'));assert.equal(f.document.querySelector('[data-codlet-page-host]'),null);assert.equal(f.control('Codlet').hasAttribute('aria-current'),false);
  f.shell.navigator.go(1);await tick();assert.ok(f.document.querySelector('[data-codlet-page-host]'));assert.deepEqual(['push','replace','go'].map(k=>f.shell.navigator[k]),methods,'adapter never replaces the history observer used by Desktop Adapter');
});
test('removing the authenticated page lease restores the last native route and removes only its own descriptor',async t=>{
  const f=fixture(t),original=[...f.shell.routes];const {lease}=register(f);await tick();f.control('Codlet').click();await tick();lease.remove();await tick();
  assert.equal(f.shell.navigator.location.pathname,'/local/start');assert.equal(f.shell.routes.length,original.length);original.forEach((route,i)=>assert.equal(f.shell.routes[i],route));assert.equal(f.document.querySelector('[data-codlet-native-navigation]'),null);assert.ok(f.document.getElementById('native-composer'));
});
test('only the active live page can open an editable native task draft without submitting it',async t=>{
  const f=fixture(t),invocation={caller:{pluginId:'codlet-gui',generation:1}},{lease}=register(f);await tick();
  assert.throws(()=>f.navigation.newTaskDraft({prompt:'Create a Codlet plugin'},invocation),{code:'invalid_owner'});
  f.control('Codlet').click();await tick();
  f.shell.navigator.push(f.shell.navigator.location.pathname+'/details');await tick();
  for(const caller of [{pluginId:'other',generation:1},{pluginId:'codlet-gui',generation:2}])assert.throws(()=>f.navigation.newTaskDraft({prompt:'Draft'},{caller}),{code:'invalid_owner'});
  for(const args of [{prompt:''},{prompt:'Draft',submit:true},{prompt:'x'.repeat(16385)}])assert.throws(()=>f.navigation.newTaskDraft(args,invocation),{code:'invalid_argument'});
  assert.deepEqual(JSON.parse(JSON.stringify(f.navigation.newTaskDraft({prompt:'Create a Codlet plugin'},invocation))),{opened:true,submitted:false});await tick();
  assert.equal(f.drafts.length,1);assert.equal(f.drafts[0].prefillPrompt,'Create a Codlet plugin');assert.equal(f.drafts[0].prefillComposerMode,'local');assert.equal(f.shell.navigator.location.pathname,'/');
  assert.throws(()=>f.navigation.newTaskDraft({prompt:'Second'},invocation),{code:'invalid_owner'});
  lease.remove();await tick();assert.equal(f.drafts.length,1);
});
test('an opt-in toolbar belongs to the native header outlet and retires with its page',async t=>{
  const f=fixture(t),{lease,reply}=register(f,{toolbar:true});await tick();assert.equal(f.toolbarOutlet.childElementCount,0);
  f.control('Codlet').click();await tick();
  const body=f.document.querySelector('[data-codlet-page-host]'),toolbar=f.document.querySelector('[data-codlet-page-toolbar]');
  assert.ok(body);assert.ok(toolbar);assert.equal(toolbar.dataset.codletPageToolbar,body.dataset.codletPageHost);
  assert.equal(f.toolbarOutlet.contains(toolbar),true);assert.equal(body.contains(toolbar),false);assert.equal(toolbar.parentElement.dataset.nativeHeaderToolbar,'inset');
  f.shell.navigator.go(-1);await tick();assert.equal(f.toolbarOutlet.childElementCount,0);assert.equal(f.document.querySelector('[data-codlet-page-toolbar]'),null);
  f.shell.navigator.go(1);await tick();assert.equal(f.shell.navigator.location.pathname,reply.path);assert.equal(f.document.querySelectorAll('[data-codlet-page-toolbar]').length,1);
  lease.remove();await tick();assert.equal(f.toolbarOutlet.childElementCount,0);assert.equal(f.document.querySelector('[data-codlet-page-host]'),null);assert.equal(f.shell.navigator.location.pathname,'/local/start');
});
test('the reviewed lazy AppShell export initializes before reading its memo components',t=>{
  const f=fixture(t),Header=f.native.React.memo(()=>null),HeaderToolbar=f.native.React.memo(()=>null);
  let calls=0,value;
  const names=f.adapter.pageProfile({appVersion:'26.908.40834',buildNumber:'8881'}).page.exports;
  const initial={hB(){calls++;value={Header,HeaderToolbar};},get mB(){assert.ok(calls>0);return value;}};
  const resolved=f.adapter.reviewedHeader(initial,names);
  assert.equal(calls,1);assert.equal(resolved.Header,Header);assert.equal(resolved.HeaderToolbar,HeaderToolbar);
  assert.throws(()=>f.adapter.reviewedHeader({mB:value},names),{code:'ui_build_drift'});
  assert.throws(()=>f.adapter.reviewedHeader({hB(){},mB:{Header:{},HeaderToolbar}},names),{code:'ui_build_drift'});
});
test('Mac native pages use their own reviewed resources and refuse a mismatched build',t=>{
  const f=fixture(t),profile=f.adapter.pageProfile({appVersion:'26.908.70816',buildNumber:9275});
  assert.equal(profile.entry,'app://-/assets/index-53d76a96a6f3.js');
  assert.equal(profile.module,'app://-/assets/app-initial-4d7ea7f81c2d.js');
  assert.equal(profile.page.primary,'app://-/assets/app-primary-4af6ed7f68d1.js');
  assert.ok(Object.isFrozen(profile.page.exports));
  assert.throws(()=>f.adapter.pageProfile({appVersion:'26.908.70816',buildNumber:8881}),{code:'ui_build_drift'});
});
test('only a boolean toolbar request is accepted and an unavailable native header does not add a route',async t=>{
  const f=fixture(t),count=f.shell.routes.length;
  for(const toolbar of ['true',{},1,null])assert.throws(()=>register(f,{toolbar}),{code:'invalid_argument'});
  assert.equal(f.shell.routes.length,count);
  const withoutHeader={...f.native,Header:null},navigation=f.adapter.createNavigation(f.context,withoutHeader,f.adapter.locateHost());
  try { assert.throws(()=>navigation.register({label:'Codlet',icon:'Cube',token:'test-owner-token-123456',toolbar:true},{caller:{pluginId:'codlet-gui',generation:1}}),{code:'ui_build_drift'}); }
  finally { navigation.dispose(); }
  assert.equal(f.shell.routes.length,count);assert.equal(f.toolbarOutlet.childElementCount,0);
  await tick();
});
test('duplicate registrations are idempotent; other plugin generations cannot claim the lifetime marker',async t=>{
  const f=fixture(t);register(f);const length=f.shell.routes.length;
  f.navigation.register({label:'Codlet',icon:'Cube',token:'test-owner-token-123456'},{caller:{pluginId:'codlet-gui',generation:1}});assert.equal(f.shell.routes.length,length);
  for(const caller of [null,{pluginId:'other',generation:1},{pluginId:'codlet-gui',generation:2}])assert.throws(()=>f.navigation.register({label:'Codlet',icon:'Cube',token:'test-owner-token-123456'},{caller}),{code:'invalid_owner'});
});
test('host ambiguity and unreviewed builds fail before changing native routes',async t=>{
  const f=fixture(t),original=[...f.shell.routes];f.document.getElementById('root').id='changed';assert.throws(()=>f.adapter.locateHost(),{code:'ui_host_pending'});assert.equal(f.shell.routes.length,original.length);original.forEach((route,i)=>assert.equal(f.shell.routes[i],route));
  const provided=[];await f.adapter.activate({...f.context,rpc:{provide:(...args)=>provided.push(args)}});await tick();await assert.rejects(provided[0][2]({},{}),{code:'ui_build_drift'});f.adapter.deactivate();
});
test('provider teardown removes native navigation roots without leaving a top-bar control or appearance styles',async t=>{
  const f=fixture(t),original=[...f.shell.routes];register(f);await tick();f.navigation.dispose();await tick();
  assert.equal(f.shell.routes.length,original.length);original.forEach((route,i)=>assert.equal(f.shell.routes[i],route));assert.equal(f.control('Codlet'),undefined);assert.equal(f.document.querySelector('[data-codlet-titlebar-button]'),null);assert.equal(f.document.querySelector('[data-codlet-ui-adapter-style]'),null);
});
test('the reviewed avatar window declines pages without errors, observers or route mutations',async t=>{
  const f=fixture(t),original=[...f.shell.routes];f.navigation.dispose();f.shell.navigator.push('/avatar-overlay');await tick();
  const before=f.observers.size,host=f.adapter.locateHost();assert.equal(host.auxiliary,true);
  const auxiliary=f.adapter.createNavigation(f.context,f.native,host);t.after(()=>auxiliary.dispose());assert.equal(f.observers.size,before);
  f.overrides.set('register',args=>auxiliary.register(args,{caller:{pluginId:f.context.pluginId,generation:f.context.generation}}));
  const ui=f.context.ui.create();let mounts=0;const page=await ui.page({label:'Codlet',render(){mounts++;return null;}});
  assert.equal(page.path,null);assert.equal(mounts,0);assert.equal(f.document.querySelector('[data-codlet-page-lease]'),null);assert.equal(f.document.querySelector('[data-codlet-official-ui]'),null);assert.equal(f.document.querySelector('[data-codlet-native-navigation]'),null);
  assert.equal(f.shell.routes.length,original.length);original.forEach((route,index)=>assert.equal(f.shell.routes[index],route));assert.equal(f.errors.length,0);page.dispose();ui.dispose();
});

test('cold startup accepts a page lease without holding its activation RPC and mounts once the native shell is ready',async t=>{
  const f=fixture(t);f.navigation.dispose();const loading=deferred(),bridge=f.adapter.deferredNavigation(f.context,()=>loading.promise);
  t.after(()=>bridge.dispose());f.overrides.set('register',args=>bridge.register(args,{caller:{pluginId:f.context.pluginId,generation:f.context.generation}}));
  const ui=f.context.ui.create(),page=await ui.page({label:'Codlet',render:()=>null});
  assert.equal(page.path,'/codlet/codlet-gui');assert.equal(f.control('Codlet'),undefined);assert.ok(f.document.querySelector('[data-codlet-page-lease]'));
  loading.resolve(f.native);await bridge.ready;await tick();assert.ok(f.control('Codlet'));f.control('Codlet').click();await tick();assert.ok(f.document.querySelector('[data-codlet-page-host]'));
  assert.equal(f.errors.length,0);ui.dispose();await tick();assert.equal(f.control('Codlet'),undefined);bridge.dispose();await tick();
});
test('deferred registration retires with its page or provider and never adds a late route',async t=>{
  const f=fixture(t);f.navigation.dispose();const count=f.shell.routes.length,loading=deferred(),bridge=f.adapter.deferredNavigation(f.context,()=>loading.promise);
  f.overrides.set('register',args=>bridge.register(args,{caller:{pluginId:f.context.pluginId,generation:f.context.generation}}));
  const ui=f.context.ui.create();await ui.page({label:'Codlet',render:()=>null});ui.dispose();bridge.dispose();loading.resolve(f.native);
  await assert.rejects(bridge.ready,{code:'ui_retired'});await tick();assert.equal(f.shell.routes.length,count);assert.equal(f.control('Codlet'),undefined);assert.equal(f.document.querySelector('[data-codlet-page-lease]'),null);
});
test('a deferred avatar page releases its UI resources when the native router declines it',async t=>{
  const f=fixture(t);f.navigation.dispose();f.shell.navigator.push('/avatar-overlay');await tick();
  const loading=deferred(),bridge=f.adapter.deferredNavigation(f.context,()=>loading.promise);t.after(()=>bridge.dispose());
  f.overrides.set('register',args=>bridge.register(args,{caller:{pluginId:f.context.pluginId,generation:f.context.generation}}));
  const ui=f.context.ui.create();await ui.page({label:'Codlet',render:()=>null});loading.resolve(f.native);await bridge.ready;await tick();
  assert.equal(f.document.querySelector('[data-codlet-page-lease]'),null);assert.equal(f.control('Codlet'),undefined);assert.equal(f.document.querySelector('[data-codlet-official-ui]'),null);assert.equal(f.errors.length,0);ui.dispose();bridge.dispose();await tick();
});
