import assert from 'node:assert/strict';
import test from 'node:test';
import {readFile,writeFile,mkdtemp,rm,realpath} from 'node:fs/promises';
import {resolve,dirname,relative,isAbsolute,sep,basename} from 'node:path';
import {fileURLToPath} from 'node:url';
import {execFileSync} from 'node:child_process';
import {tmpdir} from 'node:os';
import {validateConfig,safePath,hash,blobHash,prepareDistribution} from '../scripts/distribution.mjs';
const root=resolve(dirname(fileURLToPath(import.meta.url)),'..');
const config=JSON.parse(await readFile(resolve(root,'plugins.json'),'utf8'));
const clientProfiles=[...new Map(JSON.parse(await readFile(resolve(root,'compatibility/client-profiles.json'),'utf8')).builds.map(({appVersion,buildNumber,appServerVersion})=>[`${appVersion}/${buildNumber}`,{appVersion,buildNumber,appServerVersion}])).values()];
test('distribution destinations and discovery metadata are unique and cannot point at the development repository',()=>{
  assert.equal(validateConfig(structuredClone(config)).plugins.length,3);
  for(const edit of [c=>c.plugins.push(c.plugins[0]),c=>c.plugins[0].repository=c.sourceRepository,c=>c.plugins[0].repository='someone-else/plugin',c=>c.plugins[0].topics=[],c=>c.plugins[0].dependencies=['missing'],c=>c.installerPlugins=['missing'],c=>c.installerPlugins.push(c.installerPlugins[0])]){
    const copy=structuredClone(config);edit(copy);assert.throws(()=>validateConfig(copy));
  }
  for(const path of ['../secret','x/../../secret','.git/config','x\\secret','C:/secret','/secret','x//file','x/./file'])assert.throws(()=>safePath(path),path);
});
test('Git blob identity includes the exact byte length and preserves UTF-8 source bytes',()=>{
  const bytes=Buffer.from('Codlet 插件\n');
  const expected=execFileSync('git',['hash-object','--stdin'],{input:bytes,encoding:'utf8',windowsHide:true}).trim();
  assert.equal(blobHash(bytes),expected);
});
test('each source snapshot contains its own installable bundle and build closure with pinned dependencies',async()=>{
  const temporaryRoot=await realpath(tmpdir());
  const outputDirectory=await mkdtemp(resolve(temporaryRoot,'codlet-distribution-test-'));
  try{
    const createdPath=resolve(outputDirectory),createdRelative=relative(temporaryRoot,createdPath);
    assert.ok(createdRelative&&!createdRelative.startsWith('..')&&!isAbsolute(createdRelative)&&!createdRelative.includes(sep));
    assert.ok(basename(createdPath).startsWith('codlet-distribution-test-'));
    execFileSync(process.execPath,[resolve(root,'scripts/package.mjs'),'--output',outputDirectory],{cwd:root,encoding:'utf8',windowsHide:true});
    const catalog=JSON.parse(await readFile(resolve(outputDirectory,'catalog.json'),'utf8'));
    const identities=JSON.parse(await readFile(resolve(root,'compatibility/official-sources.json'),'utf8'));
    for(const pkg of catalog.packages){const identity=identities.sources.find(s=>s.pluginIds.includes(pkg.id));assert.deepEqual(pkg.updateSource,{kind:'github',repositoryUrl:`https://github.com/${identity.repository}`,repositoryId:identity.repositoryId,ownerId:identity.ownerId,assetNameTemplate:`${pkg.id}-{version}.zip`});}
    const plan=await prepareDistribution(root,{allowDirty:true,outputDirectory});
    for(const plugin of plan.plugins){
      const folder=resolve(outputDirectory,plugin.directory),paths=plugin.files.map(f=>f.path);
      for(const file of plugin.files){const bytes=await readFile(resolve(folder,file.path));assert.equal(hash(bytes),file.sha256);assert.equal(blobHash(bytes),file.gitBlob);}
      const manifest=JSON.parse(await readFile(resolve(folder,'codlet.json'),'utf8'));
      assert.equal(manifest.id,plugin.id);assert.equal(manifest.version,plugin.version);assert.ok(paths.includes(manifest.renderer.entry));
      const metadata=JSON.parse(await readFile(resolve(folder,'codlet-package.json'),'utf8'));
      assert.deepEqual(metadata.platforms,['windows-x86_64','windows-aarch64','macos-aarch64']);
      assert.deepEqual(metadata.adapters.codex.clientProfiles,clientProfiles);
      assert.equal(Object.hasOwn(metadata.adapters.codex,'testedBuilds'),false);
      assert.equal(Object.hasOwn(metadata.adapters.codex,'limitations'),false);
      assert.equal(paths.includes('codlet-release.json'),false);
      if(manifest.host){
        for(const required of [manifest.host.entry,'frontend/build-host.mjs','host/desktop-launch.cjs','host/electron-main.cjs','host/backend-spawn.cjs','host/vendor/plaintext-source-client.cjs'])assert.ok(paths.includes(required),required);
        assert((await readFile(resolve(folder,'frontend/build.mjs'),'utf8')).includes('buildDesktopHost'));
      }
      for(const required of ['frontend/build-plugin.mjs','frontend/build.mjs','frontend/package-lock.json','.codlet-distribution.json'])assert.ok(paths.includes(required));
      assert.ok(paths.every(p=>!p.includes('node_modules')&&!p.startsWith('.core-sdk')&&!p.startsWith('.git/')));
      const readme=await readFile(resolve(folder,'README.md'),'utf8');assert.ok(readme.includes(`https://github.com/${plugin.repository}`));
      assert.ok(readme.includes('Apache-2.0'));
      for(const legal of ['LICENSE','NOTICE'])assert.deepEqual(await readFile(resolve(folder,legal)),await readFile(resolve(root,legal)));
      const packageJson=JSON.parse(await readFile(resolve(folder,'frontend/package.json'),'utf8'));assert.equal(packageJson.license,'Apache-2.0');
      if(plugin.id!=='codlet-gui')assert.equal(paths.includes('frontend/src/codlet/app.jsx'),false);
      const archive=await readFile(resolve(outputDirectory,plugin.archive.path));assert.equal(hash(archive),plugin.archive.sha256);
      assert.deepEqual(Object.keys(plugin.releaseAsset).sort(),['bytes','name','path','sha256']);
      assert.equal(plugin.releaseAsset.name,'codlet-release.json');
      const declarationBytes=await readFile(resolve(outputDirectory,plugin.releaseAsset.path));
      assert.equal(declarationBytes.length,plugin.releaseAsset.bytes);assert.equal(hash(declarationBytes),plugin.releaseAsset.sha256);
      const declaration=JSON.parse(declarationBytes);
      assert.deepEqual(declaration,{schema:1,kind:'codlet-plugin-release',manifest,metadata,asset:{name:basename(plugin.archive.path),bytes:archive.length,sha256:hash(archive)}});
      assert.ok(declarationBytes.length<=16*1024);
      const packageReadme=await readFile(resolve(folder,'README.md'),'utf8');
      assert.ok(packageReadme.includes('known issues'));assert.equal(packageReadme.includes('Windows x64 Preview is tested'),false);
    }
    const releasePath=resolve(outputDirectory,plan.plugins[0].releaseAsset.path);
    const declaration=JSON.parse(await readFile(releasePath,'utf8'));
    declaration.asset.sha256='0'.repeat(64);
    await writeFile(releasePath,JSON.stringify(declaration)+'\n');
    await assert.rejects(prepareDistribution(root,{allowDirty:true,outputDirectory}),/Release declaration differs from the actual package/);
  }finally{
    const cleanupPath=resolve(outputDirectory),cleanupRelative=relative(temporaryRoot,cleanupPath);
    if(!cleanupRelative||cleanupRelative.startsWith('..')||isAbsolute(cleanupRelative)||cleanupRelative.includes(sep)||!basename(cleanupPath).startsWith('codlet-distribution-test-'))throw Error(`Refusing to clean test output outside its temporary directory: ${cleanupPath}`);
    await rm(cleanupPath,{recursive:true,force:true});
  }
});
