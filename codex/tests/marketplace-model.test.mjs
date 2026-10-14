import test from 'node:test';
import assert from 'node:assert/strict';
import {mkdtemp,writeFile,unlink,rmdir} from 'node:fs/promises';
import {tmpdir} from 'node:os';
import {join} from 'node:path';
import {isOfficialPlugin,officialRepository,declaredPackageFor,marketMatches,marketSort,marketAssets} from '../frontend/src/codlet/marketplace-model.js';
import {auditPortability} from '../scripts/audit-portability.mjs';
test('official identity requires the pinned repository, owner and plugin binding',()=>{
  const official={id:'codlet-gui',source:{kind:'github',repository:'baoabaob/codlet-gui',repositoryId:1379359689,ownerId:76909162}};
  assert.equal(isOfficialPlugin(official),true);
  for(const value of [{...official,source:{...official.source,kind:'local'}},{...official,id:'another-plugin'},{...official,source:{...official.source,repositoryId:999}},{...official,source:{...official.source,ownerId:999}},{id:'codlet-gui',official:true,author:'Codlet',topics:['codlet-official']},{...official,source:{...official.source,repository:'fake/codlet-gui'}}])assert.equal(isOfficialPlugin(value),false);
});
test('market sorting keeps unknown statistics last and topic queries use repository facts',()=>{
  const items=[
    {repositoryId:1,name:'Zeta',fullName:'example/zeta',topics:['codlet-plugin','notes'],latestRelease:{id:100,publishedAt:'2026-09-20',assets:[{id:1,name:'plugin.zip',size:10},{id:2,name:'other.zip',size:20}]},declarationStatus:'matched',declaredPackage:{basis:'publisher-release-declaration',releaseId:100,publishedAt:'2026-09-20',manifest:{id:'zeta',name:'Publisher Zeta',version:'1.0.0',tags:['Tool']},metadata:{platforms:['windows-x86_64'],runtimeApi:1},asset:{id:1,name:'plugin.zip',bytes:10,sha256:'a'.repeat(64),downloadCount:12},deviceCompatibility:{status:'compatible'}},totalDownloads:12},
    {repositoryId:2,name:'Alpha',fullName:'example/alpha',topics:['codlet-plugin'],latestRelease:{publishedAt:'2026-09-21',assets:[]},totalDownloads:null},
    {repositoryId:3,name:'Beta',fullName:'example/beta',topics:['codlet-plugin'],latestRelease:{publishedAt:null,assets:[]},totalDownloads:30},
  ];
  assert.deepEqual(marketSort(items).map(item=>item.name),['Zeta','Alpha','Beta']);
  assert.deepEqual(marketSort(items,'downloads').map(item=>item.name),['Beta','Zeta','Alpha']);
  assert.deepEqual(marketSort(items,'name').map(item=>item.name),['Alpha','Beta','Zeta']);
  assert.equal(marketMatches(items[0],'#notes zeta'),true);
  assert.equal(marketMatches(items[0],'Publisher Zeta'),true);
  assert.equal(marketMatches(items[0],'#tool'),false);
  assert.equal(marketMatches(items[0],'#other'),false);
  assert.deepEqual(marketAssets(items[0]).map(asset=>asset.id),[1]);
  assert.equal(declaredPackageFor(items[0])?.manifest.id,'zeta');
  assert.equal(declaredPackageFor({...items[0],declarationStatus:'invalid'}),null);
  assert.equal(officialRepository({repositoryId:1379359689,ownerId:76909162,fullName:'baoabaob/codlet-gui'})?.pluginIds[0],'codlet-gui');
  assert.equal(officialRepository({repositoryId:1379359689,ownerId:1,fullName:'baoabaob/codlet-gui'}),null);
});
test('read-only source audit distinguishes a portable candidate from direct OS and dynamic access',async t=>{
  const directory=await mkdtemp(join(tmpdir(),'codlet-portability-'));
  t.after(async()=>{
    for(const file of ['renderer.js','native.dll','codlet.json'])await unlink(join(directory,file)).catch(error=>{if(error.code!=='ENOENT')throw error;});
    await rmdir(directory);
  });
  await writeFile(join(directory,'codlet.json'),JSON.stringify({id:'dev.portable',renderer:{entry:'renderer.js'},permissions:[],requires:[{name:'codex.backend.read',api:1,scope:'target'}]}));
  await writeFile(join(directory,'renderer.js'),'module.exports={activate:context=>context.rpc.request({name:"codex.backend.read",api:1,scope:"target"},"get",null)}');
  let result=await auditPortability(directory);assert.equal(result.status,'adapter-candidate');assert.equal(result.verified,false);
  await writeFile(join(directory,'renderer.js'),'const fs=require("node:fs"); module.exports={}');
  result=await auditPortability(directory);assert.equal(result.status,'explicit-platforms-required');
  await writeFile(join(directory,'renderer.js'),'import "node:fs";');
  result=await auditPortability(directory);assert.equal(result.status,'explicit-platforms-required');
  await writeFile(join(directory,'renderer.js'),'module.exports={activate:()=>eval("some code")}');
  result=await auditPortability(directory);assert.equal(result.status,'review-required');
  await writeFile(join(directory,'native.dll'),'fixture');
  result=await auditPortability(directory);assert.equal(result.status,'explicit-platforms-required');
  await writeFile(join(directory,'renderer.js'),Buffer.alloc(2*1024*1024+1));
  await assert.rejects(auditPortability(directory),/size limit/);
});
