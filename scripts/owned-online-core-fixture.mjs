// Development-only builder/publisher for the desktop-acceptance lab fixture.
// Build never publishes the descriptor. The owner invokes publish after it has
// confirmed that its local stream is running.
import fs from 'node:fs';
import path from 'node:path';
import {createHash,randomUUID} from 'node:crypto';
import {spawnSync} from 'node:child_process';
import {captureProcessIdentity} from './runtime-update-helper.mjs';
import {onlineCoreMetadata,coreModuleIds} from './prepare-online-core.mjs';
import {stampFixtureModule} from './fixture-module-evidence.mjs';
const repository=path.resolve(import.meta.dirname,'..');
const digest=bytes=>createHash('sha256').update(bytes).digest('hex');
const key=file=>path.resolve(file).replace(/^\\\\\?\\/,'').toLowerCase();
const inside=(file,root)=>key(file).startsWith(key(root)+path.sep);
function plain(file,directory=false){
  const metadata=fs.lstatSync(file);
  if(metadata.isSymbolicLink()||(directory?!metadata.isDirectory():!metadata.isFile()||metadata.nlink!==1)||key(fs.realpathSync.native(file))!==key(file))throw Error('Fixture path is redirected or linked: '+file);
  return metadata;
}
function ancestry(file){for(let current=path.dirname(path.resolve(file));;current=path.dirname(current)){if(fs.existsSync(current))plain(current,true);if(path.dirname(current)===current)break;}}
function read(file,limit){ancestry(file);const before=plain(file);if(before.size>limit)throw Error('Fixture file exceeds its limit');const bytes=fs.readFileSync(file),after=plain(file);if(before.size!==bytes.length||before.mtimeMs!==after.mtimeMs)throw Error('Fixture file changed');return bytes;}
function fileRecord(root,relative){const bytes=read(path.join(root,relative),512*1024*1024);return {path:relative,bytes:bytes.length,sha256:digest(bytes)};}
function residentPaths(install){
  const pin=JSON.parse(read(path.join(install,'runtime/node-runtime.json'),256*1024));
  if(pin.schema!==1||typeof pin.version!=='string'||!/^[0-9A-Za-z.-]+$/.test(pin.version)||pin.version.includes('..'))throw Error('Invalid resident Node pin');
  const files=['codlet-lab.exe','runtime/node-runtime.json'];
  if((pin.mode??'bundled')==='bundled')files.push(`runtime/node-v${pin.version}-win-x64/node.exe`,`runtime/node-v${pin.version}-win-x64/LICENSE`);
  else if(pin.mode!=='managed')throw Error('Unknown resident Node mode');return files;
}
async function template(file){
  const value=JSON.parse(read(file,16*1024));
  const fields=['schema','kind','id','hostPid','native','labRoot','installRoot','markerSha256','version','bytes','sha256'];
  if(JSON.stringify(Object.keys(value).sort())!==JSON.stringify(fields.sort())||value.schema!==1||value.kind!=='codlet-owned-online-update-fixture'||value.id!==null||value.version!==null||value.bytes!==0||value.sha256!==null||!Number.isSafeInteger(value.hostPid)||!Number.isSafeInteger(value.native?.pid)||typeof value.native.creationTime!=='string'||!/^[a-f0-9]{64}$/.test(value.markerSha256))throw Error('Expected the current run journal fixture template');
  if(!inside(file,path.join(value.labRoot,'codlet')))throw Error('Save the returned template inside this run codlet directory');
  ancestry(value.labRoot);plain(value.labRoot,true);ancestry(value.installRoot);plain(value.installRoot,true);
  const marker=read(path.join(value.labRoot,'.codlet-lab-owner.json'),4096),parsed=JSON.parse(marker);
  if(parsed.schema_version!==1||parsed.experimental!==true||digest(marker)!==value.markerSha256)throw Error('Owned lab marker changed');
  const [host,native]=await Promise.all([captureProcessIdentity(value.hostPid),captureProcessIdentity(value.native.pid)]);
  if(!host||!native||native.creationTime!==value.native.creationTime)throw Error('The exact owned Host/Native is no longer running');
  return value;
}
export async function buildOwnedCandidate(templateFile,output){
  const authority=await template(templateFile);output=path.resolve(output);
  if(!inside(output,path.join(repository,'.codlet-artifacts'))||fs.existsSync(output))throw Error('Candidate output must be fresh under .codlet-artifacts');
  ancestry(output);fs.mkdirSync(output,{recursive:true});
  const input=path.join(output,'input');fs.mkdirSync(path.join(input,'runtime/core-modules'),{recursive:true});
  const residents=residentPaths(authority.installRoot);
  for(const relative of residents){const bytes=read(path.join(authority.installRoot,relative),512*1024*1024);const destination=path.join(input,relative);fs.mkdirSync(path.dirname(destination),{recursive:true});fs.writeFileSync(destination,bytes,{flag:'wx'});}
  const metadata=await onlineCoreMetadata(repository,{includeModules:true});
  const id=digest(randomUUID()),version='1.0.0-rc.2';
  for(const component of [{id:'client-source',path:metadata.clientSourcePath},...metadata.modules]){const source=read(path.join(repository,component.path),8*1024*1024).toString('utf8');fs.writeFileSync(path.join(input,component.path),stampFixtureModule(component.id,source,{id,version}),{flag:'wx'});}
  const metadataFile=path.join(output,'online-metadata.json');fs.writeFileSync(metadataFile,JSON.stringify(metadata,null,2)+'\n',{flag:'wx'});
  const release=path.join(output,'release');
  const built=spawnSync('powershell.exe',['-NoLogo','-NoProfile','-NonInteractive','-File',path.join(repository,'scripts/Build-RuntimeUpdate.ps1'),'-InputDirectory',input,'-PayloadProfile','isolatedClient','-Version',version,'-Channel','preview','-OutputDirectory',release,'-OnlineCoreMetadata',metadataFile],{windowsHide:true,encoding:'utf8'});
  if(built.status!==0)throw Error('Candidate builder failed: '+built.stdout+built.stderr);
  const zips=fs.readdirSync(release).filter(file=>file.endsWith('.zip'));if(zips.length!==1)throw Error('Expected exactly one candidate ZIP');
  const zipPath=path.join(release,zips[0]),zip=read(zipPath,512*1024*1024),manifest=read(path.join(release,'runtime-update-manifest.json'),256*1024);
  const receipt={schema:1,kind:'codlet-owned-online-candidate',template:authority,id,version,zipPath,bytes:zip.length,sha256:digest(zip),manifestSha256:digest(manifest),residentFiles:residents.map(relative=>fileRecord(authority.installRoot,relative)),components:metadata.modules.map(module=>module.id),descriptorPublished:false};
  fs.writeFileSync(path.join(output,'candidate-receipt.json'),JSON.stringify(receipt,null,2)+'\n',{flag:'wx'});return receipt;
}
export async function publishOwnedCandidate(templateFile,receiptFile){
  const authority=await template(templateFile);
  if(!inside(receiptFile,path.join(repository,'.codlet-artifacts')))throw Error('Candidate receipt must belong to owned artifacts');
  const receipt=JSON.parse(read(receiptFile,256*1024));
  if(receipt.schema!==1||receipt.kind!=='codlet-owned-online-candidate'||JSON.stringify(receipt.template)!==JSON.stringify(authority)||receipt.version!=='1.0.0-rc.2'||!inside(receipt.zipPath,path.dirname(receiptFile))||!/^[a-f0-9]{64}$/.test(receipt.id)||!/^[a-f0-9]{64}$/.test(receipt.sha256)||!Number.isSafeInteger(receipt.bytes)||receipt.bytes<=0||receipt.bytes>512*1024*1024||JSON.stringify(receipt.components)!==JSON.stringify(coreModuleIds)||JSON.stringify(receipt.residentFiles?.map(record=>record.path))!==JSON.stringify(residentPaths(authority.installRoot)))throw Error('Candidate receipt is from another run');
  for(const record of receipt.residentFiles){if(JSON.stringify(fileRecord(authority.installRoot,record.path))!==JSON.stringify(record))throw Error('Resident component changed since candidate preparation');}
  const zip=read(receipt.zipPath,512*1024*1024);if(zip.length!==receipt.bytes||digest(zip)!==receipt.sha256)throw Error('Candidate ZIP changed');
  const owned=path.join(authority.labRoot,'codlet'),payload=path.join(owned,'online-update-fixture.zip'),descriptor=path.join(owned,'online-update-fixture.json');
  if(fs.existsSync(path.join(owned,'online-update-source.json'))){const source=JSON.parse(read(path.join(owned,'online-update-source-receipt.json'),16*1024));if(source.kind!=='fixture-explicit-source'||source.status!=='registered'||source.id!==receipt.id)throw Error('The exact owned model source has not confirmed registration');}
  ancestry(descriptor);plain(owned,true);if(fs.existsSync(payload)||fs.existsSync(descriptor))throw Error('This owned run already has a fixture input');
  fs.writeFileSync(payload,zip,{flag:'wx'});
  const value={...authority,id:receipt.id,version:receipt.version,bytes:receipt.bytes,sha256:receipt.sha256};
  const temporary=descriptor+'.'+randomUUID()+'.tmp';fs.writeFileSync(temporary,JSON.stringify(value,null,2)+'\n',{flag:'wx'});fs.renameSync(temporary,descriptor);
  return {descriptor,payload,id:receipt.id,sha256:receipt.sha256,manifestSha256:receipt.manifestSha256};
}
export async function publishOwnedSource(templateFile,receiptFile,sourceFile){
  const authority=await template(templateFile),receipt=JSON.parse(read(receiptFile,256*1024));
  if(receipt.kind!=='codlet-owned-online-candidate'||JSON.stringify(receipt.template)!==JSON.stringify(authority)||!/^[a-f0-9]{64}$/.test(receipt.id))throw Error('Source candidate belongs to another owned run');
  if(!inside(sourceFile,path.join(authority.labRoot,'codlet')))throw Error('Save source identity inside this owned run codlet directory');
  const source=JSON.parse(read(sourceFile,16*1024));
  if(JSON.stringify(Object.keys(source).sort())!==JSON.stringify(['schema','kind','backend','fixture','upstreamBaseUrl'].sort())||source.schema!==1||source.kind!=='codlet-owned-model-source'||!/^http:\/\/127\.0\.0\.1:[0-9]{4,5}(?:\/[A-Za-z0-9_/-]*)?$/.test(source.upstreamBaseUrl))throw Error('Expected one explicit owned synthetic model source');
  const run=JSON.parse(read(path.join(authority.labRoot,'logs/manual-client.json'),256*1024));
  if(run.schema!==1||key(run.labRoot)!==key(authority.labRoot)||run.hostPid!==authority.hostPid||run.desktopPid!==authority.native.pid||String(run.desktopCreated)!==authority.native.creationTime||run.backendPid!==source.backend?.pid)throw Error('Source does not match the existing isolated launcher backend');
  const [host,backend,fixture]=await Promise.all([captureProcessIdentity(authority.hostPid),captureProcessIdentity(source.backend?.pid),captureProcessIdentity(source.fixture?.pid)]);
  if(!host||!backend||!fixture||backend.creationTime!==source.backend.creationTime||fixture.creationTime!==source.fixture.creationTime||[authority.hostPid,authority.native.pid,backend.pid].includes(fixture.pid))throw Error('Exact owned source process identity changed');
  const upstream=new URL(source.upstreamBaseUrl),backendUrl=new URL(run.endpoint);
  if(Number(upstream.port)<1024||backendUrl.protocol!=='ws:'||backendUrl.hostname!=='127.0.0.1'||!backendUrl.port||backendUrl.username||backendUrl.password||backendUrl.search||backendUrl.hash)throw Error('Source ports must be explicit literal loopback');
  for(const [port,pid] of [[upstream.port,fixture.pid],[backendUrl.port,backend.pid]]){
    const checked=spawnSync('powershell.exe',['-NoLogo','-NoProfile','-NonInteractive','-Command',"$codletRows=@(Get-NetTCPConnection -State Listen -LocalPort ([int]$env:CODLET_FIXTURE_PORT) -ErrorAction SilentlyContinue); if ($codletRows.Count -ne 1 -or $codletRows[0].LocalAddress -ne '127.0.0.1' -or $codletRows[0].OwningProcess -ne ([int]$env:CODLET_FIXTURE_PID)) { exit 1 }"],{windowsHide:true,encoding:'utf8',env:{...process.env,CODLET_FIXTURE_PORT:String(port),CODLET_FIXTURE_PID:String(pid)}});
    if(checked.status!==0)throw Error('Declared loopback listener is not owned by the exact fixture process');
  }
  const descriptor=path.join(authority.labRoot,'codlet/online-update-source.json');if(fs.existsSync(descriptor)||fs.existsSync(path.join(authority.labRoot,'codlet/online-update-source-receipt.json')))throw Error('This owned run already has a source input');
  const value={schema:1,kind:'codlet-owned-online-update-source',id:receipt.id,hostPid:authority.hostPid,hostCreationTime:host.creationTime,native:authority.native,labRoot:authority.labRoot,installRoot:authority.installRoot,markerSha256:authority.markerSha256,backend:source.backend,fixture:source.fixture,upstreamBaseUrl:source.upstreamBaseUrl};
  ancestry(descriptor);const temporary=descriptor+'.'+randomUUID()+'.tmp';fs.writeFileSync(temporary,JSON.stringify(value,null,2)+'\n',{flag:'wx'});fs.renameSync(temporary,descriptor);
  return {descriptor,receipt:path.join(authority.labRoot,'codlet/online-update-source-receipt.json'),id:receipt.id,kind:'fixture-explicit-source'};
}
if(process.argv[1]&&path.resolve(process.argv[1])===import.meta.filename){
  const [mode,templateFile,argument,...extra]=process.argv.slice(2);
  if((mode==='source'?extra.length!==1:extra.length!==0)||!templateFile||!argument||!['build','publish','source'].includes(mode))throw Error('Usage: node scripts/owned-online-core-fixture.mjs build <run/codlet/template.json> <fresh .codlet-artifacts output> | publish <template.json> <candidate-receipt.json> | source <template.json> <candidate-receipt.json> <run/codlet/source-identity.json>');
  if(process.platform!=='win32')throw Error('This owned fixture builder targets Windows');
  console.log(JSON.stringify(await(mode==='source'?publishOwnedSource(path.resolve(templateFile),path.resolve(argument),path.resolve(extra[0])):(mode==='build'?buildOwnedCandidate:publishOwnedCandidate)(path.resolve(templateFile),path.resolve(argument))),null,2));
}
