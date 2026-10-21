import test from 'node:test';
import assert from 'node:assert/strict';
import {createRequire} from 'node:module';
import {createComposerControls} from '../frontend/src/adapter/workspace-composer-controls.js';
import {createWorkspaceSelection} from '../frontend/src/adapter/workspace-selection.js';
const require=createRequire(new URL('../frontend/package.json',import.meta.url)),{JSDOM}=require('jsdom');

test('unchanged permission controls produce no DOM mutations during geometry frames',t=>{
  const dom=new JSDOM('<div data-codex-composer-root><button data-composer-navigation-target="permissions">Native</button></div>');
  t.after(()=>dom.window.close());const document=dom.window.document;
  const provider=createComposerControls({document,surface:()=>({composer:document.querySelector('div')}),check(){},isConfirmed:()=>true,changed(){}});
  const lease=provider.acquire({control:'permissions',threadId:'thread-a'},'consumer',()=>{});
  t.after(()=>lease.dispose());
  const observer=new dom.window.MutationObserver(()=>{});observer.observe(document.body,{subtree:true,attributes:true,childList:true});
  for(let i=0;i<60;i++)provider.reconcile();
  const mutations=observer.takeRecords();observer.disconnect();t.diagnostic(`unchanged permission mutations: ${mutations.length}`);
  assert.equal(mutations.length,0);
});

test('unchanged empty selection does not rewrite Native titlebar attributes or drag geometry',t=>{
  const dom=new JSDOM('<header style="-webkit-app-region:drag"><div class="min-w-0 text-base font-medium">Title</div><button>Native action</button></header>');
  t.after(()=>dom.window.close());const document=dom.window.document,header=document.querySelector('header');
  const provider=createWorkspaceSelection({document,surface:()=>({header}),snapshot:()=>({threadId:'thread-a'}),check(){},changed(){},isConfirmed:()=>false});
  const lease=provider.acquire({threadId:null},'consumer',()=>{});t.after(()=>lease.dispose());
  const observer=new dom.window.MutationObserver(()=>{});observer.observe(header,{subtree:true,attributes:true,childList:true});
  for(let i=0;i<60;i++)provider.reconcile();
  const mutations=observer.takeRecords();observer.disconnect();t.diagnostic(`unchanged titlebar mutations: ${mutations.length}`);
  assert.equal(mutations.length,0);
  assert.equal(header.getAttribute('style'),'-webkit-app-region:drag');
});
