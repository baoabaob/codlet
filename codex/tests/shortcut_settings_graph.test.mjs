import test from 'node:test';
import assert from 'node:assert/strict';
import {shortcutSettingsReferences,initializedAppRuntimeReference,workspaceRuntimeReferences} from '../frontend/src/adapter/workspace-discovery.js';
const root='app://-/assets/';
test('shortcut settings retain the direct Native graph and follow the current entry through lazy routes',async()=>{
  assert.deepEqual(await shortcutSettingsReferences('import("./keyboard-shortcuts-settings-old.js")',root+'app-initial-old.js',()=>assert.fail('Direct graph needs no additional source'),()=>assert.fail('Direct graph needs no entry')), [root+'keyboard-shortcuts-settings-old.js']);
  const files={
    [root+'index-new.js']:'import("./app-main-new.js")',
    [root+'app-main-new.js']:'["./settings-lazy-routes-new.js"]',
    [root+'settings-lazy-routes-new.js']:'["./keyboard-shortcuts-settings-wrapper.js","./keyboard-shortcuts-settings-impl.js"]',
  },reads=[];
  assert.deepEqual(await shortcutSettingsReferences('',root+'app-initial-new.js',async url=>{reads.push(url);return files[url];},()=>[root+'index-new.js']),[root+'keyboard-shortcuts-settings-wrapper.js',root+'keyboard-shortcuts-settings-impl.js']);
  assert.deepEqual(reads,Object.keys(files));
  await assert.rejects(shortcutSettingsReferences('',root+'app-initial-new.js',url=>files[url],()=>[root+'index-new.js',root+'index-other.js']),{code:'workspace_shortcuts_unavailable'});
});

const rootCreation='import{client as factory}from"./app-shared-new.js";let library=factory(),element=document.getElementById("root"),browser=window;browser.__nativeRoot??(browser.__nativeRoot=library.createRoot(element));let root=browser.__nativeRoot;';
const app='preload(async()=>{let{initializeApp:run}=await import("./app-runtime-new.js");return{initializeApp:run}},deps,import.meta.url).then(({initializeApp:run})=>run()).then(element=>root.render(element));';
const main=rootCreation+app;
test('current root initializer leads to static settings and primary imports without following setup or unrelated lazy modules',async()=>{
  const files={
    [root+'index-new.js']:'import("./app-main-new.js")',
    [root+'app-main-new.js']:main+'import("./setup-runtime-decoy.js");',
    [root+'app-runtime-new.js']:'import"./app-primary-new.js";import{settings}from"./settings-lazy-routes-new.js";const unrelated="./settings-lazy-routes-decoy.js";import("./unrelated-lazy.js");',
    [root+'settings-lazy-routes-new.js']:'"keyboard-shortcuts";import("./keyboard-shortcuts-settings-wrapper.js");',
  },reads=[],read=async url=>{reads.push(url);assert.ok(url in files,url);return files[url];};
  assert.equal(initializedAppRuntimeReference(main,root+'app-main-new.js'),root+'app-runtime-new.js');
  assert.deepEqual(await shortcutSettingsReferences('',root+'app-initial-new.js',read,()=>[root+'index-new.js']),[root+'keyboard-shortcuts-settings-wrapper.js']);
  assert.deepEqual(reads,Object.keys(files));
  const runtime=await workspaceRuntimeReferences(read,()=>[root+'index-new.js']);
  assert.deepEqual(runtime.imports,[root+'app-primary-new.js',root+'settings-lazy-routes-new.js']);
});

test('runtime discovery rejects wrong initializer bindings, non-awaited imports and competing application initializers',()=>{
  for(const source of [main.replace('initializeApp:run}},','initializeApp:other}},'),main.replace('=>run())','=>other())'),main.replace('root.render(element)','root.render(other)'),main.replace('await import','import'),main.replace('initializeApp','initializeDictationSetup'),main+app.replace('app-runtime-new','app-runtime-other')])
    assert.throws(()=>initializedAppRuntimeReference(source,root+'app-main-new.js'),{code:'workspace_host_drift'});
});

test('runtime belongs to the same lexical public root render and an actual entry import',async()=>{
  const ownedOtherRender='Promise.resolve().then(element=>root.render(element));';
  for(const source of [rootCreation+ownedOtherRender+app.replace('root.render(element)','unrelated.render(element)'),rootCreation+ownedOtherRender+'function other(root){'+app+'}'])
    assert.throws(()=>initializedAppRuntimeReference(source,root+'app-main-new.js'),{code:'workspace_host_drift'});
  await assert.rejects(workspaceRuntimeReferences(async()=> 'const text="./app-main-new.js";',()=>[root+'index-new.js']),{code:'desktop_asset_drift'});
  const files={[root+'index-new.js']:'const fake="./app-main-decoy.js";import("./app-main-new.js");',[root+'app-main-new.js']:main,[root+'app-runtime-new.js']:'import"./app-primary-new.js";'};
  assert.equal((await workspaceRuntimeReferences(async url=>{assert.ok(url in files,url);return files[url];},()=>[root+'index-new.js'])).runtimeUrl,root+'app-runtime-new.js');
});
