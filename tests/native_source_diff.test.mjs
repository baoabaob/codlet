import test from 'node:test';
import assert from 'node:assert/strict';
import {compareNativeSources, applySourceReviews, proposeWorkspaceLookupPatch} from '../scripts/lib/native-source-diff.mjs';

function analysis(file,local='old',overrides={}){
  const candidate={file,binding:'binding:1',local,exports:['public'],sha256:'file-sha',normalizedHash:'shape',interfaceHash:'api',dependencies:[],start:{offset:10,line:1,column:11},end:{offset:20,line:1,column:21},...overrides};
  return {identity:{packageVersion:file},snapshot:file,snapshotSha256:file+'-snapshot',structures:[],
    roles:{composerScope:{status:'located',label:'composer scope',capabilities:['composer'],candidates:[candidate]}}};
}

test('comparison separates relocated bindings, changed interfaces and unresolved bodies',()=>{
  const previous=analysis('app-shared-old.js');
  assert.equal(compareNativeSources(previous,analysis('app-initial-new.js','renamed')).changes[0].classification,'module-relocation');
  assert.equal(compareNativeSources(previous,analysis('app-shared-new.js','renamed')).changes[0].classification,'mechanical-rename');
  assert.equal(compareNativeSources(previous,analysis('app-shared-new.js','renamed',{normalizedHash:'other',interfaceHash:'new-api'})).changes[0].classification,'interface-change');
  assert.equal(compareNativeSources(previous,analysis('app-shared-new.js','renamed',{normalizedHash:'other'})).changes[0].classification,'unresolved');
});

test('missing baseline and unproven external relationships cannot produce a preserved classification',()=>{
  const previous=analysis('app-shared-old.js','old',{dependencies:[{resolved:'external-old'}]});
  const current=analysis('app-shared-new.js','renamed',{dependencies:[{resolved:'external-new'}]});
  assert.equal(compareNativeSources(previous,current).changes[0].classification,'unresolved');
  previous.roles.composerScope={status:'not-located',candidates:[],capabilities:['composer']};
  const change=compareNativeSources(previous,current).changes[0];
  assert.equal(change.classification,'unresolved');assert.equal(change.automaticPatch,false);
  assert.match(change.reasons[0],/missing source is not evidence/);
});

test('source reviews require both snapshot and declaration identities and never claim live acceptance',()=>{
  const before=analysis('app-shared-old.js'),after=analysis('app-initial-new.js','next',{normalizedHash:'changed'});
  const report=compareNativeSources(before,after);
  const review={schema:1,previousSnapshotSha256:report.previous.sha256,currentSnapshotSha256:report.current.sha256,
    decisions:[{role:'composerScope',classification:'behavior-change',previous:report.changes[0].previous,current:report.changes[0].current,
      observation:'A reviewed branch now prefers an explicit key.',coreImpact:'Retain Native identity lookup.'}]};
  assert.throws(()=>applySourceReviews(structuredClone(report),{...review,currentSnapshotSha256:'stale'}),/identity mismatch/);
  const stale=structuredClone(review);stale.decisions[0].current.sha256='wrong';
  assert.throws(()=>applySourceReviews(structuredClone(report),stale),/declaration identity mismatch/);
  const changed=applySourceReviews(report,review);
  assert.equal(changed.changes[0].classification,'behavior-change');
  assert.equal(changed.changes[0].automaticPatch,false);
  assert.equal(changed.capabilities.composer.sourceReviewRequired,false);
  assert.equal(changed.capabilities.composer.live,'not-verified');
});

test('lookup proposals edit only the imported resolver binding and preserve predicates',()=>{
  const source=`import { uniqueExport, uniqueModuleExport, other } from '../host-discovery.js';
const native={modules: moduleNamespaces};
const found=uniqueExport(native.shared,x=>x.brand==='scope','composer scope');
function local(uniqueExport){return uniqueExport(native.shared,x=>x,'composer scope')}
`;
  const result=proposeWorkspaceLookupPatch(source,analysis('app-shared-new.js'));
  assert.match(result.candidate,/found=uniqueModuleExport\(native.modules,x=>x.brand==='scope'/);
  assert.match(result.candidate,/return uniqueExport\(native.shared,x=>x/);
  assert.equal(result.edits.length,2);assert.doesNotMatch(result.patch,/X:\//);
});
