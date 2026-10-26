import assert from 'node:assert/strict';
import test from 'node:test';
import {createPrivateKey,generateKeyPairSync} from 'node:crypto';
import {mkdtemp,mkdir,readFile,writeFile,rm,realpath,link,symlink,unlink,readdir} from 'node:fs/promises';
import {execFileSync} from 'node:child_process';
import {fileURLToPath} from 'node:url';
import {tmpdir} from 'node:os';
import {resolve,relative,isAbsolute,basename} from 'node:path';
import {inflateRawSync} from 'node:zlib';
import {
  createUpdateSource,createSignedUpdate,createUpdateManifest,validateUpdateManifest,
  verifyUpdate,packPlugin,
} from '../scripts/plugin-release.mjs';

const repository = 'example/plugins';
const privateKey = createPrivateKey({
  key:Buffer.concat([Buffer.from('302e020100300506032b657004220420','hex'),Buffer.alloc(32,7)]),
  format:'der',type:'pkcs8',
}).export({format:'pem',type:'pkcs8'});
function entry(id,version,archive=Buffer.alloc(100,1)) {
  return createSignedUpdate({manifest:{id,version},repository,assetName:`${id}-${version}.zip`,archive,privateKey});
}
function unzipFiles(bytes) {
  const result = new Map();
  let offset = 0;
  while (bytes.readUInt32LE(offset) === 0x04034b50) {
    const method = bytes.readUInt16LE(offset+8), size = bytes.readUInt32LE(offset+18), nameSize = bytes.readUInt16LE(offset+26), extra = bytes.readUInt16LE(offset+28);
    const name = bytes.subarray(offset+30,offset+30+nameSize).toString(), start = offset+30+nameSize+extra;
    const compressed = bytes.subarray(start,start+size);
    result.set(name,method===8?inflateRawSync(compressed):compressed);
    offset = start+size;
  }
  return result;
}

test('signed updates bind plugin, version, file size, hash, URL and publisher identity',()=>{
  const signed = entry('community.notes','1.2.0');
  assert.equal(verifyUpdate(signed,repository,signed.publicKey),signed);
  for (const edit of [
    value=>value.payload.asset.sha256='0'.repeat(64),
    value=>value.payload.asset.bytes++,
    value=>value.payload.id='other.plugin',
    value=>value.payload.asset.url='https://api.github.com/repos/example/plugins/releases/assets/1',
    value=>value.publicKey=Buffer.alloc(32,9).toString('base64'),
    value=>value.payload.extra='unrecognized',
  ]) {
    const changed = structuredClone(signed); edit(changed);
    assert.throws(()=>verifyUpdate(changed,repository,signed.publicKey));
  }
  assert.throws(()=>createUpdateSource({repository,privateKey,manifestUrl:'https://api.github.com/repos/example/plugins/contents/codlet-updates.json'}));
  assert.throws(()=>createUpdateSource({repository,privateKey,manifestUrl:'https://github.com/other/plugins/releases/latest/download/codlet-updates.json'}));
});

test('monorepo manifests preserve other community plugins and the newest stable and preview',()=>{
  let manifest = createUpdateManifest([entry('community.notes','1.0.0'),entry('community.other','3.0.0')],repository);
  manifest = createUpdateManifest([entry('community.notes','1.2.0'),entry('community.notes','2.0.0-rc.2'),entry('community.notes','2.0.0-rc.10')],repository,manifest);
  assert.deepEqual(manifest.plugins.map(item=>[item.payload.id,item.payload.version]),[
    ['community.notes','1.2.0'],['community.notes','2.0.0-rc.10'],['community.other','3.0.0'],
  ]);
  assert.throws(()=>createUpdateManifest([entry('community.notes','1.2.0',Buffer.alloc(100,2))],repository,manifest),/immutable/);
  assert.throws(()=>validateUpdateManifest({...manifest,plugins:[manifest.plugins[0],manifest.plugins[0]]},repository),/Duplicate/);
});

test('publisher ZIPs contain the public update source and all three release assets verify',async()=>{
  const temporary = await realpath(tmpdir());
  const root = await mkdtemp(resolve(temporary,'codlet-plugin-release-'));
  try {
    const source = resolve(root,'package'), output = resolve(root,'release'), key = resolve(root,'private.pem');
    await mkdir(source);
    await writeFile(key,privateKey,{mode:0o600});
    await writeFile(resolve(source,'codlet.json'),JSON.stringify({schema:1,id:'community.notes',version:'1.2.0',renderer:{entry:'entry.js',world:'isolated'},permissions:['ui.dom']}));
    await writeFile(resolve(source,'entry.js'),'module.exports={activate(){},deactivate(){}};');
    const result = await packPlugin({packageDirectory:source,repository,privateKeyPath:key,outputDirectory:output});
    assert.deepEqual(result.assets,['community.notes-1.2.0.zip','codlet-updates.json','codlet-release.json']);
    const archive = await readFile(resolve(output,result.assets[0])), contents = unzipFiles(archive);
    const configuration = JSON.parse(contents.get('codlet-update.json'));
    assert.equal(configuration.publicKey,result.publicKey);
    assert.equal(configuration.manifestUrl,'https://github.com/example/plugins/releases/latest/download/codlet-updates.json');
    assert.equal([...contents.keys()].some(name=>name.endsWith('.pem')),false);
    const feed = validateUpdateManifest(JSON.parse(await readFile(resolve(output,'codlet-updates.json'),'utf8')),repository);
    assert.equal(feed.plugins[0].payload.asset.bytes,archive.length);
    assert.equal(feed.plugins[0].payload.asset.sha256,JSON.parse(await readFile(resolve(output,'codlet-release.json'),'utf8')).asset.sha256);
    await assert.rejects(packPlugin({packageDirectory:source,repository,privateKeyPath:key,outputDirectory:output}),/empty/);
    const previewManifest=JSON.parse(await readFile(resolve(source,'codlet.json'),'utf8'));
    previewManifest.version='2.0.0-rc.1';
    await writeFile(resolve(source,'codlet.json'),JSON.stringify(previewManifest));
    await assert.rejects(packPlugin({packageDirectory:source,repository,privateKeyPath:key,outputDirectory:resolve(root,'preview')}),/fixed static feed/);
    const preview=await packPlugin({packageDirectory:source,repository,privateKeyPath:key,outputDirectory:resolve(root,'preview'),manifestUrl:'https://raw.githubusercontent.com/example/plugins/codlet-updates/codlet-updates.json'});
    assert.equal(preview.manifestUrl,'https://raw.githubusercontent.com/example/plugins/codlet-updates/codlet-updates.json');
    await writeFile(resolve(source,'private.pem'),privateKey);
    await assert.rejects(packPlugin({packageDirectory:source,repository,privateKeyPath:key,outputDirectory:resolve(root,'unsafe')}),/credentials/);
    await assert.rejects(packPlugin({packageDirectory:source,repository,privateKeyPath:resolve(source,'private.pem'),outputDirectory:resolve(root,'unsafe')}),/outside/);
  } finally {
    const part = relative(temporary,root);
    assert.ok(part&&!isAbsolute(part)&&!part.startsWith('..')&&basename(root).startsWith('codlet-plugin-release-'));
    await rm(root,{recursive:true});
  }
});

test('Node-generated signatures match the shared Rust verification fixture',async()=>{
  const fixture = JSON.parse(await readFile(new URL('./fixtures/plugin-update-manifest.json',import.meta.url),'utf8'));
  validateUpdateManifest(fixture,repository);
  assert.deepEqual(fixture,createUpdateManifest([entry('community.notes','1.2.0')],repository));
});
test('channel merge replaces only its output and rejects hard-link or directory aliases of versioned inputs',async()=>{
  const temporary=await realpath(tmpdir()),root=await mkdtemp(resolve(temporary,'codlet-channel-merge-'));
  let junction;
  try{
    const source=resolve(root,'release');await mkdir(source);
    const previous=resolve(source,'previous.json'),incoming=resolve(source,'incoming.json'),output=resolve(root,'channel.json');
    const before=JSON.stringify(createUpdateManifest([entry('community.notes','1.0.0')],repository))+'\n';
    await writeFile(previous,before);await writeFile(incoming,JSON.stringify(createUpdateManifest([entry('community.notes','1.1.0')],repository))+'\n');
    const script=fileURLToPath(new URL('../scripts/plugin-release.mjs',import.meta.url));
    const merge=destination=>execFileSync(process.execPath,[script,'merge','--incoming',incoming,'--previous',previous,'--repository',repository,'--output',destination],{encoding:'utf8',stdio:'pipe',windowsHide:true});
    await link(previous,output);assert.throws(()=>merge(output),/ordinary unlinked|versioned input/);assert.equal(await readFile(previous,'utf8'),before);await unlink(output);
    junction=resolve(root,'alias');await symlink(source,junction,process.platform==='win32'?'junction':'dir');
    assert.throws(()=>merge(resolve(junction,'previous.json')),/versioned input/);assert.equal(await readFile(previous,'utf8'),before);
    merge(output);merge(output);assert.equal(JSON.parse(await readFile(output,'utf8')).plugins[0].payload.version,'1.1.0');assert.equal(await readFile(previous,'utf8'),before);
    assert.equal((await readdir(root)).some(name=>name.endsWith('.tmp')),false);
  }finally{
    if(junction)await unlink(junction);
    const part=relative(temporary,root);assert.ok(part&&!isAbsolute(part)&&!part.startsWith('..')&&!part.includes('/')&&!part.includes('\\'));await rm(root,{recursive:true});
  }
});
