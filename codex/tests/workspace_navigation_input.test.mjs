import assert from 'node:assert/strict';
import test from 'node:test';
import { createRequire } from 'node:module';
import { createWorkspaceNavigation } from '../frontend/src/adapter/workspace-navigation.js';
import { createWorkspaceMetrics } from '../frontend/src/adapter/workspace-metrics.js';
import { inspectNativeInput } from '../frontend/src/adapter/workspace-native-input.js';
import { summarizeNavigationTestPoints } from './fixtures/workspace-acceptance/summarize-navigation-test-points.mjs';

const require = createRequire(new URL('../frontend/package.json', import.meta.url)), { JSDOM } = require('jsdom');
function setup(t, { cold = false, inputApi = 1, nativeEntry = true, metrics, onInputRead, onBindingRead, onPrepared } = {}) {
  const dom = new JSDOM('<!doctype html><div id="root"><div data-codex-composer-root><div id="input" tabindex="0" contenteditable="true"></div></div></div>', { url: 'app://-/index.html' });
  const { window } = dom, { document } = window, editable = document.getElementById('input');
  const makeBinding = threadId => ({ threadId, hostId: 'local', clientThreadId: 'local:' + threadId,
    input: editable.parentElement, editable, controller: { view: { dom: editable, composing: false } }, submitHandler() {}, submitDisabled: false,
    scopeNode: {}, scopeValue: {}, threadNode: {}, threadValue: {}, routeNode: {}, routeValue: {} });
  const state = { binding: makeBinding('fixture-a'), alive: true }, calls = [], requests = [], checkedInputs = [], nativeCalls = [];
  const navigator = { location: { pathname: '/local/fixture-a', search: '', hash: '', state: null }, push(path) {
    calls.push(path); this.location = { ...this.location, pathname: path }; const next = makeBinding(path.slice(7));
    if (state.delayBinding) state.nextBinding = next; else state.binding = next;
  } };
  const manager = { getConversation: id => cold && id !== 'fixture-a' ? null : { id, hostId: 'local', resumeState: 'resumed' },
    sendRequest(method, args) { return new Promise(resolve => requests.push({ method, args, resolve })); } };
  const provider = createWorkspaceNavigation({ document, load: async () => ({ manager, inputApi, openLocalThread: nativeEntry ? id => { nativeCalls.push(id); navigator.push('/local/' + id); } : undefined }), host: () => ({ navigator }),
    check() { if (!state.alive) throw Object.assign(Error('retired'), { code: 'workspace_retired' }); }, changed() {},
    metrics, onPrepared, readBinding: checked => { onBindingRead?.(); if (checked !== undefined) checkedInputs.push(checked); return state.binding; },
    readCurrentInput: () => { onInputRead?.(); return state.binding; } });
  const navigation = provider.create(() => {});
  t.after(() => { provider.dispose(); window.close(); });
  return { window, document, editable, state, calls, requests, manager, navigator, provider, navigation, makeBinding, checkedInputs, nativeCalls };
}
test('RPC navigation awaits the requested Native snapshot and owns only its prepared thread lease',async t=>{
  const f=setup(t);await f.navigation.ready;let finish,disposed=0;
  f.manager.rpc=true;f.manager.peekConversation=()=>null;f.manager.peekStreamRole=()=>null;
  f.manager.getConversation=id=>new Promise(resolve=>{finish=()=>resolve({id,hostId:'local',resumeState:'resumed'});});
  f.manager.observeThread=id=>{assert.equal(id,'fixture-b');return{ready:Promise.resolve(),dispose(){disposed++;}};};
  const op=f.navigation.open({threadId:'fixture-b'});assert.deepEqual(f.nativeCalls,[]);finish();await op.executed;await op.committed;
  assert.deepEqual(f.nativeCalls,['fixture-b']);f.navigation.dispose();assert.equal(disposed,1);
});
test('RPC snapshot completion cannot overwrite a newer Native route',async t=>{
  const f=setup(t);await f.navigation.ready;let finish;f.manager.rpc=true;f.manager.peekConversation=()=>null;f.manager.peekStreamRole=()=>null;f.manager.getConversation=id=>new Promise(resolve=>{finish=()=>resolve({id,hostId:'local'});});f.manager.observeThread=()=>({ready:Promise.resolve(),dispose(){}});
  const op=f.navigation.open({threadId:'fixture-b'});f.navigator.location={pathname:'/local/user-selected'};finish();await assert.rejects(op.executed,{code:'desktop_navigation_superseded'});assert.equal(f.nativeCalls.length,0);
});
test('RPC child validation leaves the previous confirmed dispatch and pending input ownership intact',async t=>{
  for(const cold of [false,true]){
    const f=setup(t);await f.navigation.ready;f.state.delayBinding=true;const replies=new Map(),leases=[];f.manager.rpc=true;f.manager.peekConversation=()=>null;f.manager.peekStreamRole=()=>null;
    f.manager.getConversation=id=>new Promise(resolve=>replies.set(id,resolve));f.manager.observeThread=id=>{leases.push(id);return{ready:Promise.resolve(),dispose(){}};};
    const previous=f.navigation.open({threadId:'fixture-b'});replies.get('fixture-b')({id:'fixture-b',hostId:'local'});await previous.executed;
    const child=f.navigation.open({threadId:'fixture-child'});replies.get('fixture-child')(cold?null:{id:'fixture-child',hostId:'local',parentThreadId:'fixture-parent'});
    if(cold){await new Promise(resolve=>setImmediate(resolve));assert.equal(f.requests.length,1);f.requests[0].resolve({thread:{id:'fixture-child',hostId:'local',parentThreadId:'fixture-parent'}});}
    await assert.rejects(child.executed,{code:'workspace_thread_not_selectable'});assert.deepEqual(f.nativeCalls,['fixture-b']);assert.deepEqual(leases,['fixture-b']);
    f.state.binding=f.state.nextBinding;f.provider.pulse();await previous.committed;f.provider.dispose();
  }
});

test('a cached child task is rejected before focus, routing or retirement of the previous pending selection',async t=>{
  const f=setup(t,{cold:true});await f.navigation.ready;f.editable.focus();
  const previous=f.navigation.open({threadId:'fixture-cold'}),get=f.manager.getConversation;
  f.manager.getConversation=id=>id==='fixture-child'?{id,hostId:'local',source:{subAgent:{thread_spawn:{parent_thread_id:'fixture-a'}}}}:get(id);
  let settled=false;previous.committed.then(()=>settled=true,()=>settled=true);
  assert.throws(()=>f.navigation.open({threadId:'fixture-child'}),{code:'workspace_thread_not_selectable'});
  await Promise.resolve();assert.equal(settled,false);assert.deepEqual(f.calls,[]);assert.equal(f.document.activeElement,f.editable);
  f.requests[0].resolve({thread:{id:'fixture-cold'}});await previous.committed;
  assert.deepEqual(f.nativeCalls,['fixture-cold']);
});

test('a cold child task is rejected after metadata validation without navigating or replacing the current input',async t=>{
  const f=setup(t,{cold:true});await f.navigation.ready;const binding=f.state.binding;
  const operation=f.navigation.open({threadId:'fixture-child'});
  f.requests[0].resolve({thread:{id:'fixture-child',parentThreadId:'fixture-a'}});
  await assert.rejects(operation.executed,{code:'workspace_thread_not_selectable'});
  await assert.rejects(operation.committed,{code:'workspace_thread_not_selectable'});
  assert.deepEqual(f.calls,[]);assert.equal(f.state.binding,binding);assert.equal(f.navigator.location.pathname,'/local/fixture-a');
  const next=f.navigation.open({threadId:'fixture-root'});f.requests[1].resolve({thread:{id:'fixture-root',title:null,threadSource:'agent_created_thread'}});
  await next.committed;assert.deepEqual(f.nativeCalls,['fixture-root']);
});

test('preparation publishes after strict input inspection is available without navigating',async t=>{
  let prepared=0;
  const f=setup(t,{onPrepared(){prepared++;assert.equal(f.provider.currentInput(),f.state.binding);}});
  await f.navigation.ready;await f.provider.prepare();
  assert.equal(prepared,1);assert.equal(f.navigation.inputApi,1);
  assert.deepEqual(f.nativeCalls,[]);assert.deepEqual(f.calls,[]);
});

test('strict navigation keeps Native objects private and explicit focus checks revision, route and the complete input pin', async t => {
  const f = setup(t); assert.equal(f.navigation.inputApi, 0); assert.equal(await f.navigation.ready, undefined); assert.equal(f.navigation.inputApi, 1);
  const before = f.document.activeElement, priorInput = f.state.binding, first = f.navigation.open({ threadId: 'fixture-b' });
  assert.deepEqual(f.checkedInputs, [priorInput], 'binding reuses the same synchronous IME-preflight inspection');
  assert.deepEqual(f.nativeCalls, ['fixture-b'], 'strict navigation dispatches the Native local entry');
  const commit = await first.committed; assert.equal(f.document.activeElement, before, 'open never explicitly focuses');
  assert.equal(f.navigation.focus({ revision: commit.revision }), true);
  assert.equal(f.navigation.focus({ revision: commit.revision + 1 }), false);
  for (const field of ['controller', 'scopeNode', 'scopeValue', 'threadNode', 'routeNode', 'submitHandler']) {
    const old = f.state.binding[field]; f.state.binding = { ...f.state.binding, [field]: field === 'controller' ? { view: { dom: f.editable, composing: false } } : {} };
    assert.equal(f.navigation.focus({ revision: commit.revision }), false, field + ' changed with the same DOM/thread ID');
    f.state.binding = { ...f.state.binding, [field]: old };
  }
  f.navigator.location.search = '?changed'; assert.equal(f.navigation.focus({ revision: commit.revision }), false);
  f.navigator.location.search = ''; f.editable.parentElement.setAttribute('inert', ''); assert.equal(f.navigation.focus({ revision: commit.revision }), false);
  f.editable.parentElement.removeAttribute('inert'); first.dispose();
  assert.equal(f.navigation.focus({ revision: commit.revision }), false, 'retiring the operation invalidates its focus pin');
  f.navigation.dispose();
  assert.throws(() => f.navigation.focus({ revision: commit.revision }), { code: 'workspace_retired' });
});

test('busy open synchronously preserves composition, focus, routing and the previous pending operation', async t => {
  const f = setup(t, { cold: true }); await f.navigation.ready; f.editable.focus();
  const old = f.navigation.open({ threadId: 'fixture-cold' }); let settled = false;
  old.executed.then(() => settled = true, () => settled = true);
  f.state.binding.controller.view.composing = true;
  assert.throws(() => f.navigation.open({ threadId: 'fixture-new' }), { code: 'workspace_composer_busy' });
  await Promise.resolve(); assert.equal(settled, false); assert.equal(f.document.activeElement, f.editable); assert.deepEqual(f.calls, []);
  f.state.binding.controller.view.composing = false; f.requests[0].resolve({ thread: { id: 'fixture-cold' } });
  await old.committed; assert.deepEqual(f.calls, ['/local/fixture-cold']);
});

test('a composition beginning during cold metadata validation rejects immediately before Native navigation', async t => {
  const f = setup(t, { cold: true }); await f.navigation.ready;
  const op = f.navigation.open({ threadId: 'fixture-cold' }); f.state.binding.controller.view.composing = true;
  f.requests[0].resolve({ thread: { id: 'fixture-cold' } });
  await assert.rejects(op.executed, { code: 'workspace_composer_busy' }); await assert.rejects(op.committed, { code: 'workspace_composer_busy' });
  assert.deepEqual(f.calls, []); assert.equal(f.navigator.location.pathname, '/local/fixture-a');
});

test('capture-phase composition state guards nested editor input even before the Native controller flag updates', async t => {
  const f = setup(t); await f.navigation.ready;
  f.editable.dispatchEvent(new f.window.CompositionEvent('compositionstart', { bubbles: true, data: 'synthetic' }));
  assert.equal(f.state.binding.controller.view.composing, false);
  assert.throws(() => f.navigation.open({ threadId: 'fixture-b' }), { code: 'workspace_composer_busy' }); assert.deepEqual(f.calls, []);
  f.editable.dispatchEvent(new f.window.CompositionEvent('compositionend', { bubbles: true }));
  await f.navigation.open({ threadId: 'fixture-b' }).committed;
});

test('opaque page restoration shares IME checks, retires pending navigation and prevents competing route dispatch', async t => {
  const f = setup(t, { cold: true }); await f.navigation.ready;
  const old = f.navigation.open({ threadId: 'fixture-cold' });
  f.editable.dispatchEvent(new f.window.CompositionEvent('compositionstart', { bubbles: true }));
  assert.throws(() => f.provider.beginLocationRestore(), { code: 'workspace_composer_busy' });
  f.editable.dispatchEvent(new f.window.CompositionEvent('compositionend', { bubbles: true }));
  const release = f.provider.beginLocationRestore();
  await assert.rejects(old.executed, { code: 'workspace_navigation_superseded' });
  await assert.rejects(old.committed, { code: 'workspace_navigation_superseded' });
  assert.throws(() => f.navigation.open({ threadId: 'fixture-b' }), { code: 'workspace_navigation_busy' });
  f.requests[0].resolve({ thread: { id: 'fixture-cold' } });
  await Promise.resolve(); assert.deepEqual(f.nativeCalls, []);
  release(); const next=f.navigation.open({ threadId: 'fixture-b' });
  f.requests[1].resolve({ thread: { id: 'fixture-b' } });
  await next.committed;assert.deepEqual(f.nativeCalls,['fixture-b']);
});

test('already-selected confirmation rejects a same-ID controller replacement and rapid supersession retires old focus revisions', async t => {
  const f = setup(t); await f.navigation.ready;
  const same = f.navigation.open({ threadId: 'fixture-a' }); await same.executed;
  f.state.binding = { ...f.state.binding, controller: { view: { dom: f.editable, composing: false } } };
  await assert.rejects(same.committed, { code: 'workspace_composer_binding_drift' }); assert.deepEqual(f.calls, []);
  // A transient old input can already show A while the route is moving to B.
  // Returning to A is a real route change and may create a fresh A controller.
  f.navigator.location.pathname = '/local/fixture-b';
  const returning = f.navigation.open({ threadId: 'fixture-a' });
  assert.equal((await returning.committed).inputConfirmed, true);
  const next = f.navigation.open({ threadId: 'fixture-b' }); const commit = await next.committed;
  const newer = f.navigation.open({ threadId: 'fixture-c' }); assert.equal(f.navigation.focus({ revision: commit.revision }), false);
  await newer.committed;
});

test('an older navigation provider never claims the strict focus/IME contract', async t => {
  const f = setup(t, { inputApi: 0 }); await f.navigation.ready; assert.equal(f.navigation.inputApi, 0);
  assert.throws(() => f.navigation.focus({ revision: 1 }), { code: 'workspace_navigation_unsupported' });
});

test('strict input navigation refuses a missing Native lifecycle entry before dispatch', async t => {
  const f = setup(t, { nativeEntry: false });
  await assert.rejects(f.navigation.ready, { code: 'workspace_navigation_unsupported' });
  assert.equal(f.navigation.inputApi, 0);
  assert.deepEqual(f.calls, []);
});

test('opt-in navigation phases separate controlled waiting from checks and contain only private numeric aliases', async t => {
  let clock = 0;
  const metrics = createWorkspaceMetrics({ enabled: true, runId: 'navigation-phases', now: () => clock });
  const f = setup(t, { metrics, onInputRead: () => { clock += 3; }, onBindingRead: () => { clock += 2; } });
  const frames = new Map(); let nextFrame = 0;
  f.window.requestAnimationFrame = callback => { frames.set(++nextFrame, callback); return nextFrame; };
  f.window.cancelAnimationFrame = id => frames.delete(id);
  await f.navigation.ready; f.state.delayBinding = true;
  f.state.binding.controller.privateDraft = 'never-record-this-draft';
  const operation = f.navigation.open({ threadId: 'fixture-b' }); await operation.executed; await Promise.resolve();
  assert.equal(frames.size, 1, 'instrumentation did not add a pending polling loop');
  assert.ok(metrics.report().counts['navigation.input.pending.identity'] >= 1);
  clock = 200; f.state.binding = f.state.nextBinding;
  const callback = [...frames.values()][0]; frames.clear(); callback();
  const receipt = await operation.committed; assert.equal(f.navigation.focus({ revision: receipt.revision }), true);
  const report = metrics.report(), sample = phase => report.samples.find(value => value.phase === phase);
  assert.equal(sample('navigation.preflight').duration, 5, 'public call timing includes first input/IME inspection');
  assert.ok(sample('navigation.confirmation.wait').duration > 150);
  assert.equal(sample('navigation.input.inspect').duration, 2, 'checking cost is separate from controlled wait');
  assert.ok(sample('navigation.input.confirmed').timestamp <= sample('navigation.surface').timestamp);
  assert.ok(sample('navigation.surface').timestamp <= sample('navigation.committed').timestamp);
  assert.equal(sample('navigation.focus').duration, 2);
  assert.ok(report.samples.every(value => value.operationId === 1));
  assert.equal(JSON.stringify(report).includes('fixture-b'), false); assert.equal(JSON.stringify(report).includes('never-record'), false);
  assert.deepEqual(Object.keys(receipt), ['threadId', 'hostId', 'inputConfirmed', 'submitDisabled', 'revision']);
  const decoded = summarizeNavigationTestPoints(report), phases = decoded.operations[0];
  assert.equal(decoded.fullWindowRetained, true); assert.equal(phases.complete, true);
  assert.equal(phases.metadataRequestsObserved, 0); assert.equal(phases.metadataMs, null, 'an unmeasured or unused stage is not reported as zero time');
  assert.equal(phases.confirmationCheckCount, 2); assert.equal(phases.confirmationCheckMs, 4);
  assert.equal(phases.unallocatedConfirmationMs, phases.confirmationWaitMs - 4, 'nested bind/read durations are not counted twice');
  assert.equal(frames.size, 0); f.provider.dispose();
  const written = metrics.report().written; await Promise.resolve(); assert.equal(metrics.report().written, written);
});

test('phase analysis marks wrapped or unfinished observations incomplete rather than filling missing times', () => {
  let clock = 0;
  const metrics = createWorkspaceMetrics({ enabled: true, runId: 'wrapped-navigation', capacity: 2, now: () => clock++ });
  metrics.add('navigation.call', { operationId: 1 }); metrics.add('navigation.executed', { operationId: 1 });
  metrics.add('navigation.input.confirmed', { operationId: 1 });
  metrics.end('navigation.confirmation.wait', 0, { operationId: 1 });
  metrics.end('navigation.committed', 0, { operationId: 1 });
  const summary = summarizeNavigationTestPoints(metrics.report());
  assert.equal(summary.fullWindowRetained, false); assert.equal(summary.omittedEarlierPoints, 3);
  assert.equal(summary.operations[0].complete, false); assert.equal(summary.operations[0].confirmationWaitMs, null);
  assert.equal(summary.operations[0].unallocatedConfirmationMs, null);
});

test('cold metadata and synchronous IME rejection retain independent metric aliases without consuming public revisions', async t => {
  let clock = 0;
  const metrics = createWorkspaceMetrics({ enabled: true, runId: 'cold-navigation', now: () => clock });
  const f = setup(t, { cold: true, metrics }); await f.navigation.ready;
  const first = f.navigation.open({ threadId: 'fixture-cold' });
  f.state.binding.controller.view.composing = true;
  assert.throws(() => f.navigation.open({ threadId: 'fixture-rejected' }), { code: 'workspace_composer_busy' });
  const rejected = metrics.report().samples.find(value => value.phase === 'navigation.preflight.failed');
  assert.equal(rejected.operationId, 2); assert.deepEqual(f.calls, []);
  f.state.binding.controller.view.composing = false; clock = 80;
  f.requests[0].resolve({ thread: { id: 'fixture-cold' } });
  const receipt = await first.committed; assert.equal(receipt.revision, 1);
  const metadata = metrics.report().samples.find(value => value.phase === 'navigation.metadata');
  assert.equal(metadata.operationId, 1); assert.equal(metadata.duration, 80);
  assert.equal(f.requests.length, 1); assert.deepEqual(f.nativeCalls, ['fixture-cold']);
  assert.equal(metrics.report().counts['navigation.dispatch.begin'], 1);
});

test('enabled and disabled navigation instrumentation preserve observer/frame lifecycle and the public contract', async t => {
  const receipts = [], lifecycle = [];
  for (const enabled of [false, true]) {
    const metrics = createWorkspaceMetrics(enabled ? { enabled: true, runId: 'lifecycle-phases' } : { enabled: false, get now() { assert.fail('disabled clock read'); } });
    const f = setup(t, { metrics }); let observers = 0, disconnects = 0, frames = 0, cancellations = 0;
    const Observer = f.window.MutationObserver;
    f.window.MutationObserver = class extends Observer { constructor(callback) { super(callback); observers++; } disconnect() { disconnects++; super.disconnect(); } };
    f.window.requestAnimationFrame = () => ++frames; f.window.cancelAnimationFrame = () => cancellations++;
    await f.navigation.ready; const operation = f.navigation.open({ threadId: 'fixture-b' });
    receipts.push(await operation.committed); assert.equal(f.navigation.focus({ revision: receipts.at(-1).revision }), true);
    f.provider.dispose(); lifecycle.push({ observers, disconnects, frames, cancellations });
    assert.deepEqual(f.requests, []);
  }
  assert.deepEqual(receipts[0], receipts[1]);
  assert.deepEqual(lifecycle[0], { observers: 1, disconnects: 1, frames: 1, cancellations: 1 });
  assert.deepEqual(lifecycle[0], lifecycle[1]);
});

test('phase-only Native input diagnosis avoids richer view/hook reads while preserving pending ownership', t => {
  const f = setup(t), root = f.document.getElementById('root'), input = f.editable.parentElement, scope = {};
  let richHookReads = 0;
  function ComposerMarker() { return 'onDocumentChange onDocumentDispose composerController'; }
  const current = {}, model = { type: ComposerMarker, memoizedState: { memoizedState: { current: { scope, node: {} } } }, return: current };
  const owner = { stateNode: input, return: model }, otherEditable = f.document.createElement('div');
  const otherController = { view: { dom: otherEditable } }, hook = {};
  Object.defineProperty(hook, 'controller', { get() { richHookReads++; return otherController; } });
  const provider = { tag: 10, memoizedProps: { value: otherController }, memoizedState: { memoizedState: { current: hook } }, return: owner };
  current.child = model; model.child = owner; owner.child = provider;
  root.__reactContainer$phase = { stateNode: { current } }; input.__reactFiber$phase = owner;
  const rich = [];
  assert.equal(inspectNativeInput({ composerScope: scope }, input, root, undefined, value => rich.push(value)), null);
  assert.equal(rich.at(-1).stage, 'controller'); assert.ok(rich.at(-1).views.length); assert.ok(richHookReads > 0);
  richHookReads = 0; const light = [], diagnose = value => light.push(value); diagnose.countsOnly = true;
  assert.equal(inspectNativeInput({ composerScope: scope }, input, root, undefined, diagnose), null);
  assert.equal(light.at(-1).stage, 'controller'); assert.equal(light.at(-1).views, null); assert.equal(richHookReads, 0);
});

test('Native draft metadata requires the initialized EditorProvider key and never reads or changes draft text',t=>{
  const f=setup(t),root=f.document.getElementById('root'),input=f.editable.parentElement,token={},value={kind:'local',conversationId:'fixture-five',clientThreadId:'local:fixture-five',routeKind:'local-thread'};
  const current={},facade={scope:token,node:{},value},controller=()=>({view:{dom:f.editable,composing:false,isDestroyed:false},getPersistedText(){assert.fail('draft read');},restoreDraft(){assert.fail('draft write');}});let editorController=controller();
  function Composer(){return 'onDocumentChange onDocumentDispose composerController';}
  function EditorProvider(){return 'getInitialContent getInitialInput onDocumentChange onDocumentDispose pending-input-ready';}
  const model={type:Composer,memoizedState:{memoizedState:{current:facade}},return:current},owner={stateNode:input,return:model};
  const editor={type:EditorProvider,key:value.clientThreadId,memoizedState:{memoizedState:{current:{controller:editorController}}},return:owner},provider={tag:10,memoizedProps:{value:editorController},return:editor},submission={memoizedProps:{onSubmitLocal(){assert.fail('submit');},submitDisabled:false},return:provider};
  current.child=model;model.child=owner;owner.child=editor;editor.child=provider;provider.child=submission;
  root.__reactContainer$draft={stateNode:{current}};input.__reactFiber$draft=owner;const native={composerScope:token,draftKey:value=>value.clientThreadId};
  const first=inspectNativeInput(native,input,root);assert.deepEqual(first.draft,{key:value.clientThreadId,kind:'local',conversationId:'fixture-five',clientThreadId:value.clientThreadId,entrypoint:null,routeKind:'local-thread'});
  editorController=controller();editor.memoizedState.memoizedState.current.controller=editorController;provider.memoizedProps.value=editorController;
  const next=inspectNativeInput(native,input,root);assert.notEqual(first.controller,next.controller);assert.deepEqual(next.draft,first.draft);
  editor.key='another-draft';assert.equal(inspectNativeInput(native,input,root).draft,null,'an initialized controller under the wrong key is not proof of the target draft');
});

test('Native empty home accepts nested providers sharing its controller and namespace but rejects conflicting ownership',t=>{
  const f=setup(t),root=f.document.getElementById('root'),input=f.editable.parentElement,token={},value={kind:'new',entrypoint:'home'};
  const current={},facade={scope:token,node:{},value},controller={view:{dom:f.editable,composing:false,isDestroyed:false},getPersistedText(){assert.fail('draft read');},restoreDraft(){assert.fail('draft write');}};
  function Composer(){return 'onDocumentChange onDocumentDispose composerController';}
  function EditorProvider(){return 'getInitialContent getInitialInput onDocumentChange onDocumentDispose pending-input-ready';}
  const model={type:Composer,memoizedState:{memoizedState:{current:facade}},return:current},owner={stateNode:input,return:model};
  const outer={type:EditorProvider,key:'home-draft',memoizedState:{memoizedState:{current:{controller}}},return:owner};
  const inner={type:EditorProvider,key:'home-draft',memoizedProps:{composerController:controller},return:outer};
  const context={tag:10,memoizedProps:{value:controller},return:inner},submission={memoizedProps:{onSubmitLocal(){assert.fail('submit');},submitDisabled:true},return:context};
  current.child=model;model.child=owner;owner.child=outer;outer.child=inner;inner.child=context;context.child=submission;
  root.__reactContainer$home={stateNode:{current}};input.__reactFiber$home=owner;
  const native={composerScope:token,draftKey:()=> 'home-draft'},phases=[],diagnose=phase=>phases.push(phase);diagnose.countsOnly=true;
  assert.deepEqual(inspectNativeInput(native,input,root,undefined,diagnose).draft,{key:'home-draft',kind:'new',conversationId:null,clientThreadId:null,entrypoint:'home',routeKind:null});
  assert.deepEqual(phases.at(-1).keyMatches,[true,true]);assert.equal(phases.at(-1).externalOwnerCount,1);
  inner.key='another-draft';assert.equal(inspectNativeInput(native,input,root).draft,null);
  inner.key='home-draft';inner.memoizedProps.composerController={...controller,view:{...controller.view}};
  inner.child={tag:10,memoizedProps:{value:inner.memoizedProps.composerController},return:inner,child:context};context.return=inner.child;
  assert.throws(()=>inspectNativeInput(native,input,root),{code:'workspace_composer_binding_drift'},'two distinct controllers for the same editable remain ambiguous');
});
