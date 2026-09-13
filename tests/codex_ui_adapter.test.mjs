import assert from 'node:assert/strict';
import test from 'node:test';
import {readFileSync} from 'node:fs';
import {createRequire} from 'node:module';
import {fileURLToPath} from 'node:url';
import {uiFixture,tick} from './support/ui-fixture.mjs';
const require=createRequire(new URL('../frontend/package.json',import.meta.url)),{buildSync}=require('esbuild');
const cwd=fileURLToPath(new URL('../frontend',import.meta.url));
const compile=(path,name)=>buildSync({absWorkingDir:cwd,stdin:{contents:readFileSync(new URL(path,import.meta.url),'utf8'),resolveDir:path.includes('native-shell')?cwd:cwd+'/src/adapter',sourcefile:path},bundle:true,write:false,format:'iife',globalName:name,platform:'browser',define:{'process.env.NODE_ENV':'"production"'}}).outputFiles[0].text;
const shellSource=compile('./support/native-shell.js','NativeShell'),adapterSource=compile('../frontend/src/adapter/navigation.js','Adapter');
function fixture(t){const f=uiFixture();const native=f.window.eval(shellSource+';NativeShell;'),shell=native.mount(),adapter=f.window.eval(adapterSource+';Adapter;');const navigation=adapter.createNavigation(f.context,native,adapter.locateHost());t.after(()=>{navigation.dispose();shell.dispose();f.dispose();});return {...f,native,shell,adapter,navigation};}
function register(f,{id='codlet-gui',generation=1,token='test-owner-token-123456'}={}){const lease=f.document.createElement('span');Object.assign(lease.dataset,{codletPageLease:token,codletPageOwner:id,codletGeneration:String(generation)});f.document.body.appendChild(lease);const reply=f.navigation.register({label:'Codlet',icon:'Cube',token},{caller:{pluginId:id,generation}});return {lease,reply};}
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
