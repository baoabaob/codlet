import assert from 'node:assert/strict';
import test from 'node:test';
import {Manager} from '../frontend/src/codlet/controller.js';
import {createPreviewRuntime} from '../scripts/preview-runtime.mjs';
import {uiFixture,tick,deferred} from './support/ui-fixture.mjs';
const ready={available:true,restartPreserved:true,phase:'ready',isUpdateReady:true,combinedPhase:'idle',error:null};

test('combined confirmation binds the candidate, cancel does nothing, and a lost response never resubmits',async t=>{
  const demo=createPreviewRuntime(),calls=[],pending=deferred();demo.state.phase='available';
  const m=new Manager({pluginId:'codlet-gui',i18n:{locale:'en'},rpc:{request:async(cap,method,args)=>{calls.push(method);if(method==='installCombinedUpdate')return pending.promise;const reply=await demo.request(cap,method,args);return method==='versionStatus'?{...reply,officialUpdate:ready}:reply;}}});t.after(()=>m.dispose());
  await m.open();await m.pollVersions();m.setVisible(false);
  assert.equal(m.canCombineUpdates(),true);m.requestCombinedInstall();m.cancelCombinedInstall();assert.equal(calls.includes('installCombinedUpdate'),false);
  m.requestCombinedInstall();m.set({update:{...m.state.update,candidate:{...m.state.update.candidate,id:'changed'}}});await m.confirmCombinedInstall();assert.match(m.state.combinedConfirmation.error,/changed/);assert.equal(calls.includes('installCombinedUpdate'),false);
  m.cancelCombinedInstall();m.requestCombinedInstall();const first=m.confirmCombinedInstall();await m.confirmCombinedInstall();assert.equal(calls.filter(c=>c==='installCombinedUpdate').length,1);
  pending.reject(new Error('Lost reply'));await first;m.requestCombinedInstall();await m.confirmCombinedInstall();assert.equal(calls.filter(c=>c==='installCombinedUpdate').length,1);assert.equal(m.state.updateUncertain,true);
});

test('combined update is absent for unavailable official updates and uses a native confirmation dialog when both are ready',async t=>{
  const demo=createPreviewRuntime();demo.state.phase='available';let official={...ready,phase:'idle',isUpdateReady:false};
  const f=uiFixture({locale:'zh',request:async(cap,method,args)=>{const reply=await demo.request(cap,method,args);return method==='versionStatus'?{...reply,officialUpdate:official}:reply;}}),plugin=f.load('bundled/codlet/dist/renderer.js');t.after(()=>{plugin.deactivate();f.dispose();});
  await plugin.activate(f.context);await f.open();await f.click('设置');assert.equal(f.control('同时更新'),undefined);
  official=ready;await f.leave();await f.open();await f.click('设置');const button=f.control('同时更新');assert.ok(button);assert.equal(button.disabled,false);assert.equal(button.previousElementSibling.textContent,'下载更新');
  await f.click('同时更新');assert.ok(f.document.querySelector('[role=dialog]'));assert.match(f.document.querySelector('[role=dialog]').textContent,/同时更新 Codlet 和客户端/);assert.match(f.document.querySelector('[role=dialog]').textContent,/保留插件和设置/);
  await f.click('取消');await tick();assert.equal(f.document.querySelector('[role=dialog]'),null);assert.equal(f.document.activeElement,button);assert.equal(f.calls.some(c=>c.method==='installCombinedUpdate'),false);
});
