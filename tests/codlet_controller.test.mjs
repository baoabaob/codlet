import assert from 'node:assert/strict';
import test from 'node:test';
import {Manager} from '../frontend/src/codlet/controller.js';
import {createPreviewRuntime} from '../scripts/preview-runtime.mjs';
import {deferred} from './support/ui-fixture.mjs';
async function setup(t){const demo=createPreviewRuntime(),calls=[],overrides=new Map(),context={pluginId:'codlet-gui',i18n:{locale:'en'},rpc:{async request(cap,method,args){calls.push({method,args});return overrides.has(method)?overrides.get(method)(args):demo.request(cap,method,args);}}};const m=new Manager(context);t.after(()=>m.dispose());await m.open();await Promise.resolve();return {m,calls,overrides,demo,context};}
const count=(f,method)=>f.calls.filter(c=>c.method===method).length;
test('one-click updates use one Core batch without manual release or download steps and survive closing the page',async t=>{
  const f=await setup(t),p=f.m.state.plugins.find(p=>p.id==='managed.notes');let batch={id:1,running:true,items:[{pluginId:p.id,versionKey:p.managedVersionKey??'old',phase:'downloading'}]};
  f.overrides.set('updatePlugins',()=>batch);const old=f.demo.request;
  f.overrides.set('versionStatus',async()=>({...await old(null,'versionStatus',null),pluginInstall:batch}));
  await f.m.updatePlugins([p]);await f.m.updatePlugins([p]);assert.equal(count(f,'updatePlugins'),1);assert.equal(count(f,'githubReleases'),0);assert.equal(count(f,'githubPrepare'),0);assert.equal(count(f,'submit'),0);
  f.m.close();await f.m.open();assert.equal(f.m.installingPlugins(),true);assert.equal(count(f,'updatePlugins'),1);
  batch={...batch,running:false,items:[{...batch.items[0],phase:'updated'}]};const lists=count(f,'list');await f.m.pollVersions();assert.equal(f.m.installingPlugins(),false);assert.ok(count(f,'list')>lists);
});
test('an uncertain update command cannot repeat until Core returns its authoritative batch',async t=>{
  const f=await setup(t),p=f.m.state.plugins.find(p=>p.id==='managed.notes');f.m.setVisible(false);
  f.overrides.set('updatePlugins',()=>{throw Error('Lost reply');});await f.m.updatePlugins([p]);await f.m.updatePlugins([p]);assert.equal(count(f,'updatePlugins'),1);assert.equal(f.m.state.pluginInstallUncertain,true);
  f.m.close();assert.equal(count(f,'updatePlugins'),1);
});
test('plugin creation dispatches one native draft and never retries an uncertain response',async t=>{
  const f=await setup(t),pending=deferred();f.overrides.set('newTaskDraft',()=>pending.promise);f.m.set({locale:'zh'});
  const opening=f.m.createPlugin();await f.m.createPlugin();assert.equal(count(f,'newTaskDraft'),1);assert.equal(f.calls.find(c=>c.method==='newTaskDraft').args.prompt,'[$codlet](C:/Preview/runtime-skills/codlet/SKILL.md) 帮我创建一个插件：');
  pending.reject(Error('Lost reply'));await opening;assert.equal(f.m.state.createBusy,false);assert.match(f.m.state.operationError,/could not be opened/);await f.m.refresh();assert.equal(count(f,'newTaskDraft'),1);assert.equal(count(f,'submit'),0);
});
test('quick start selects the same Core-owned skill with a general help draft and missing skill cannot silently fall back',async t=>{
  const f=await setup(t);await f.m.quickStart();const draft=f.calls.find(c=>c.method==='newTaskDraft').args.prompt;
  assert.match(draft,/^\[\$codlet\]\(C:\/Preview\/runtime-skills\/codlet\/SKILL.md\) Introduce Codlet/);
  assert.doesNotMatch(draft,/create a plugin:/);assert.equal(count(f,'submit'),0);
  f.m.set({runtimeSkill:null});await f.m.createPlugin();assert.equal(count(f,'newTaskDraft'),1);assert.match(f.m.state.operationError,/skill is unavailable/);
});
test('manual scan coalesces, blocks installation until complete, and Update all uses only displayed registered candidates',async t=>{
  const f=await setup(t),pending=deferred();f.m.setVisible(false);f.overrides.set('checkPluginUpdates',()=>pending.promise);
  const checking=f.m.checkPluginUpdates();await f.m.checkPluginUpdates();await f.m.updatePlugins([f.m.state.plugins.at(-1)]);
  assert.equal(count(f,'checkPluginUpdates'),1);assert.equal(count(f,'updatePlugins'),0);
  pending.resolve(await f.demo.request(null,'checkPluginUpdates'));await checking;
  f.m.set({plugins:[...f.m.state.plugins,{id:'removed',registered:false,ownership:'core-managed-github',managedVersionKey:'old'}],pluginUpdates:{...f.m.state.pluginUpdates,plugins:{...f.m.state.pluginUpdates.plugins,removed:{versionKey:'old',status:'available'}}}});
  assert.equal(f.m.updateCandidates().length,1);await f.m.updatePlugins();assert.deepEqual(f.calls.find(c=>c.method==='updatePlugins').args,{pluginIds:['managed.notes']});
});
test('summary distinguishes enabled preferences from healthy execution and excludes removed registrations',async t=>{
  const f=await setup(t);f.m.set({plugins:[{id:'a',enabled:true,active:true,validation:{status:'ok'}},{id:'b',enabled:true,active:false,validation:{status:'ok'}},{id:'c',enabled:true,active:true,validation:{status:'failed'}},{id:'d',enabled:false},{id:'e',enabled:true,active:true,validation:{status:'ok'},execution:{error:'failed'}},{id:'gone',registered:false}]});
  assert.deepEqual(f.m.pluginSummary(),{total:5,healthy:1,disabled:1,attention:3});
});
test('version reads use local client facts without invoking the official updater',async t=>{
  const f=await setup(t);await f.m.pollVersions();
  assert.equal(f.m.state.clientStatus.runningVersion,'26.908.4834.0');
  assert.deepEqual(f.m.state.clientStatus.adaptedVersions,['26.908.4834.0']);
  assert.equal(count(f,'getClientUpdateStatus'),0);assert.equal(count(f,'checkClientUpdates'),0);
  f.demo.state.versionFailure=true;await f.m.pollVersions();
  assert.equal(f.m.state.runtimeVersion,'0.1.0');assert.match(f.m.state.versionError,/unavailable/);
});
test('runtime folders use only fixed locations, suppress duplicate clicks and do not retry ambiguous opens',async t=>{
  const f=await setup(t),pending=deferred();
  f.m.set({listStale:true});
  f.overrides.set('openRuntimeFolder',()=>pending.promise);
  const opening=f.m.openRuntimeFolder('logs');
  await f.m.openRuntimeFolder('logs');await f.m.openRuntimeFolder('installation');await f.m.openRuntimeFolder('C:/arbitrary');
  assert.equal(count(f,'openRuntimeFolder'),1);assert.deepEqual(f.calls.find(c=>c.method==='openRuntimeFolder').args,{location:'logs'});
  pending.reject(new Error('Explorer response unavailable'));await opening;
  assert.equal(f.m.state.folderBusy,null);assert.match(f.m.state.folderError,/Explorer response unavailable/);
  f.overrides.set('openRuntimeFolder',()=>({opened:true}));await f.m.openRuntimeFolder('installation');
  assert.equal(count(f,'openRuntimeFolder'),2);assert.equal(f.m.state.folderError,'');
});
const local=async f=>{f.m.importPage();f.m.setPath('C:/Author/plugin');await f.m.inspectLocal();};
const trust=m=>{for(const p of m.state.preview.manifest.permissions)m.grant(p,true);m.set({trusted:true});};
const github=async f=>{f.m.importPage('github');f.m.setUrl('https://github.com/example/codlet-notes');await f.m.readReleases();f.m.selectRelease('20');f.m.selectAsset('200');await f.m.downloadAsset();};
test('each local import uses a fresh preview, explicit trust and all permissions, then submits once',async t=>{
  const f=await setup(t);await local(f);assert.equal(f.m.importReady(),false);f.m.set({trusted:true});assert.equal(f.m.importReady(),false);f.m.grant('ui.dom',true);assert.equal(f.m.importReady(),true);
  f.m.submitImport();f.m.submitImport();assert.equal(count(f,'prepare'),0);assert.equal(count(f,'submit'),0);
  const one=f.m.confirmImport(),two=f.m.confirmImport();await Promise.all([one,two]);assert.equal(count(f,'prepare'),1);assert.equal(count(f,'submit'),1);
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
test('a lost GitHub start reply stops loading, ignores its late result and allows an explicit retry',async t=>{
  const f=await setup(t),pending=deferred();f.m.setVisible(false);
  t.mock.timers.enable({apis:['setTimeout']});
  f.m.importPage('github');f.m.setUrl('https://github.com/example/notes');
  f.overrides.set('githubReleases',()=>pending.promise);
  const reading=f.m.readReleases();t.mock.timers.tick(8000);
  assert.match(f.m.state.importStatus,/longer than usual/);assert.equal(f.m.state.importBusy,true);
  t.mock.timers.tick(22000);assert.equal(f.m.state.importBusy,false);assert.equal(f.m.job,null);
  assert.match(f.m.state.importStatus,/timed out/);assert.equal(count(f,'githubReleases'),1);
  pending.resolve({jobId:'late',kind:'releases',status:'running'});await reading;
  assert.deepEqual(f.calls.filter(c=>c.method==='cancelGitHubJob').map(c=>c.args.jobId),['late']);
  f.overrides.delete('githubReleases');await f.m.readReleases();assert.ok(f.m.state.catalog);
  assert.equal(count(f,'githubReleases'),2);assert.equal(count(f,'prepare'),0);
  t.mock.timers.tick(135000);assert.ok(f.m.state.catalog);assert.equal(f.m.state.importBusy,false);
});
test('a stalled GitHub status reply is cancelled once and cannot overwrite a later retry',async t=>{
  const f=await setup(t),pending=deferred();f.m.setVisible(false);t.mock.timers.enable({apis:['setTimeout']});
  f.m.importPage('github');f.m.setUrl('https://github.com/example/notes');
  f.overrides.set('githubReleases',()=>({jobId:'stalled',kind:'releases',status:'running'}));
  f.overrides.set('githubJob',()=>pending.promise);await f.m.readReleases();const polling=f.m.pollJob();
  t.mock.timers.tick(30000);assert.equal(f.m.state.importBusy,false);assert.match(f.m.state.importStatus,/timed out/);
  assert.equal(count(f,'cancelGitHubJob'),1);assert.equal(count(f,'githubJob'),1);
  f.overrides.delete('githubReleases');await f.m.readReleases();const catalog=f.m.state.catalog;
  pending.resolve({jobId:'stalled',kind:'releases',status:'failed',error:{message:'old error'}});await polling;
  assert.equal(f.m.state.catalog,catalog);assert.doesNotMatch(f.m.state.importStatus,/old error/);assert.equal(count(f,'submit'),0);
});
test('package preparation keeps its download budget and all terminal jobs clear their timers',async t=>{
  const f=await setup(t);f.m.setVisible(false);t.mock.timers.enable({apis:['setTimeout']});await github(f);
  assert.equal(f.m.timers.size,0);
  f.overrides.set('githubPrepare',()=>({jobId:'package',kind:'package',status:'running'}));
  f.overrides.set('githubJob',()=>new Promise(()=>{}));await f.m.downloadAsset();
  t.mock.timers.tick(30000);assert.equal(f.m.state.importBusy,true);
  t.mock.timers.tick(105000);assert.equal(f.m.state.importBusy,false);assert.match(f.m.state.importStatus,/package timed out/);
  assert.equal(f.m.timers.size,0);assert.equal(count(f,'cancelGitHubJob'),1);assert.equal(count(f,'submit'),0);
});
test('Core GitHub timeouts use localized actionable text without leaving loading active',async t=>{
  const f=await setup(t);f.context.i18n.locale='zh';f.m.importPage('github');f.m.setUrl('https://github.com/example/notes');
  f.overrides.set('githubReleases',()=>({jobId:'failed',kind:'releases',status:'failed',error:{code:'github_timeout',message:'transport error'}}));
  await f.m.readReleases();assert.equal(f.m.state.importBusy,false);
  assert.equal(f.m.messages.t(f.m.state.importStatus),'读取 GitHub 发布版本超时，请检查网络或代理后重试');
  assert.equal(f.m.timers.has('github-deadline'),false);assert.equal(f.m.timers.has('github-slow'),false);
});
test('manual managed updates require new grants and bind the target plugin identity',async t=>{
  const f=await setup(t),plugin=f.m.state.plugins.find(p=>p.id==='managed.notes');await f.m.importPage('github',plugin);f.m.selectRelease('20');f.m.selectAsset('200');await f.m.downloadAsset();assert.equal(f.m.state.preview.operation,'update');trust(f.m);f.m.submitImport();assert.equal(count(f,'prepare'),0);await f.m.confirmImport();assert.equal(f.calls.find(c=>c.method==='prepare').args.action,'update');
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
test('managed details use the current source without requesting retained version history',async t=>{
  const f=await setup(t),plugin=f.m.state.plugins.find(p=>p.id==='managed.notes');
  await f.m.details(plugin);assert.equal(f.m.state.details.ownership,'core-managed-github');
  assert.ok(f.m.state.details.managedSource);assert.equal(count(f,'managedHistory'),0);
  await f.m.importPage('github',f.m.state.details);assert.equal(f.m.state.importOperation,'update');
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
test('enabled filters combine with search and exclude unknown flags from confirmed states',async t=>{
  const f=await setup(t);f.m.set({plugins:[{id:'yes',enabled:true,name:'notes'},{id:'no',enabled:false,name:'notes'},{id:'unknown',name:'notes'},{id:'other',enabled:true,name:'other'}]});
  f.m.setQuery('notes');f.m.setFilter('enabled');assert.deepEqual(f.m.filtered().map(p=>p.id),['yes']);f.m.setFilter('disabled');assert.deepEqual(f.m.filtered().map(p=>p.id),['no']);f.m.setFilter('all');assert.equal(f.m.filtered().length,3);
});
test('version reads observe client changes without refreshing lists even on an unconfigured build',async t=>{
  const f=await setup(t),lists=count(f,'list');assert.equal(f.m.state.update.configured,false);f.demo.state.client='unmatched';await f.m.pollVersions();assert.equal(f.m.state.clientStatus.matchesRunningClient,false);assert.equal(count(f,'list'),lists);assert.ok(f.m.timers.has('version'));
  f.m.setVisible(false);const reads=count(f,'versionStatus');await f.m.pollVersions();assert.equal(count(f,'versionStatus'),reads);assert.equal(f.m.timers.has('version'),false);
  f.m.setVisible(true);await f.m.pollVersions();assert.ok(count(f,'versionStatus')>reads);f.m.close();assert.equal(f.m.timers.has('version'),false);
});
test('tag queries match exact case-insensitive labels while plain text includes tags and combines filters',async t=>{
  const {m}=await setup(t);m.set({plugins:[{id:'one',name:'Notes',tags:['UI','Tool'],enabled:true},{id:'two',name:'Notes',tags:['UI','Adapter'],enabled:false},{id:'three',name:'UI Notes',tags:['UIish'],enabled:true},{id:'legacy',name:'UI Notes',enabled:true}]});
  m.setQuery('#ui');assert.deepEqual(m.filtered().map(p=>p.id),['one','two']);
  m.setQuery('#UI notes #tool');assert.deepEqual(m.filtered().map(p=>p.id),['one']);
  m.setQuery('adapter');assert.deepEqual(m.filtered().map(p=>p.id),['two']);
  m.setFilter('enabled');assert.deepEqual(m.filtered(),[]);
  m.setFilter('disabled');assert.deepEqual(m.filtered().map(p=>p.id),['two']);
  m.setFilter('all');m.setQuery('ui');assert.equal(m.filtered().length,4);
});
test('settings persist through page changes and a lost save response is resolved by reading, never repeating',async t=>{
  const f=await setup(t);await f.m.settingsPage();f.overrides.set('saveSettings',async args=>{await f.demo.request(null,'saveSettings',args);throw Error('lost reply');});
  await f.m.saveSettings({localSourceAutoReload:true});assert.equal(count(f,'saveSettings'),1);assert.equal(f.m.state.settings.effective.localSourceAutoReload,true);assert.equal(f.m.state.settingsUncertain,false);assert.equal(f.m.state.settingsError,'');
  await f.m.pluginsPage();await f.m.settingsPage();assert.equal(f.m.state.settings.effective.localSourceAutoReload,true);
});
test('a settings conflict refreshes authoritative values without writing against a new revision',async t=>{
  const f=await setup(t);await f.m.settingsPage();f.demo.state.settingsRevision++;await f.m.saveSettings({localSourceAutoReload:true});assert.equal(count(f,'saveSettings'),1);assert.equal(f.m.state.settings.effective.localSourceAutoReload,false);assert.match(f.m.state.settingsError,/another window/);
});
test('pending settings saves cannot be repeated after leaving and returning',async t=>{
  const f=await setup(t),reply=deferred();await f.m.settingsPage();f.overrides.set('saveSettings',()=>reply.promise);const save=f.m.saveSettings({localSourceAutoReload:true});await f.m.pluginsPage();await f.m.settingsPage();assert.equal(f.m.state.settingsBusy,true);
  await f.m.saveSettings({localSourceAutoReload:true});assert.equal(count(f,'saveSettings'),1);
  reply.resolve(await f.demo.request(null,'saveSettings',f.calls.find(c=>c.method==='saveSettings').args));await save;await Promise.resolve();assert.equal(f.m.state.settings.effective.localSourceAutoReload,true);
});
