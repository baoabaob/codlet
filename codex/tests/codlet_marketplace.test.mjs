import test from 'node:test';
import assert from 'node:assert/strict';
import {Manager} from '../frontend/src/codlet/controller.js';
import {createPreviewRuntime} from '../scripts/preview-runtime.mjs';
import {deferred} from './support/ui-fixture.mjs';

async function fixture(t){
  const demo=createPreviewRuntime(),calls=[],overrides=new Map();
  const manager=new Manager({pluginId:'codlet-gui',i18n:{locale:'en'},rpc:{async request(capability,method,args){calls.push({method,args});return overrides.has(method)?overrides.get(method)(args):demo.request(capability,method,args);}}});
  t.after(()=>manager.dispose());await manager.open();manager.setVisible(false);
  return {manager,calls,overrides,demo};
}
const called=(fixture,method)=>fixture.calls.filter(call=>call.method===method);

test('market discovery filters real repository facts and leaves unreviewed compatibility unknown',async t=>{
  const f=await fixture(t),m=f.manager;await m.marketPage();
  assert.equal(m.state.market.items.length,2);
  assert.equal(m.marketFiltered()[0].fullName,'baoabaob/codlet-gui');
  assert.equal(m.state.market.items[0].totalDownloads,18);
  assert.equal(m.state.market.items[0].declarationStatus,'matched');
  assert.equal(m.marketKnownCompatibility(m.state.market.items[0]),'compatible');
  assert.equal(m.state.market.items[0].latestReleaseVerified,false);
  assert.equal(m.marketKnownCompatibility(m.state.market.items[1]),'unknown');
  m.marketSet({onlyDevice:true});assert.deepEqual(m.marketFiltered().map(item=>item.fullName),['baoabaob/codlet-gui']);m.marketSet({onlyDevice:false});
  m.marketSet({origin:'official'});assert.deepEqual(m.marketFiltered().map(item=>item.fullName),['baoabaob/codlet-gui']);
  m.marketSet({origin:'community'});assert.deepEqual(m.marketFiltered().map(item=>item.fullName),['example/codlet-notes']);
  m.marketSet({origin:'all',query:'#notes'});await m.marketSearch();assert.deepEqual(m.marketFiltered().map(item=>item.fullName),['example/codlet-notes']);
  assert.deepEqual(called(f,'githubDiscover').at(-1).args,{query:'#notes',page:1,refresh:false});
  m.marketSet({onlyDevice:true});assert.equal(m.marketFiltered().length,0);
});

test('official installer seed adopts only after exact ZIP review, explicit consent and one receipt',async t=>{
  const f=await fixture(t),m=f.manager;await m.marketPage();
  const item=m.state.market.items.find(item=>item.fullName==='baoabaob/codlet-gui');
  m.marketDetails(item);await m.reviewMarket(item);
  assert.equal(called(f,'githubPrepare').length,1);
  assert.deepEqual(called(f,'githubPrepare')[0].args,{repositoryUrl:item.repositoryUrl,releaseId:101,assetId:1001,operation:'adopt',pluginId:'codlet-gui'});
  assert.equal(m.state.preview.manifest.id,'codlet-gui');
  assert.equal(m.state.market.selected.preparedPluginId,'codlet-gui');
  assert.equal(m.state.market.selected.preparedReleasePublishedAt,item.latestRelease.publishedAt);
  assert.equal(m.state.market.selected.declarationStatus,'matched');
  assert.equal(m.importReady(),false);
  m.consent(true);assert.equal(m.importReady(),true);
  m.submitImport();assert.ok(m.state.importWarning);
  await m.confirmImport();
  assert.equal(called(f,'prepare').length,1);assert.equal(called(f,'submit').length,1);
  assert.equal(called(f,'prepare')[0].args.action,'update');
  assert.equal(called(f,'prepare')[0].args.local_import.managed,'adopt');
  assert.equal(m.state.page,'marketDetails');
});

test('market departure cancels a running discovery and ignores its late result',async t=>{
  const f=await fixture(t),m=f.manager,pending=deferred();f.overrides.set('githubDiscover',()=>pending.promise);
  const search=m.marketPage();assert.equal(m.state.market.loading,true);m.back();
  pending.resolve({jobId:'late-market',kind:'discovery',status:'completed',result:{items:[],page:1,hasMore:false}});
  await search;
  assert.equal(m.state.page,'plugins');assert.equal(m.state.market.items.length,0);
  assert.deepEqual(called(f,'cancelGitHubJob').at(-1).args,{jobId:'late-market'});
  f.overrides.delete('githubDiscover');await m.marketPage();assert.equal(m.state.market.items.length,2);
});

test('explicit Core incompatibility blocks an otherwise trusted market package',async t=>{
  const f=await fixture(t),m=f.manager;await m.marketPage();
  const item=m.state.market.items.find(item=>item.fullName==='example/codlet-notes');m.marketDetails(item);
  f.overrides.set('githubPrepare',async args=>{
    const reply=await f.demo.request(null,'githubPrepare',args);
    reply.result.deviceCompatibility.status='incompatible';return reply;
  });
  await m.reviewMarket(item);m.consent(true);
  assert.equal(m.importReady(),false);m.submitImport();assert.equal(called(f,'prepare').length,0);
});

test('a declaration that differs from the prepared ZIP is dropped while actual review remains available',async t=>{
  const f=await fixture(t),m=f.manager;await m.marketPage();const item=m.state.market.items[0];m.marketDetails(item);
  f.overrides.set('githubPrepare',async args=>{const reply=await f.demo.request(null,'githubPrepare',args);reply.result.source.sha256='d'.repeat(64);return reply;});
  await m.reviewMarket(item);
  assert.equal(m.state.market.selected.declarationStatus,'invalid');
  assert.equal(m.state.market.selected.declaredPackage,null);
  assert.equal(m.state.market.selected.totalDownloads,null);
  assert.match(m.state.importStatus,/differ from the reviewed ZIP/);
  assert.ok(m.state.preview);
  m.consent(true);assert.equal(m.importReady(),true);
});

test('an incomplete older-release count stays unknown while the latest declaration supports device filtering',async t=>{
  const f=await fixture(t),m=f.manager;
  f.overrides.set('githubDiscover',async args=>{
    const reply=await f.demo.request(null,'githubDiscover',args);
    reply.result.items[0]={...reply.result.items[0],totalDownloads:null};
    return reply;
  });
  await m.marketPage();const official=m.state.market.items[0];
  assert.equal(official.declarationStatus,'matched');assert.equal(official.totalDownloads,null);
  m.marketSet({onlyDevice:true});assert.deepEqual(m.marketFiltered().map(item=>item.fullName),[official.fullName]);
});

test('leaving market review clears its return state before a later manual import',async t=>{
  const f=await fixture(t),m=f.manager;await m.marketPage();const item=m.state.market.items[0];
  m.marketDetails(item);await m.reviewMarket(item);assert.equal(m.state.market.reviewReturn,true);
  await m.settingsPage();m.importPage();assert.equal(m.state.market.reviewReturn,false);
  assert.equal(m.state.mode,'local');assert.equal(m.state.page,'import');
});
