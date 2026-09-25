import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import {initialize} from '../scripts/macos/initialize.mjs';
const root=path.resolve(import.meta.dirname,'..');
function fixture(hooks={}) {
  const parent=path.join(root,'.codlet-artifacts/online-bootstrap/mac-fixtures');fs.mkdirSync(parent,{recursive:true});
  const home=fs.mkdtempSync(path.join(parent,'用户 case-')),appRoot=path.join(home,'app');fs.mkdirSync(appRoot);
  const catalog=JSON.parse(fs.readFileSync(path.join(root,'scripts/distribution/official-plugins.json')));
  fs.writeFileSync(path.join(appRoot,'official-plugins.json'),JSON.stringify(catalog));
  const calls=[],registered=[];
  const invoke=args=>{
    calls.push(args);
    if(args[1]==='list')return {plugins:registered};
    if(args[2]==='install'){
      hooks.install?.(args,registered);
      registered.push({id:path.basename(args[3]),source:'github',enabled:args.includes('--enable')});return {outcome:'applied'};
    }
    const pkg=catalog.plugins.find(p=>args[3]===p.repositoryUrl||args[3]===p.repositoryUrl+'/releases/latest');assert.ok(pkg);
    if(args[2]==='releases'){
      hooks.releases?.(args);
      return {releases:[{id:42,tag:'v7.8.9',prerelease:false,assets:[{id:43,name:pkg.id+'-7.8.9.zip'}]}]};
    }
    assert.equal(args[2],'preview');
    const preview={manifest:{id:pkg.id,version:'7.8.9',permissions:pkg.permissions},source:{...pkg,upstreamDigestVerified:true},existingEnabled:true,path:path.join(home,pkg.id)};
    hooks.preview?.(preview);return preview;
  };
  return {home,appRoot,calls,registered,run:(selected,options={})=>initialize(selected,{appRoot,home,invoke,...options}),state:()=>JSON.parse(fs.readFileSync(path.join(home,'macos-setup.json')))};
}
test('GUI downloads the current release and its dependency as ordinary GitHub plugins',()=>{
 const f=fixture();f.run(['codlet-gui']);assert.deepEqual(f.registered.map(p=>p.id),['codex.ui.adapter','codlet-gui']);
 assert.ok(f.calls.filter(a=>a[2]==='releases').every(a=>a[3].endsWith('/releases/latest')));
 assert.equal(f.state().decided['codlet-gui'].version,'7.8.9');assert.equal(f.state().decided['codlet-gui'].source,'github');
 assert.ok(!f.calls.some(a=>a.includes('seed')));
});
test('upgrading Core preserves installed, disabled and local author plugins without downloading',()=>{
 const f=fixture();f.registered.push({id:'codex.ui.adapter',enabled:false,source:'local',manifest:{version:'99.0.0'}});
 f.run(['codex.ui.adapter']);assert.equal(f.calls.length,1);assert.equal(f.registered[0].enabled,false);assert.equal(f.registered[0].manifest.version,'99.0.0');
});
test('Core-only setup neither downloads nor requires a CLI operation',()=>{
 const f=fixture();f.run([]);assert.equal(f.calls.length,0);assert.ok(Object.values(f.state().decided).every(d=>!d.selected));
});
test('permission additions require consent even when selecting an official download',()=>{
 const f=fixture({preview:p=>p.manifest.permissions=[...p.manifest.permissions,'core.events']});
 assert.throws(()=>f.run(['codex.ui.adapter']),/明确批准/);assert.equal(f.registered.length,0);
 f.run(['codex.ui.adapter'],{approvedPermissions:['core.events']});assert.ok(f.calls.find(a=>a[2]==='install').includes('core.events'));
});
test('downloaded identity and digest are checked before any install',()=>{
 for(const change of [p=>p.source.ownerId++,p=>p.source.repositoryId++,p=>p.source.repositoryUrl+='-other',p=>p.manifest.id='other',p=>p.manifest.version='0.0.1',p=>p.source.upstreamDigestVerified=false]){
  const f=fixture({preview:change});assert.throws(()=>f.run(['codex.ui.adapter']),/identity or download digest mismatch/);assert.equal(f.registered.length,0);
 }
});
test('a transient read retries once; permanent failure remains retryable without an installed marker',()=>{
 let failures=1;const f=fixture({releases:()=>{if(failures-->0)throw Error('github_network');}});f.run(['codex.ui.adapter']);assert.equal(f.calls.filter(a=>a[2]==='releases').length,2);
 const broken=fixture({releases:()=>{throw Error('github_timeout');}});assert.throws(()=>broken.run(['codex.ui.adapter']),/github_timeout/);
 assert.equal(broken.calls.filter(a=>a[2]==='releases').length,2);assert.equal(broken.state().decided['codex.ui.adapter'].result,'pending');
});
test('uncertain install is not replayed if its registration is present when retried',()=>{
 const f=fixture({install:(a,registered)=>{registered.push({id:path.basename(a[3]),source:'github'});throw Error('result lost');}});
 assert.throws(()=>f.run(['codex.ui.adapter']),/result lost/);f.run(['codex.ui.adapter']);assert.equal(f.calls.filter(a=>a[2]==='install').length,1);
});
test('an existing disabled preference is passed through the Core preview',()=>{
 const f=fixture({preview:p=>p.existingEnabled=false});f.run(['codex.ui.adapter']);assert.ok(!f.calls.find(a=>a[2]==='install').includes('--enable'));
});
test('unknown selections fail before any CLI operation',()=>{
 const f=fixture();assert.throws(()=>f.run(['unknown']),/unavailable/);assert.equal(f.calls.length,0);
});
test('a user can decline a failed pending download and finish Core-only setup',()=>{
 const f=fixture({releases:()=>{throw Error('release unavailable');}});
 assert.throws(()=>f.run(['codex.ui.adapter']),/release unavailable/);
 f.run([]);assert.equal(f.state().decided['codex.ui.adapter'].result,'declined');
});
