import assert from 'node:assert/strict';
import test from 'node:test';
import { createRequire } from 'node:module';
import { fileURLToPath } from 'node:url';
import { build } from '../frontend/node_modules/esbuild/lib/main.js';

const require = createRequire(new URL('../frontend/package.json', import.meta.url)), { JSDOM } = require('jsdom');
const cwd = fileURLToPath(new URL('../frontend', import.meta.url));
const driverSource = (await build({ entryPoints: [fileURLToPath(new URL('../frontend/src/adapter/workspace-native-composer.js', import.meta.url))],
  bundle: true, write: false, format: 'iife', globalName: 'NativeDriver', platform: 'browser' })).outputFiles[0].text;
const fixtureSource = (await build({ absWorkingDir: cwd, stdin: { contents: `
  import React from 'react';
  import * as Client from 'react-dom/client';
  export function fixture(directDom=false) {
    const h=React.createElement, composerScope={context:React.createContext(null)}, ThreadScope={context:React.createContext(null)}, RouteScope={context:React.createContext(null)};
    const controllers=new Set(),submitted=[];let rootsCreated=0,rootsDisposed=0;
    function Scope({scope,value,children}) {
      const facade=React.useMemo(()=>({scope,value,node:{},get(){},set(){},watch(){}}),[scope,value]);
      return h(scope.context.Provider,{value:facade},children);
    }
    const useScope=scope=>React.useContext(scope.context),Controller=React.createContext(null);
    function Input({registerSubmitHandler,onSubmitLocal,submitDisabled}) {
      const controller=React.useContext(Controller),ref=React.useRef(null);
      React.useLayoutEffect(()=>{
        if(!directDom){controller.view.dom=ref.current;return;}
        const editable=document.createElement('div');editable.contentEditable='true';editable.setAttribute('contenteditable','true');
        controller.view.dom=editable;ref.current.closest('[data-codex-composer-root]').append(editable);return()=>editable.remove();
      });
      if(directDom)return h('span',{ref,'data-editor-portal-anchor':''});
      return h('div',{ref,contentEditable:true,suppressContentEditableWarning:true,'data-editor':''});
    }
    function EditorProvider({composerController,onDocumentChange,onDocumentDispose,children}) {
      const controller=React.useRef(composerController);
      return h(Controller.Provider,{value:controller.current},children);
    }
    function Composer({registerSubmitHandler,submitDisabled,composerController,onDocumentChange,onDocumentDispose}) {
      const scope=useScope(composerScope),ref=React.useRef(scope);ref.current=scope;
      const controller=composerController;
      const submit=React.useCallback(()=>submitted.push(scope.value.conversationId),[scope]);
      React.useEffect(()=>{registerSubmitHandler(submit);return()=>registerSubmitHandler(null);},[registerSubmitHandler,submit]);
      return h('div',{'data-codex-composer-root':''},h(EditorProvider,{composerController:controller,onDocumentChange,onDocumentDispose},h(Input,{registerSubmitHandler,onSubmitLocal:submit,submitDisabled})));
    }
    function ComposerSurface({children}) {return children;}
    return {React,Client:{createRoot(container,options){rootsCreated++;const root=Client.createRoot(container,options);return {render:root.render.bind(root),unmount(){rootsDisposed++;root.unmount();}};}},
      Composer,ComposerSurface,Scope,useScope,composerScope,ThreadScope,RouteScope,
      routeDescription({pathname,search}){return {routeKind:'local-thread',conversationId:pathname.slice(7),search};},
      composerValue(route){return {kind:'local',clientThreadId:'local:'+route.conversationId,conversationId:route.conversationId};},
      createController(){const controller={view:{dom:null,isDestroyed:false,composing:false},getPersistedText(){return '';},restoreDraft(){},destroy(){this.view.isDestroyed=true;}};controllers.add(controller);return controller;},
      stats:()=>({rootsCreated,rootsDisposed}),controllers,submitted};
  }
`, resolveDir: cwd }, bundle: true, write: false, format: 'iife', globalName: 'Parts', platform: 'browser', define: { 'process.env.NODE_ENV': '"production"' } })).outputFiles[0].text;
const tick=()=>new Promise(resolve=>setTimeout(resolve,0));
function setup(t,{prepare,checkpoint,acquire,released,directDom=false}={}) {
  const dom=new JSDOM('<!doctype html><body><div id="main"></div><div id="owned"></div></body>',{url:'app://-/index.html',runScripts:'outside-only'});
  const {window}=dom,{document}=window;window.eval(driverSource);window.eval(fixtureSource);
  const N=window.Parts.fixture(directDom),calls=[];
  N.composerLifecycle={
    async prepare(identity,options){calls.push(['prepare',identity.threadId]);await prepare?.(identity,options);},
    createController(){return N.createController();},
    async checkpoint(record,options){calls.push(['checkpoint',record.identity.threadId,record.model.scope.value.conversationId]);await checkpoint?.(record,options);},
    async acquire(identity,options){calls.push(['acquire',identity.threadId]);await acquire?.(identity,options);},
    async released(record,options){calls.push(['released',record.identity?.threadId]);await released?.(record,options);},
  };
  const container=document.getElementById('owned');
  const driver=window.NativeDriver.createNativeComposerDriver({native:N,document,container,providers:[],owner:'synthetic-run',check(){}});
  t.after(()=>window.close());
  return {window,document,N,container,driver,calls,signal:()=>new window.AbortController()};
}
const identity=(threadId,bindingRevision)=>({threadId,hostId:'local',bindingRevision});

test('direct rendering uses real React commit/model ownership with synthetic Native parts, checkpoints before rebinding and releases once',async t=>{
  const f=setup(t),a=f.signal();await f.driver.bind(identity('synthetic-a',1),{signal:a.signal});
  assert.equal(f.driver.readBinding().threadId,'synthetic-a');assert.equal(f.driver.readBinding().submitDisabled,true);
  await f.driver.activate({bindingRevision:1,signal:a.signal});assert.equal(f.driver.readBinding().submitDisabled,false);
  f.driver.block();assert.equal(f.driver.readBinding().submitDisabled,true);assert.equal(f.container.hasAttribute('inert'),true);
  await f.driver.bind(identity('synthetic-b',2),{signal:f.signal().signal});
  assert.deepEqual(f.calls.slice(0,4),[['prepare','synthetic-a'],['acquire','synthetic-a'],['prepare','synthetic-b'],['checkpoint','synthetic-a','synthetic-a']]);
  assert.equal(f.driver.readBinding().threadId,'synthetic-b');assert.equal(f.N.stats().rootsCreated,1);
  assert.equal(f.N.submitted.length,0);assert.equal(f.document.getElementById('main').childNodes.length,0);
  const close=f.driver.close({signal:f.signal().signal});assert.equal(close,f.driver.close({signal:f.signal().signal}));await close;
  assert.equal(f.container.childNodes.length,0);assert.equal(f.N.stats().rootsDisposed,1);assert.equal([...f.N.controllers].every(value=>value.view.isDestroyed),true);
});

test('the direct Native factory refuses a missing lifecycle before allocating an input root',t=>{
  const f=setup(t);delete f.N.composerLifecycle;
  assert.throws(()=>f.window.NativeDriver.createNativeComposerDriver({native:f.N,document:f.document,container:f.container,providers:[],owner:'synthetic-run',check(){}}),{code:'workspace_composer_unsupported'});
  assert.equal(f.N.stats().rootsCreated,0);assert.equal(f.container.childNodes.length,0);
});

test('binding finds the actual controller and submission below the committed input host when ProseMirror is attached outside React',async t=>{
  const f=setup(t,{directDom:true});await f.driver.bind(identity('synthetic-direct-dom',1),{signal:f.signal().signal});
  assert.equal(f.driver.readBinding().threadId,'synthetic-direct-dom');await f.driver.activate({bindingRevision:1,signal:f.signal().signal});
  assert.equal(f.driver.readBinding().submitDisabled,false);await f.driver.close({signal:f.signal().signal});assert.equal(f.container.childNodes.length,0);
});

test('retirement during preparation prevents a late Native root and still awaits the profile release',async t=>{
  let finish;const f=setup(t,{prepare:()=>new Promise(resolve=>finish=resolve)}),signal=f.signal();
  const bind=f.driver.bind(identity('synthetic-late',1),{signal:signal.signal});await tick();
  const close=f.driver.close({signal:f.signal().signal});finish();await assert.rejects(bind,{code:'workspace_composer_superseded'});await close;
  assert.equal(f.N.stats().rootsCreated,0);assert.equal(f.container.childNodes.length,0);assert.equal(f.calls.at(-1)[0],'released');
});

test('a pending Native checkpoint blocks the next component identity and propagates failure without false success',async t=>{
  let fail;const f=setup(t,{checkpoint:()=>new Promise((_,reject)=>fail=reject)}),signal=f.signal();
  await f.driver.bind(identity('synthetic-save-a',1),{signal:signal.signal});
  const bind=f.driver.bind(identity('synthetic-save-b',2),{signal:f.signal().signal});await tick();
  assert.equal(f.driver.readBinding().threadId,'synthetic-save-a');assert.equal(f.driver.readBinding().submitDisabled,true);
  fail(Object.assign(Error('Native checkpoint did not confirm'),{code:'workspace_composer_cleanup_incomplete'}));
  await assert.rejects(bind,{code:'workspace_composer_cleanup_incomplete'});
  assert.equal(f.N.stats().rootsCreated,1);assert.equal(f.container.querySelectorAll('[data-codex-composer-root]').length,1);
  f.N.composerLifecycle.checkpoint=async()=>{};await f.driver.close({signal:f.signal().signal});
});

test('binding proof rejects a model identity change even when an editable DOM node remains present',async t=>{
  const f=setup(t);await f.driver.bind(identity('synthetic-proof',1),{signal:f.signal().signal});
  const input=f.container.querySelector('[data-codex-composer-root]'),key=Object.keys(input).find(key=>key.startsWith('__reactFiber$'));
  let fiber=input[key];while(fiber&&!(typeof fiber.type==='function'&&fiber.type.name==='Composer'))fiber=fiber.return;
  let hook=fiber.memoizedState,scope;while(hook){if(hook.memoizedState?.current?.scope===f.N.composerScope){scope=hook.memoizedState.current;break;}hook=hook.next;}
  scope.value.conversationId='foreign-synthetic';assert.ok(f.container.querySelector('[contenteditable="true"]'));
  assert.throws(()=>f.driver.readBinding(),{code:'workspace_composer_binding_drift'});
  await assert.rejects(f.driver.close({signal:f.signal().signal}),{code:'workspace_composer_binding_drift'});assert.equal(f.N.stats().rootsDisposed,1);
});
