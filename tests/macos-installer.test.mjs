import test, {afterEach} from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import {initialize} from '../scripts/macos/initialize.mjs';
const root=path.resolve(import.meta.dirname,'..');
const fixtures=[];
afterEach(()=>{
  const parent=path.resolve(root,'.codlet-artifacts/online-bootstrap/mac-fixtures');
  for(const home of fixtures.splice(0)){
    assert.equal(path.dirname(path.resolve(home)),parent);
    assert.ok(!fs.lstatSync(home).isSymbolicLink());
    fs.rmSync(home,{recursive:true});
  }
});
function fixture(hooks={}) {
  const parent=path.join(root,'.codlet-artifacts/online-bootstrap/mac-fixtures');fs.mkdirSync(parent,{recursive:true});
  const home=fs.mkdtempSync(path.join(parent,'用户 case-')),appRoot=path.join(home,'app');fs.mkdirSync(appRoot);
  fixtures.push(home);
  const catalog=JSON.parse(fs.readFileSync(path.join(root,'scripts/distribution/official-plugins.json')));
  if(hooks.seed)catalog.bundledCatalog='optional-plugins/catalog.json';
  fs.writeFileSync(path.join(appRoot,'official-plugins.json'),JSON.stringify(catalog));
  const calls=[],registered=[];
  const invoke=args=>{
    calls.push(args);
    if(args[1]==='list')return {plugins:registered};
    if(args[1]==='seed')return hooks.seed(args,registered);
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
test('GUI downloads only the current consumer release while Core supplies its SDK',()=>{
 const f=fixture();f.run(['codlet-gui']);assert.deepEqual(f.registered.map(p=>p.id),['codlet-gui']);
 assert.ok(f.calls.filter(a=>a[2]==='releases').every(a=>a[3].endsWith('/releases/latest')));
 assert.equal(f.state().decided['codlet-gui'].version,'7.8.9');assert.equal(f.state().decided['codlet-gui'].source,'github');
 assert.ok(!f.calls.some(a=>a.includes('seed')));
});
test('legacy adapter choices are ignored and preserve installed, disabled author records without downloading',()=>{
 const f=fixture();f.registered.push({id:'codex.ui.adapter',enabled:false,source:'local',manifest:{version:'99.0.0'}});
 f.run(['codex.ui.adapter','codex.desktop.adapter']);assert.equal(f.calls.length,0);assert.equal(f.registered[0].enabled,false);assert.equal(f.registered[0].manifest.version,'99.0.0');
});
test('Core-only setup neither downloads nor requires a CLI operation',()=>{
 const f=fixture();f.run([]);assert.equal(f.calls.length,0);assert.ok(Object.values(f.state().decided).every(d=>!d.selected));
});
test('permission additions require consent even when selecting an official download',()=>{
 const f=fixture({preview:p=>p.manifest.permissions=[...p.manifest.permissions,'core.events']});
 assert.throws(()=>f.run(['codlet-gui']),/明确批准/);assert.equal(f.registered.length,0);
 f.run(['codlet-gui'],{approvedPermissions:['core.events']});assert.ok(f.calls.find(a=>a[2]==='install').includes('core.events'));
});
test('downloaded identity and digest are checked before any install',()=>{
 for(const change of [p=>p.source.ownerId++,p=>p.source.repositoryId++,p=>p.source.repositoryUrl+='-other',p=>p.manifest.id='other',p=>p.manifest.version='0.0.1',p=>p.source.upstreamDigestVerified=false]){
  const f=fixture({preview:change});assert.throws(()=>f.run(['codlet-gui']),/identity or download digest mismatch/);assert.equal(f.registered.length,0);
 }
});
test('a transient read retries once; permanent failure remains retryable without an installed marker',()=>{
 let failures=1;const f=fixture({releases:()=>{if(failures-->0)throw Error('github_network');}});f.run(['codlet-gui']);assert.equal(f.calls.filter(a=>a[2]==='releases').length,2);
 const broken=fixture({releases:()=>{throw Error('github_timeout');}});assert.throws(()=>broken.run(['codlet-gui']),/github_timeout/);
 assert.equal(broken.calls.filter(a=>a[2]==='releases').length,2);assert.equal(broken.state().decided['codlet-gui'].result,'pending');
});
test('uncertain install is not replayed if its registration is present when retried',()=>{
 const f=fixture({install:(a,registered)=>{registered.push({id:path.basename(a[3]),source:'github'});throw Error('result lost');}});
 assert.throws(()=>f.run(['codlet-gui']),/result lost/);f.run(['codlet-gui']);assert.equal(f.calls.filter(a=>a[2]==='install').length,1);
});
test('an existing disabled preference is passed through the Core preview',()=>{
 const f=fixture({preview:p=>p.existingEnabled=false});f.run(['codlet-gui']);assert.ok(!f.calls.find(a=>a[2]==='install').includes('--enable'));
});
test('unknown selections fail before any CLI operation',()=>{
 const f=fixture();assert.throws(()=>f.run(['unknown']),/unavailable/);assert.equal(f.calls.length,0);
});
test('a user can decline a failed pending download and finish Core-only setup',()=>{
 const f=fixture({releases:()=>{throw Error('release unavailable');}});
 assert.throws(()=>f.run(['codlet-gui']),/release unavailable/);
 f.run([]);assert.equal(f.state().decided['codlet-gui'].result,'declined');
});
test('a failed consumer download retains its selection while old adapter choices are ignored',()=>{
 const f=fixture({releases:()=>{throw Error('release unavailable');}});
 assert.throws(()=>f.run(['codlet-gui','codex.desktop.adapter']),/release unavailable/);
 assert.deepEqual(Object.keys(f.state().decided).sort(),['codlet-gui']);
 assert.ok(Object.values(f.state().decided).every(d=>d.result==='pending'));
});
test('old persisted adapter download decisions remain on disk without becoming downloads',()=>{
 const f=fixture();const legacy={schema:1,decided:{'codex.ui.adapter':{selected:true,result:'pending'},'codex.desktop.adapter':{selected:false,result:'existing'}}};
 fs.writeFileSync(path.join(f.home,'macos-setup.json'),JSON.stringify(legacy));
 f.run(['codex.ui.adapter','codex.desktop.adapter']);assert.equal(f.calls.length,0);
 assert.deepEqual(f.state().decided['codex.ui.adapter'],legacy.decided['codex.ui.adapter']);
 assert.deepEqual(f.state().decided['codex.desktop.adapter'],legacy.decided['codex.desktop.adapter']);
});
test('bundled GUI uses Core preview and transaction without a release download',()=>{
 const f=fixture({seed:(args,registered)=>{
  if(args[2]==='preview')return {preview:'reviewed-token',addedPermissions:['ui.dom','runtime.manage']};
  assert.deepEqual(args.slice(0,3),['plugin','seed','install']);
  assert.equal(args[args.indexOf('--preview')+1],'reviewed-token');
  assert.ok(args.includes('runtime.manage'));
  registered.push({id:'codlet-gui',enabled:true});return {version:'1.0.0-rc.3'};
 }});
 f.run(['codlet-gui']);assert.equal(f.registered[0].enabled,true);
 assert.equal(f.state().decided['codlet-gui'].source,'official-installer');
 assert.ok(!f.calls.some(args=>args[1]==='github'));
});
test('bundled GUI respects a current newer version and a custom disabled installation',()=>{
 for(const custom of [false,true]){
  const f=fixture({seed:args=>{assert.equal(args[2],'preview');if(custom)throw Error('official_seed_source_changed');return {outcome:'current',version:'9.0.0',source:'github'};}});
  f.registered.push({id:'codlet-gui',enabled:false});f.run(['codlet-gui']);
  assert.equal(f.registered[0].enabled,false);assert.equal(f.state().decided['codlet-gui'].result,'existing');
  assert.ok(!f.calls.some(args=>args[2]==='install'));
 }
});
test('bundled GUI checks added permissions and does not retry an uncertain transaction',()=>{
 let installed=false;
 const f=fixture({seed:(args,registered)=>{
  if(args[2]==='preview')return installed?{outcome:'current',version:'1.0.0'}:{preview:'token',addedPermissions:['core.events']};
  installed=true;registered.push({id:'codlet-gui'});throw Error('result lost');
 }});
 assert.throws(()=>f.run(['codlet-gui']),/明确批准/);
 assert.throws(()=>f.run(['codlet-gui'],{approvedPermissions:['core.events']}),/result lost/);
 f.run(['codlet-gui']);assert.equal(f.calls.filter(args=>args[2]==='install').length,1);
});
