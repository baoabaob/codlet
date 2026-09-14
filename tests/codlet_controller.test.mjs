import assert from 'node:assert/strict';
import test from 'node:test';
import {Manager} from '../frontend/src/codlet/controller.js';
import {createPreviewRuntime} from '../scripts/preview-runtime.mjs';
import {deferred} from './support/ui-fixture.mjs';
async function setup(t){const demo=createPreviewRuntime(),calls=[],overrides=new Map(),context={pluginId:'codlet-gui',i18n:{locale:'en'},rpc:{async request(cap,method,args){calls.push({method,args});return overrides.has(method)?overrides.get(method)(args):demo.request(cap,method,args);}}};const m=new Manager(context);t.after(()=>m.dispose());await m.open();await Promise.resolve();return {m,calls,overrides,demo,context};}
const count=(f,method)=>f.calls.filter(c=>c.method===method).length;
const local=async f=>{f.m.importPage();f.m.setPath('C:/Author/plugin');await f.m.inspectLocal();};
const trust=m=>{for(const p of m.state.preview.manifest.permissions)m.grant(p,true);m.set({trusted:true});};
const github=async f=>{f.m.importPage('github');f.m.setUrl('https://github.com/example/codlet-notes');await f.m.readReleases();f.m.selectRelease('20');f.m.selectAsset('200');await f.m.downloadAsset();};
test('each local import uses a fresh preview, explicit trust and all permissions, then submits once',async t=>{
  const f=await setup(t);await local(f);assert.equal(f.m.importReady(),false);f.m.set({trusted:true});assert.equal(f.m.importReady(),false);f.m.grant('ui.dom',true);assert.equal(f.m.importReady(),true);
  const one=f.m.submitImport(),two=f.m.submitImport();await Promise.all([one,two]);assert.equal(count(f,'prepare'),1);assert.equal(count(f,'submit'),1);
  const request=f.calls.find(c=>c.method==='prepare').args;assert.equal(request.local_import.enable,false);assert.deepEqual(request.local_import.grants,['ui.dom']);assert.equal(request.local_import.trusted,true);assert.equal(f.m.state.error,'');
  await local(f);assert.equal(f.m.state.trusted,false);assert.deepEqual(f.m.state.grants,[]);
});
test('changed paths and leaving import reject late previews and discard prior trust/policy',async t=>{
  const f=await setup(t);await local(f);trust(f.m);f.m.set({policy:{readRoots:'C:/Sensitive'}});const pending=deferred(),preview=f.m.state.preview;
  f.overrides.set('previewLocal',()=>pending.promise);const loading=f.m.inspectLocal();f.m.setPath('C:/Different/plugin');pending.resolve(preview);await loading;
  assert.equal(f.m.state.preview,null);assert.equal(f.m.state.trusted,false);assert.deepEqual(f.m.state.policy,{});f.m.back();assert.equal(f.m.timers.has('preview'),false);
});
test('folder picker is polled by selection ID, inspects selection and ignores cancellation and late replies',async t=>{
  const f=await setup(t);f.m.importPage();f.overrides.set('chooseLocalFolder',()=>({selectionId:'pick',status:'selected',path:'C:/Chosen'}));await f.m.chooseFolder();assert.equal(f.m.state.preview.path,'C:/Chosen');assert.equal(f.m.state.trusted,false);
  const late=deferred();f.overrides.set('chooseLocalFolder',()=>late.promise);const choose=f.m.chooseFolder();f.m.back();const before=count(f,'previewLocal');late.resolve({selectionId:'old',status:'selected',path:'C:/Late'});await choose;assert.equal(count(f,'previewLocal'),before);
  f.m.importPage();f.overrides.set('chooseLocalFolder',()=>({status:'cancelled'}));await f.m.chooseFolder();assert.equal(f.m.state.preview,null);assert.match(f.m.state.importStatus,/cancelled/);
});
test('malformed previews and unknown permissions never expose usable grants',async t=>{
  const f=await setup(t);await local(f);const preview=f.m.state.preview;
  for(const bad of [{...preview,registrationDigest:'bad'},{...preview,manifest:{...preview.manifest,permissions:['future.secret']}},{...preview,kind:'unknown'}]){f.overrides.set('previewLocal',()=>bad);await f.m.inspectLocal();assert.equal(f.m.state.preview,null);assert.equal(f.m.importReady(),false);}
  assert.equal(count(f,'submit'),0);
});
test('server prepare identity must match before any receipt can be submitted',async t=>{
  for(const request of [{action:'remove',plugin_id:'local.notes'},{action:'enable',plugin_id:'other'}]){const f=await setup(t);f.overrides.set('prepare',()=>({status:'prepared',operation:{operation_id:'wrong',request}}));await f.m.mutate('local.notes','enable');assert.equal(count(f,'submit'),0);assert.match(f.m.state.error,/prepared/);}
});
test('leaving the page while preparing abandons that unsubmitted receipt',async t=>{
  const f=await setup(t),late=deferred();f.overrides.set('prepare',()=>late.promise);const action=f.m.mutate('local.notes','enable');f.m.close();late.resolve({status:'prepared',operation:{operation_id:'late',request:{action:'enable',plugin_id:'local.notes'}}});await action;assert.equal(count(f,'submit'),0);assert.equal(f.m.pending,null);
});
test('lost submit responses only query the issued receipt; refresh never repeats submit',async t=>{
  const f=await setup(t);let operation;f.overrides.set('prepare',args=>({status:'prepared',operation:operation={operation_id:'receipt',request:args}}));f.overrides.set('submit',()=>{throw Error('lost');});f.overrides.set('operation',()=>({status:'running',operation}));
  await f.m.mutate('local.notes','enable');await f.m.refresh();assert.equal(count(f,'prepare'),1);assert.equal(count(f,'submit'),1);assert.ok(f.calls.filter(c=>c.method==='operation').every(c=>c.args.operationId==='receipt'));
  f.m.close();assert.equal(f.m.timers.has('mutation'),false);await f.m.open();assert.equal(count(f,'submit'),1);
  f.overrides.set('operation',()=>({status:'completed',operation:{...operation,completion:{kind:'report',report:{outcome:'applied',message:'Enabled'}}}}));await f.m.checkMutation();assert.equal(f.m.pending,null);assert.equal(f.m.state.error,'');
});
test('mismatched and expired operation replies cannot complete a receipt or enable a second action',async t=>{
  const f=await setup(t);f.overrides.set('operation',()=>({status:'completed',operation:{operation_id:'different',request:{action:'enable',plugin_id:'local.notes'},completion:{kind:'report',report:{outcome:'applied'}}}}));await f.m.mutate('local.notes','enable');assert.ok(f.m.pending);assert.match(f.m.state.error,/no longer available/);
  f.overrides.set('operation',()=>({status:'expired'}));await f.m.refresh();await f.m.mutate('local.notes','remove');assert.equal(count(f,'submit'),1);assert.equal(count(f,'prepare'),1);
});
test('a successful mutation cannot erase a failed list refresh or resubmit against stale values',async t=>{
  const f=await setup(t);f.demo.state.failure=true;
  await f.m.mutate('local.notes','enable');
  assert.equal(f.m.pending,null);assert.equal(f.m.state.operationError,'');assert.equal(f.m.state.listStale,true);
  assert.match(f.m.state.error,/Displayed values may be out of date/);assert.equal(f.m.state.plugins.find(p=>p.id==='local.notes').enabled,false);
  await f.m.mutate('local.notes','enable');assert.equal(count(f,'submit'),1);
  f.demo.state.failure=false;await f.m.refresh();
  assert.equal(f.m.state.listStale,false);assert.equal(f.m.state.error,'');assert.equal(f.m.state.plugins.find(p=>p.id==='local.notes').enabled,true);assert.equal(count(f,'submit'),1);
});
test('operation errors and list errors remain independent across refresh and the next operation',async t=>{
  const f=await setup(t);f.overrides.set('prepare',()=>({error:'Operation rejected'}));f.demo.state.failure=true;
  await f.m.mutate('local.notes','enable');assert.match(f.m.state.error,/Operation rejected/);assert.match(f.m.state.error,/Displayed values may be out of date/);
  f.demo.state.failure=false;await f.m.refresh();assert.equal(f.m.state.error,'Operation rejected');assert.equal(f.m.state.listError,'');
  f.overrides.delete('prepare');await f.m.mutate('local.notes','enable');assert.equal(f.m.state.error,'');
});
test('overlapping lists and old generations cannot publish stale success or errors',async t=>{
  const f=await setup(t),old=deferred();f.overrides.set('list',()=>old.promise);const first=f.m.refresh();f.m.close();f.overrides.set('list',()=>({plugins:[{id:'fresh'}]}));await f.m.open();old.resolve({plugins:[{id:'stale'}]});await first;assert.deepEqual(f.m.state.plugins,[{id:'fresh'}]);
  const late=deferred();f.overrides.set('list',()=>late.promise);const next=f.m.refresh();f.m.dispose();late.reject(Error('old error'));await next;assert.equal(f.m.state.error,'');
});
test('GitHub exact selection binds package source and resets trust on every asset/URL change',async t=>{
  const f=await setup(t);await github(f);assert.equal(f.m.state.preview.source.assetId,200);assert.equal(f.m.state.trusted,false);trust(f.m);f.m.selectAsset('201');assert.equal(f.m.state.preview,null);assert.equal(f.m.state.trusted,false);assert.deepEqual(f.m.state.grants,[]);
  f.m.setUrl('https://github.com/new/owner');assert.equal(f.m.state.catalog,null);
});
test('a package preview for a different selected asset is rejected before trust',async t=>{
  const f=await setup(t);await github(f);const preview=f.m.state.preview;f.m.selectAsset('200');f.overrides.set('githubPrepare',()=>({jobId:'mismatch',kind:'package',status:'completed',result:{...preview,source:{...preview.source,assetId:201}}}));await f.m.downloadAsset();assert.equal(f.m.state.preview,null);assert.match(f.m.state.importStatus,/match/);assert.equal(count(f,'prepare'),0);
});
test('closing a GitHub start cancels its late job and never accepts its preview',async t=>{
  const f=await setup(t);await github(f);const preview=f.m.state.preview,pending=deferred();f.overrides.set('githubPrepare',()=>pending.promise);const action=f.m.downloadAsset();f.m.close();pending.resolve({jobId:'late-job',kind:'package',status:'completed',result:preview});await action;assert.equal(f.m.state.preview,null);assert.ok(f.calls.some(c=>c.method==='cancelGitHubJob'&&c.args.jobId==='late-job'));
});
test('failed job polling retries the same job, rejects mismatched IDs and allows cancellation',async t=>{
  const f=await setup(t);f.m.importPage('github');f.m.setUrl('https://github.com/example/notes');f.overrides.set('githubReleases',()=>({jobId:'only-job',kind:'releases',status:'running'}));await f.m.readReleases();f.overrides.set('githubJob',()=>{throw Error('lost');});await f.m.pollJob();assert.equal(f.m.state.jobRetry,true);f.overrides.set('githubJob',()=>({jobId:'wrong',kind:'releases',status:'completed',result:{}}));await f.m.pollJob();assert.equal(count(f,'githubReleases'),1);assert.ok(f.m.job);f.m.cancelImportJob();assert.equal(f.m.job,null);assert.equal(count(f,'prepare'),0);
});
test('managed update and rollback require new grants and bind the target plugin identity',async t=>{
  const f=await setup(t),plugin=f.m.state.plugins.find(p=>p.id==='managed.notes');await f.m.importPage('github',plugin);f.m.selectRelease('20');f.m.selectAsset('200');await f.m.downloadAsset();assert.equal(f.m.state.preview.operation,'update');trust(f.m);await f.m.submitImport();assert.equal(f.calls.find(c=>c.method==='prepare').args.action,'update');
  await f.m.rollback(plugin,'v1');assert.equal(f.m.state.preview.operation,'rollback');assert.equal(f.m.state.trusted,false);assert.equal(f.m.state.enableAfter,false);trust(f.m);await f.m.submitImport();assert.equal(f.calls.filter(c=>c.method==='prepare').at(-1).args.action,'rollback');
});
test('permission details are fresh, scoped by ID, and revocation is explicitly confirmed',async t=>{
  const f=await setup(t),plugin=f.m.state.plugins.find(p=>p.id==='local.notes');await f.m.details(plugin);assert.deepEqual(f.m.state.details.grants,['ui.dom']);await f.m.openFolder();assert.deepEqual(f.calls.find(c=>c.method==='openFolder').args,{pluginId:'local.notes'});
  await f.m.requestRemoval(f.m.state.details,'ui.dom');assert.equal(count(f,'prepare'),0);await f.m.confirm();assert.deepEqual(f.calls.find(c=>c.method==='prepare').args,{action:'revoke',plugin_id:'local.notes',permission:'ui.dom'});
});
test('optional deletion uses the preview identities only, defaults off, and keeps the one remove receipt',async t=>{
  const f=await setup(t),plugin=f.m.state.plugins.find(p=>p.id==='local.notes');await f.m.requestRemoval(plugin);assert.equal(f.m.state.confirmation.deleteSource,false);f.m.setDeleteSource(true);await f.m.confirm();assert.deepEqual(f.calls.find(c=>c.method==='prepare').args.remove_source,{registrationDigest:'b'.repeat(64),sourceIdentity:'fixture-source'});assert.equal(count(f,'submit'),1);
});
test('missing/blocked sources remain removable and cancelled source previews cannot revive deletion',async t=>{
  const f=await setup(t),plugin=f.m.state.plugins.find(p=>p.id==='local.notes');f.overrides.set('sourceRemovalPreview',()=>({pluginId:plugin.id,status:'missing'}));await f.m.requestRemoval(plugin);f.m.setDeleteSource(true);assert.equal(f.m.state.confirmation.deleteSource,false);await f.m.confirm();assert.equal(f.calls.find(c=>c.method==='prepare').args.remove_source,undefined);
  const pending=deferred();f.overrides.set('sourceRemovalPreview',()=>pending.promise);const removal=f.m.requestRemoval(plugin);f.m.cancelConfirmation();pending.resolve({pluginId:plugin.id,status:'available',registrationDigest:'c'.repeat(64),sourceIdentity:'old'});await removal;assert.equal(f.m.state.confirmation,null);
});
test('history pagination preserves current-version identity, ignores duplicates and retries only the failed cursor',async t=>{
  const f=await setup(t);f.m.set({page:'details',details:{id:'managed.notes'},historyCursor:0});let page=0;
  f.overrides.set('managedHistory',args=>{page++;if(page===1)return {pluginId:'managed.notes',currentVersion:'v2',history:[{versionKey:'v2',manifest:{version:'2'},source:{tag:'v2'}}],nextCursor:1};if(page===2)throw Error('lost');return {pluginId:'managed.notes',currentVersion:'v2',history:[{versionKey:'v2',manifest:{version:'2'},source:{tag:'v2'}},{versionKey:'v1',manifest:{version:'1'},source:{tag:'v1'}}],nextCursor:null};});
  await f.m.loadHistory();await f.m.loadHistory();assert.equal(f.m.state.historyCursor,1);await f.m.loadHistory();assert.equal(f.m.state.history.length,2);assert.equal(f.m.state.historyCursor,null);assert.deepEqual(f.calls.filter(c=>c.method==='managedHistory').map(c=>c.args.cursor),[undefined,1,1]);
});
test('invalid or late history cursors never replace accepted pages',async t=>{
  const f=await setup(t);f.m.set({page:'details',details:{id:'managed.notes'},historyCursor:0});f.overrides.set('managedHistory',()=>({pluginId:'managed.notes',currentVersion:'v2',history:[],nextCursor:0}));await f.m.loadHistory();assert.match(f.m.state.historyError,/cursor/);assert.equal(f.m.state.historyCursor,0);
  const pending=deferred();f.overrides.set('managedHistory',()=>pending.promise);const loading=f.m.loadHistory();f.m.back();pending.resolve({pluginId:'managed.notes',currentVersion:'v2',history:[],nextCursor:null});await loading;assert.equal(f.m.state.page,'plugins');assert.equal(f.m.state.historyCursor,0);
});
test('update check, download, and install are separate actions; installation requires confirmation',async t=>{
  const f=await setup(t);assert.equal(f.m.state.update.configured,false);await f.m.loadUpdate('installRuntimeUpdate');assert.equal(count(f,'installRuntimeUpdate'),0);
  await f.m.loadUpdate('checkRuntimeUpdate');assert.equal(f.m.state.update.phase,'available');assert.equal(count(f,'downloadRuntimeUpdate'),0);await f.m.loadUpdate('downloadRuntimeUpdate');assert.equal(f.m.state.update.phase,'downloaded');assert.equal(count(f,'installRuntimeUpdate'),0);f.m.requestInstall();assert.equal(f.m.state.confirmation.kind,'install');await f.m.confirm();assert.equal(count(f,'installRuntimeUpdate'),1);
});
test('a lost update command response prevents repeat commands until an authoritative status query',async t=>{
  const f=await setup(t);await f.m.loadUpdate('checkRuntimeUpdate');f.overrides.set('downloadRuntimeUpdate',()=>{throw Error('lost reply');});await f.m.loadUpdate('downloadRuntimeUpdate');assert.equal(f.m.state.updateUncertain,true);await f.m.loadUpdate('downloadRuntimeUpdate');assert.equal(count(f,'downloadRuntimeUpdate'),1);f.demo.state.phase='downloaded';await f.m.loadUpdate();assert.equal(f.m.state.updateUncertain,false);assert.equal(f.m.state.update.phase,'downloaded');
});
test('an install confirmation cannot authorize a different downloaded update',async t=>{
  const f=await setup(t);await f.m.loadUpdate('checkRuntimeUpdate');await f.m.loadUpdate('downloadRuntimeUpdate');f.m.requestInstall();
  f.m.set({update:{...f.m.state.update,candidate:{id:'different',version:'9.0.0'}}});await f.m.confirm();assert.equal(count(f,'installRuntimeUpdate'),0);assert.match(f.m.state.confirmation.error,/update changed/);
});
