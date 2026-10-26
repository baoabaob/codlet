import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import {createRequire} from 'node:module';
const {createOfficialUpdates}=createRequire(import.meta.url)('../host/official-updates.cjs');
async function fixture(t){
  const directory=await fs.mkdtemp(path.join(os.tmpdir(),'codlet-update-target-')),cache=path.join(directory,'cache'),stage=path.join(directory,'staged-msix.json'),prepared=path.join(cache,'windows-updates','prepared.msix');
  await fs.mkdir(path.dirname(prepared),{recursive:true});await fs.writeFile(prepared,'native staged package');
  await fs.writeFile(stage,JSON.stringify({packagePath:prepared,buildVersion:'26.1025.1000',length:(await fs.stat(prepared)).size,sha256:'a'.repeat(64)}));
  const state={metadataReads:0,installs:0,ready:true,phase:'ready',release:null};
  const native={getIsUpdateReady:()=>state.ready,getStageStatePath:()=>stage,readStageState(){assert.fail('Native state reader can delete staging and must not be called');},options:{packageIdentity:'OpenAI.Codex',packagePublisher:'CN=OpenAI',nativeAddon:{getPackageLocalCachePath:()=>cache,async readPackageMetadata(){state.metadataReads++;return{packageIdentity:'OpenAI.Codex',packagePublisher:'CN=OpenAI',architecture:process.arch,packageVersion:'26.1025.1234.0'};}}}};
  class Root{updater={activeUpdater:native};getIsUpdateReady(){return state.ready;}getUpdateLifecycleState(){return state.phase;}getDownloadedUpdateAppBrand(){return null;}getSupportsAutoInstallWhenIdle(){return false;}installUpdatesIfAvailable(){state.installs++;state.ready=false;state.phase='installing';return new Promise(resolve=>state.release=resolve);}}
  const owner=new Root(),roots=[owner],modules={list:()=>[{classes:[{binding:'RenamedRoot',methods:Object.getOwnPropertyNames(Root.prototype)}],evaluate:()=>Root}],instances:()=>roots};
  const api=createOfficialUpdates({},modules);
  t.after(async()=>{api.close();assert.equal(path.dirname(path.resolve(directory)),path.resolve(os.tmpdir()));await fs.rm(directory,{recursive:true});});
  return{api,state,native,owner,roots,stage,prepared};
}
test('combined update target comes from Native package metadata, stays stable and does not invoke its updater',async t=>{
  const f=await fixture(t),first=await f.api.target();
  assert.equal(first.target.version,'26.1025.1234.0');assert.match(first.target.id,/^[a-f0-9]{64}$/);
  assert.deepEqual((await f.api.target()).target,first.target);assert.equal(f.state.metadataReads,1);assert.equal(f.state.installs,0);
  await fs.appendFile(f.prepared,'changed');assert.equal((await f.api.target()).target,null);
  await assert.rejects(f.api.install(first.target.id),{code:'official_update_target_changed'});assert.equal(f.state.installs,0);
});
test('ambiguous, foreign and Store-only targets never inherit a compatible version',async t=>{
  const f=await fixture(t);f.roots.push({...f.owner});assert.equal((await f.api.target()).target!==null,true,'objects outside the constructor contract are not owners');f.roots.pop();
  f.roots.push(f.owner.constructor?new f.owner.constructor():null);assert.equal((await f.api.target()).reason,'official_update_owner_ambiguous');f.roots.pop();
  f.owner.updater.activeUpdater={getIsUpdateReady:()=>true};assert.equal((await f.api.target()).reason,'official_update_target_unavailable');
  f.owner.updater.activeUpdater=f.native;f.native.options.packagePublisher='CN=Foreign';assert.equal((await f.api.target()).reason,'official_update_package_invalid');assert.equal(f.state.installs,0);
});
test('confirmed Native installation dispatches once and reports its actual cancellation without an elapsed-time guess',async t=>{
  const f=await fixture(t),target=(await f.api.target()).target;
  assert.equal((await f.api.install(target.id)).accepted,true);assert.equal(f.state.installs,1);
  assert.equal((await f.api.target()).installation.state,'pending');f.state.release(false);await Promise.resolve();
  assert.equal((await f.api.target()).installation.state,'cancelled');assert.equal(f.state.installs,1);
});
