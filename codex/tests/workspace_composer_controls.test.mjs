import assert from 'node:assert/strict';
import test from 'node:test';
import {createRequire} from 'node:module';
import {createComposerControls} from '../frontend/src/adapter/workspace-composer-controls.js';
const require=createRequire(new URL('../frontend/package.json',import.meta.url)),{JSDOM}=require('jsdom');
test('permission control lease follows Native replacement, blocks old trigger and preserves editor, draft and later style changes',async t=>{
  const dom=new JSDOM('<main><div data-codex-composer-root><div contenteditable="true">unsent draft</div><span><button data-composer-navigation-target="permissions" style="display:inline-block">Native</button></span><button id="send">Send</button></div></main>');t.after(()=>dom.window.close());
  const document=dom.window.document,input=document.querySelector('[data-codex-composer-root]'),editor=input.firstElementChild,native=input.querySelector('[data-composer-navigation-target]');let current='thread-a';
  const controls=createComposerControls({document,surface:()=>({composer:input}),check(){},isConfirmed:id=>id===current,changed(){}});
  const lease=controls.acquire({control:'permissions',threadId:'thread-a'},'consumer',()=>{});await lease.ready;
  assert.equal(native.style.display,'none');assert.equal(native.hasAttribute('inert'),true);assert.equal(lease.container.nextSibling,native);assert.equal(lease.container.hasAttribute('inert'),false);
  assert.equal(editor.textContent,'unsent draft');assert.equal(input.firstElementChild,editor);assert.equal(document.getElementById('send').disabled,false);
  await lease.updateBinding({threadId:null});assert.equal(lease.container.hasAttribute('inert'),true);
  const replacement=native.cloneNode(true);replacement.style.display='flex';replacement.removeAttribute('inert');replacement.removeAttribute('aria-hidden');native.replaceWith(replacement);controls.reconcile();
  assert.equal(native.style.display,'inline-block');assert.equal(replacement.style.display,'none');assert.equal(lease.container.nextSibling,replacement);
  current='thread-b';await lease.updateBinding({threadId:'thread-b'});replacement.style.display='inline-flex';controls.reconcile();lease.dispose();
  assert.equal(replacement.style.display,'inline-flex');assert.equal(replacement.hasAttribute('inert'),false);assert.equal(lease.container.isConnected,false);assert.equal(editor.textContent,'unsent draft');
});
test('a missing or mismatching Native permission trigger cannot create a misleading replacement control',t=>{
  const dom=new JSDOM('<div data-codex-composer-root></div>');t.after(()=>dom.window.close());const document=dom.window.document;
  const controls=createComposerControls({document,surface:()=>({composer:document.querySelector('div')}),check(){},isConfirmed:()=>false,changed(){}});
  assert.throws(()=>controls.acquire({control:'permissions',threadId:'thread-a'},'consumer',()=>{}),{code:'workspace_selection_not_confirmed'});
  assert.throws(()=>controls.acquire({control:'permissions',threadId:null},'consumer',()=>{}),{code:'workspace_control_unsupported'});assert.equal(document.querySelector('[data-codlet-workspace-owned]'),null);
});

test('ambiguous Native replacement disables all candidate triggers until the failed lease is released',t=>{
  const dom=new JSDOM('<div data-codex-composer-root><button data-composer-navigation-target="permissions">Native</button></div>');t.after(()=>dom.window.close());const document=dom.window.document,input=document.querySelector('div'),native=input.firstElementChild;
  const controls=createComposerControls({document,surface:()=>({composer:input}),check(){},isConfirmed:()=>true,changed(){}}),lease=controls.acquire({control:'permissions',threadId:'thread-a'},'consumer',()=>{});
  const second=document.createElement('button');second.dataset.composerNavigationTarget='permissions';input.append(second);
  assert.throws(()=>controls.reconcile(),{code:'workspace_control_unsupported'});assert.equal(native.style.display,'none');assert.equal(second.style.display,'none');assert.equal(lease.container.hasAttribute('inert'),true);
  assert.throws(()=>controls.reconcile(),{code:'workspace_control_unsupported'});controls.dispose();assert.equal(native.style.display,'');assert.equal(second.style.display,'');assert.equal(native.hasAttribute('inert'),false);assert.equal(second.hasAttribute('inert'),false);assert.equal(lease.container.isConnected,false);
});
