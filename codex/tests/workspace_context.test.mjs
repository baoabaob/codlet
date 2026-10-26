import assert from 'node:assert/strict';
import test from 'node:test';
import { createRequire } from 'node:module';
import { createWorkspaceLocations } from '../frontend/src/adapter/workspace-location.js';
import { createWorkspaceSelection } from '../frontend/src/adapter/workspace-selection.js';
import { createWorkspaceViewports } from '../frontend/src/adapter/workspace-viewport.js';
const require=createRequire(new URL('../frontend/package.json',import.meta.url)),{JSDOM}=require('jsdom');
const tick=()=>new Promise(resolve=>setImmediate(resolve));
const history=location=>({location,push(){},replace(){},listen(){}});

test('opaque location restores exact Native page state without returning state or invoking a draft API',async t=>{
  const dom=new JSDOM('<div id="root"></div>'),document=dom.window.document;t.after(()=>dom.window.close());
  const state={privateDraft:'never-export'},navigator=history({pathname:'/settings/preferences',search:'?a=1',hash:'#section',state,key:'origin'});
  const host={navigator,rootNode:document.getElementById('root')},calls=[];
  const provider=createWorkspaceLocations({document,host:()=>host,load:async()=>({restoreLocation(location){calls.push(location);navigator.location={...location};}}),check(){},changed(){}});
  t.after(()=>provider.dispose());const handle=provider.capture(()=>{});await handle.ready;
  assert.deepEqual(Object.keys(handle),['ready','kind','exportState','restore','dispose']);assert.equal(JSON.stringify(handle).includes('never-export'),false);
  navigator.location={pathname:'/local/another-thread',search:'',hash:'',state:null};
  assert.deepEqual(await handle.restore(),{restored:true,kind:'page'});assert.equal(calls.length,1);assert.equal(navigator.location.state,state);
  assert.equal(navigator.location.search,'?a=1');assert.equal(navigator.location.hash,'#section');handle.dispose();
  await assert.rejects(handle.restore(),{code:'workspace_retired'});
});

test('capture cannot silently bind a different page during Native readiness and cancellation releases its guard',async t=>{
  const dom=new JSDOM('<div id="root"></div>'),document=dom.window.document;t.after(()=>dom.window.close());
  const navigator=history({pathname:'/',state:null}),host={navigator,rootNode:document.getElementById('root')};let resolve,released=0;
  const provider=createWorkspaceLocations({document,host:()=>host,load:()=>new Promise(yes=>{resolve=yes;}),check(){},changed(){},retainGuard:()=>()=>released++});
  const handle=provider.capture(()=>{});await tick();navigator.location={pathname:'/settings',state:null};resolve({restoreLocation(){assert.fail('must not restore unready capture');}});
  await assert.rejects(handle.ready,{code:'workspace_location_superseded'});handle.dispose();assert.equal(released,1);provider.dispose();
});

test('selection presentation leaves unselected Native actions visible and disabled while preserving the drag parent',t=>{
  const dom=new JSDOM('<header id="header" style="-webkit-app-region:drag"><div><div id="title" class="min-w-0 text-base font-medium">Native title</div><button id="action">Action</button></div></header>');t.after(()=>dom.window.close());
  const document=dom.window.document,header=document.getElementById('header'),title=document.getElementById('title'),button=document.getElementById('action');
  let selected='thread-a',confirmed=true;const provider=createWorkspaceSelection({document,surface:()=>({header}),snapshot:()=>({threadId:selected}),check(){},changed(){},isConfirmed:()=>confirmed});
  const lease=provider.acquire({threadId:null,emptyLabel:'未选择会话'},'consumer',()=>{});
  assert.equal(button.hasAttribute('inert'),true);assert.equal(button.disabled,true);assert.equal(button.getAttribute('aria-disabled'),'true');assert.equal(button.style.visibility,'');assert.equal(button.parentElement.style.visibility,'');assert.equal(button.style.opacity,'0.45');assert.equal(title.style.visibility,'hidden');assert.equal(header.hasAttribute('inert'),false);
  assert.equal(header.querySelector('[data-codlet-workspace-owned]').textContent,'未选择会话');
  confirmed=false;assert.throws(()=>lease.update({threadId:'thread-a'}),{code:'workspace_selection_not_confirmed'});
  confirmed=true;lease.update({threadId:'thread-a'});assert.equal(button.hasAttribute('inert'),false);assert.equal(button.disabled,false);assert.equal(button.style.opacity,'');assert.equal(title.style.visibility,'');
  selected='thread-b';provider.reconcile();assert.equal(button.hasAttribute('inert'),true,'an externally changed route cannot masquerade as selected A');
  lease.dispose();assert.equal(button.hasAttribute('inert'),false);assert.equal(header.querySelector('[data-codlet-workspace-owned]'),null);
});

test('unsupported independent viewport fails closed without allocating state or poisoning later teardown',async()=>{
  const provider=createWorkspaceViewports({load:async()=>{throw Object.assign(Error('No verified driver'),{code:'workspace_viewport_unsupported'});},check(){},isConfirmed:()=>true,report(){}});
  const handle=provider.create({},()=>{});await assert.rejects(handle.ready,{code:'workspace_viewport_unsupported'});await handle.close();await provider.cleanup();provider.dispose();
});

test('independent viewport routes verified selection through its driver and waits for in-flight work before restoration',async()=>{
  const calls=[];let finish;const view={async bind(value){calls.push(['bind',value]);await new Promise(resolve=>{finish=resolve;});},async update(value){calls.push(['update',value]);},subscribe(){return()=>{};},async close(){calls.push(['close']);}};
  const provider=createWorkspaceViewports({load:async()=>({api:1,independent:true,restoresSettings:true,avoidsThreadPersistence:true,notifiesChanges:true,create:async value=>{calls.push(['create',value]);return view;}}),check(){},isConfirmed:id=>id==='thread-a',report(){}});
  const handle=provider.create({open:true,width:400},()=>{});await handle.ready;
  await assert.rejects(handle.bind({threadId:'wrong'}),{code:'workspace_selection_not_confirmed'});
  const pending=handle.bind({threadId:'thread-a'});await tick();const closing=handle.close();await tick();assert.equal(calls.some(value=>value[0]==='close'),false);
  finish();await assert.rejects(pending,{code:'workspace_retired'});await closing;assert.equal(calls.at(-1)[0],'close');assert.equal(calls.filter(value=>value[0]==='close').length,1);await provider.cleanup();provider.dispose();
});

test('viewport retirement during async allocation restores a late-created Native view exactly once',async()=>{
  let resolve,closed=0;const provider=createWorkspaceViewports({load:async()=>({api:1,independent:true,restoresSettings:true,avoidsThreadPersistence:true,notifiesChanges:true,create:()=>new Promise(yes=>{resolve=yes;})}),check(){},isConfirmed:()=>true,report(){}});
  const handle=provider.create({},()=>{});await tick();handle.dispose();resolve({bind(){},update(){},subscribe(){return()=>{};},close(){closed++;}});await assert.rejects(handle.ready,{code:'workspace_retired'});await provider.cleanup();assert.equal(closed,1);provider.dispose();
});

test('Native viewport resize/close notifications push state and null binding preserves layout while clearing identity',async()=>{
  let notify,unsubscribed=0,closed=0;const bindings=[];
  const view={async bind(value){bindings.push(value);},async update(value){return value;},subscribe(listener){notify=listener;return()=>unsubscribed++;},async close(){closed++;}};
  const provider=createWorkspaceViewports({load:async()=>({api:1,independent:true,restoresSettings:true,avoidsThreadPersistence:true,notifiesChanges:true,create:()=>view}),check(){},isConfirmed:id=>id==='thread-a',report(error){assert.fail(error.message);}});
  const handle=provider.create({open:true,width:400},()=>{}),seen=[];const stop=handle.subscribe(value=>seen.push(value));await handle.ready;
  await handle.bind({threadId:'thread-a'});notify({width:520});assert.equal(handle.getSnapshot().width,520);
  await handle.bind(null);assert.deepEqual(handle.getSnapshot(),{independent:true,open:true,width:520,threadId:null,hostId:null});assert.equal(bindings.at(-1),null);
  notify({open:false});assert.equal(seen.at(-1).open,false);stop();const count=seen.length;notify({width:600});assert.equal(seen.length,count);
  await handle.close();notify({open:true});assert.equal(unsubscribed,1);assert.equal(closed,1);await provider.cleanup();provider.dispose();
});

test('viewport driver failure retires readiness, keeps its primary cause and completes cleanup without a pending-bind deadlock',async()=>{
  const primary=Object.assign(Error('Native binding failed'),{code:'workspace_viewport_state_evicted'}),reported=[];let failed,closed=0;
  const provider=createWorkspaceViewports({load:async()=>({api:1,independent:true,restoresSettings:true,avoidsThreadPersistence:true,notifiesChanges:true,
    create(_initial,{onError}){return{subscribe(){return()=>{};},async bind(){onError(primary);throw Object.assign(Error('Native retired'),{code:'workspace_retired'});},update(){},close(){closed++;}};}}),
    check(){},isConfirmed:()=>true,failed:error=>{failed=error;},report:error=>reported.push(error)});
  const handle=provider.create({},()=>{});await handle.ready;
  await assert.rejects(handle.bind({threadId:'thread-a'}),error=>error===primary);
  await handle.close();await provider.cleanup();assert.equal(failed,primary);assert.equal(reported[0],primary);assert.equal(closed,1);
  assert.throws(()=>handle.getSnapshot(),error=>error===primary);
});

test('location restoration waits for an asynchronous Native route commit and releases its route guard on cancellation',async t=>{
  const dom=new JSDOM('<div id="root"></div>'),document=dom.window.document;t.after(()=>dom.window.close());
  const navigator=history({pathname:'/',state:{private:'original'}}),host={navigator,rootNode:document.getElementById('root')};let pending,released=0;
  const provider=createWorkspaceLocations({document,host:()=>host,load:async()=>({restoreLocation(value){pending=value;}}),check(){},changed(){},beforeRestore:()=>()=>released++});
  t.after(()=>provider.dispose());const handle=provider.capture(()=>{});await handle.ready;
  navigator.location={pathname:'/settings',state:null};const restored=handle.restore();await tick();
  navigator.location={...pending};document.getElementById('root').append(document.createElement('span'));
  assert.deepEqual(await restored,{restored:true,kind:'page'});assert.equal(released,1);
  navigator.location={pathname:'/settings',state:null};const controller=new dom.window.AbortController(),cancelled=handle.restore({signal:controller.signal});await tick();controller.abort();
  await assert.rejects(cancelled,{code:'invocation_cancelled'});assert.equal(released,2);
});

test('capture respects shared IME preflight and does not retain a usable draft handle while composing',async t=>{
  const dom=new JSDOM('<div id="root"></div>'),document=dom.window.document;t.after(()=>dom.window.close());const host={navigator:history({pathname:'/',state:null}),rootNode:document.getElementById('root')};let routed=0;
  const provider=createWorkspaceLocations({document,host:()=>host,load:async()=>({restoreLocation(){routed++;}}),check(){},changed(){},beforeCapture(){throw Object.assign(Error('composing'),{code:'workspace_composer_busy'});}});
  const handle=provider.capture(()=>{});await assert.rejects(handle.ready,{code:'workspace_composer_busy'});await assert.rejects(handle.restore(),{code:'workspace_composer_busy'});assert.equal(routed,0);handle.dispose();provider.dispose();
});

test('heading journal preserves a later unrelated Native property change',t=>{
  const dom=new JSDOM('<header><span class="min-w-0 text-base font-medium">Title</span></header>');t.after(()=>dom.window.close());const document=dom.window.document,header=document.querySelector('header'),title=header.firstElementChild;
  const provider=createWorkspaceSelection({document,surface:()=>({header}),snapshot:()=>({threadId:null}),check(){},changed(){}});
  const handle=provider.acquire({threadId:null},'consumer',()=>{});title.style.setProperty('visibility','collapse');title.setAttribute('aria-hidden','false');provider.reconcile();
  handle.dispose();assert.equal(title.style.visibility,'collapse');assert.equal(title.getAttribute('aria-hidden'),'false');assert.equal(title.hasAttribute('inert'),false);
});

test('selection presentation blocks custom Native actions, excludes owned controls and restores changes after header replacement',t=>{
  const dom=new JSDOM('<header><button class="min-w-0 text-base font-medium" id="title">Title</button><a id="native" href="/native" aria-disabled="false" style="opacity:0.8"><span>Native action</span></a><button id="already" disabled>Unavailable</button><span data-codlet-workspace-owned="consumer"><button id="owned">Exit workspace</button></span></header>');t.after(()=>dom.window.close());
  const document=dom.window.document;let header=document.querySelector('header');const original=header,link=document.getElementById('native'),owned=document.getElementById('owned');let clicked=0,ownedClicks=0;
  header.addEventListener('click',()=>clicked++);owned.addEventListener('click',()=>ownedClicks++);
  const provider=createWorkspaceSelection({document,surface:()=>({header}),snapshot:()=>({threadId:null}),check(){},changed(){}}),lease=provider.acquire({threadId:null},'consumer',()=>{});
  const event=new dom.window.MouseEvent('click',{bubbles:true,cancelable:true});assert.equal(link.firstElementChild.dispatchEvent(event),false);assert.equal(clicked,0);
  owned.click();assert.equal(owned.disabled,false);assert.equal(ownedClicks,1);
  link.style.opacity='0.7';link.setAttribute('aria-disabled','false');provider.reconcile();
  header=document.createElement('header');header.innerHTML='<div class="min-w-0 text-base font-medium">Other title</div><button>Other action</button>';original.replaceWith(header);provider.reconcile();
  assert.equal(link.style.opacity,'0.7');assert.equal(link.getAttribute('aria-disabled'),'false');assert.equal(link.hasAttribute('inert'),false);assert.equal(original.querySelector('#already').disabled,true);
  assert.equal(header.querySelector('button').disabled,true);lease.dispose();assert.equal(header.querySelector('button').disabled,false);
});

function draftLocation(t,{kind='local',conversationId='fixture-five',entrypoint=null,clientThreadId='local:fixture-five',routeKind='local-thread',key=clientThreadId}={}){
  const dom=new JSDOM('<div id="root"></div>'),document=dom.window.document;t.after(()=>dom.window.close());
  const draft=Object.freeze({key,kind,conversationId,clientThreadId,routeKind,entrypoint});
  const makeInput=identity=>({scope:{node:{},value:{...identity}},controller:{view:{composing:false},getPersistedText(){assert.fail('must not read draft text');}},draft:Object.freeze({...identity})});
  let input=makeInput(draft);const navigator=history({pathname:kind==='local'?'/local/'+conversationId:'/',state:null,key:'original'}),host={navigator,rootNode:document.getElementById('root')};
  const provider=createWorkspaceLocations({document,host:()=>host,load:async()=>({restoreLocation(value){navigator.location={...value};}}),check(){},changed(){},readInput:()=>input,readBinding:value=>value.scope.value.conversationId?{threadId:value.scope.value.conversationId,hostId:'local'}:null});t.after(()=>provider.dispose());
  return{document,navigator,provider,draft,makeInput,setInput(value){input=value;},pulse(){document.getElementById('root').append(document.createElement('span'));}};
}

test('location waits for the correct Native input after URL publication and accepts a rebuilt controller in the same draft namespace',async t=>{
  const f=draftLocation(t),handle=f.provider.capture(()=>{});await handle.ready;
  f.navigator.location={pathname:'/local/fixture-zero',state:null};f.setInput(f.makeInput({...f.draft,conversationId:'fixture-zero',clientThreadId:'local:fixture-zero',key:'local:fixture-zero'}));
  const restored=handle.restore();let done=false;restored.then(()=>done=true,()=>done=true);await tick();assert.equal(done,false,'URL alone and the transitional input cannot settle restore');
  f.setInput(f.makeInput(f.draft));f.pulse();assert.deepEqual(await restored,{restored:true,kind:'thread'});
});

test('a new unsent page restores its Native namespace without requiring an old controller or scope object',async t=>{
  const f=draftLocation(t,{kind:'new',conversationId:null,entrypoint:'home',clientThreadId:null,routeKind:null,key:'native-home-draft'}),handle=f.provider.capture(()=>{});await handle.ready;
  f.navigator.location={pathname:'/local/fixture-zero',state:null};f.setInput(f.makeInput({...f.draft,kind:'local',conversationId:'fixture-zero',entrypoint:null,key:'local:fixture-zero'}));
  const restored=handle.restore();await tick();f.setInput(f.makeInput(f.draft));f.pulse();assert.deepEqual(await restored,{restored:true,kind:'page'});
});

test('correctly owned target input with a different Native draft namespace fails instead of silently accepting a fresh document',async t=>{
  const f=draftLocation(t),handle=f.provider.capture(()=>{});await handle.ready;
  f.navigator.location={pathname:'/settings',state:null};f.setInput(f.makeInput({...f.draft,key:'different-draft'}));
  await assert.rejects(handle.restore(),{code:'workspace_location_state_evicted'});
});

test('a committed composer ownership error rejects captured-page restoration instead of waiting indefinitely',async t=>{
  const f=draftLocation(t),handle=f.provider.capture(()=>{});await handle.ready;
  f.navigator.location={pathname:'/settings',state:null};
  const input=f.makeInput(f.draft);
  Object.defineProperty(input,'scope',{get(){throw Object.assign(Error('Native scopes disagree'),{code:'workspace_composer_binding_drift'});}});
  f.setInput(input);
  await assert.rejects(handle.restore(),{code:'workspace_composer_binding_drift'});
});

test('viewport capability is published only after Native readiness and incomplete preparation still closes its allocation',async()=>{
  let prepared=0,closed=0;const view={ready:Promise.reject(Object.assign(Error('layout unavailable'),{code:'workspace_viewport_unsupported'})),bind(){},update(){},subscribe(){return()=>{};},close(){closed++;}};view.ready.catch(()=>{});
  const provider=createWorkspaceViewports({load:async()=>({api:1,independent:true,restoresSettings:true,avoidsThreadPersistence:true,notifiesChanges:true,create:()=>view}),prepared(){prepared++;},check(){},isConfirmed:()=>true,report(){}});
  const handle=provider.create({},()=>{});await assert.rejects(handle.ready,{code:'workspace_viewport_unsupported'});assert.equal(prepared,0);await handle.close();assert.equal(closed,1);await provider.cleanup();provider.dispose();
});
