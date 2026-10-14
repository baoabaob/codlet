import test from 'node:test';
import assert from 'node:assert/strict';
import {uiFixture} from './support/ui-fixture.mjs';
function fixture(){const f=uiFixture(),channels=[],dispose=f.dispose;f.dispose=()=>{dispose();for(const c of channels){c.port1.close();c.port2.close();}};f.context.pluginId='dev.core-cost';f.window.MessageChannel=class extends MessageChannel{constructor(){super();channels.push(this);}};f.window.PerformanceObserver=class{observe(){}disconnect(){}takeRecords(){return[];}};f.plugin=f.load('scripts/native-core/renderer.js');f.plugin.activate(f.context);f.lab=f.window.__codletCoreCostLab;return f;}
test('Native cost fixture checks revisions and keeps portal controls connected in both scopes',async()=>{
 const f=fixture();try{for(const mode of ['scheduled','sync'])for(const style of ['neutral-split','styled']){
  const setup=await f.lab.setup({roots:2,items:20,mode,style});assert.equal(setup.styleBoundary,true);
  assert.equal([...f.document.querySelectorAll('button')].filter(n=>n.textContent==='Fixture control').length,2);
  const result=await f.lab.runCase({samples:2});assert.equal(result.request.n,4);assert.equal(result.commitLatency.n,4);assert.equal(result.domRevisionsMatch,true);
  const end=f.lab.cleanup();assert.equal(end.ownedObservers,0);assert.equal(end.ownedMediaListeners,0);assert.equal(end.ownedUiContainers,0);assert.equal(end.ownedDom,0);
 }}finally{f.dispose();}
});
test('Native cost fixture rejects hidden frame samples and unaudited control clicks',async()=>{
 const f=fixture();try{Object.defineProperty(f.document,'visibilityState',{value:'hidden'});await assert.rejects(f.lab.setup({roots:0}),/not visible/);assert.throws(()=>f.lab.armNative({label:'Send'}),/audited sidebar/);}finally{f.dispose();}
});
test('Native theme fixture verifies zero redundant writes and restores host theme',async()=>{
 const f=fixture();try{await f.lab.setup({roots:2,items:20});const original=f.document.documentElement.getAttribute('data-theme');const report=await f.lab.theme();assert.equal(report.sameSignatureWrites,0);assert.equal(report.existingWritesOnCreate,0);assert.equal(f.document.documentElement.getAttribute('data-theme'),original);assert.ok(report.themeReceipts.every(r=>r.themes.every(t=>t===r.target)));f.lab.cleanup();}finally{f.dispose();}
});

test('explicit background measurement waits for real commits and omits frame claims',async()=>{
 const f=fixture();try{Object.defineProperty(f.document,'visibilityState',{value:'hidden'});await f.lab.setup({roots:2,items:20,background:true});const report=await f.lab.runCase({samples:3});assert.equal(report.commitLatency.n,6);assert.equal(report.visibleFrameOpportunity,null);assert.equal(report.frameIntervals,null);assert.equal(report.postedTaskCompletion.n,3);assert.equal(report.domRevisionsMatch,true);const theme=await f.lab.theme();assert.equal(theme.themeFrameOpportunityMs,null);assert.equal(theme.sameSignatureWrites,0);assert.equal(theme.existingWritesOnCreate,0);assert.equal(f.lab.cleanup().ownedObservers,0);}finally{f.dispose();}
});

test('UI cleanup accounting separates the Native lazy plugin-lifetime locale observer',async()=>{
 const f=fixture(),locale=f.context.i18n;let observer;
 Object.defineProperty(f.context,'i18n',{get(){if(!observer){observer=new f.window.MutationObserver(()=>{});observer.observe(f.document.documentElement,{attributes:true});f.cleanups.add(()=>observer.disconnect());}return locale;}});
 try{await f.lab.setup({roots:1,items:20,background:true});assert.equal(f.lab.cleanup().ownedObservers,0);assert.ok(f.observers.has(observer));}finally{f.dispose();}assert.equal(f.observers.has(observer),false);
});

test('burst and cancellation fixture accounts for every request and no late commit',async()=>{
 const f=fixture();try{const result=await f.lab.lifecycle();assert.equal(result.commits+result.coalesced,200);assert.equal(result.cancelledPending,8);assert.equal(result.lateCommits,0);assert.equal(result.released.ownedUiContainers,0);}finally{f.dispose();}
});
