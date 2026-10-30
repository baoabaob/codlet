import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import os from 'node:os';
import {spawnSync} from 'node:child_process';
import {createHash} from 'node:crypto';
import {inspectOnlineBase,residentFingerprint} from '../scripts/inspect-online-base.mjs';
import {onlineCoreMetadata} from '../scripts/prepare-online-core.mjs';
import {analyzeInstallTiming} from '../scripts/analyze-install-timing.mjs';

const repository=path.resolve(import.meta.dirname,'..'),sha=bytes=>createHash('sha256').update(bytes).digest('hex');
function fixture(t){
  const root=fs.mkdtempSync(path.join(os.tmpdir(),'codlet-online-release-'));
  t.after(()=>{assert.equal(path.dirname(root),path.resolve(os.tmpdir()));assert.equal(fs.lstatSync(root).isSymbolicLink(),false);fs.rmSync(root,{recursive:true});});
  const base=path.join(root,'base'),build=path.join(root,'build');
  for(const item of [base,build])fs.mkdirSync(path.join(item,'runtime/core-modules'),{recursive:true});
  const bridge=Buffer.from('/* exact resident bridge */'),bootstrap=Buffer.from('/* exact resident bootstrap */');
  fs.writeFileSync(path.join(build,'runtime/client-bridge-bundle.cjs'),bridge);fs.writeFileSync(path.join(build,'runtime/client-bridge-bootstrap.cjs'),bootstrap);
  fs.writeFileSync(path.join(build,'runtime/core-modules/client-source.cjs'),'module.exports={handoffVersion:1};');
  fs.writeFileSync(path.join(build,'runtime/core-modules/core-ui-provider.cjs'),'module.exports={activate(){}};');
  const header=Buffer.alloc(128);header.write('MZ');header.writeUInt32LE(64,60);header.write('PE\0\0',64,'binary');header.writeUInt16LE(0x8664,68);
  fs.writeFileSync(path.join(base,'codlet.exe'),Buffer.concat([header,bridge,bootstrap]));
  fs.writeFileSync(path.join(base,'runtime/node-runtime.json'),JSON.stringify({schema:1,version:'24.21.0',mode:'managed',platforms:{'win-x64':{executableSha256:'a'.repeat(64),licenseSha256:'b'.repeat(64)}}}));
  const files=['codlet.exe','runtime/node-runtime.json'].map(relative=>{const bytes=fs.readFileSync(path.join(base,relative));return {path:relative,bytes:bytes.length,sha256:sha(bytes)};});
  fs.writeFileSync(path.join(base,'distribution-manifest.json'),JSON.stringify({schema:1,kind:'codlet-msi-distribution',version:'1.0.0-rc.8',platform:'win-x64',sourceCommit:'c'.repeat(40),files}));
  return {root,base,build,files};
}
test('online base inspection binds the recorded resident files and embedded bridge',t=>{
  const {base,build,files}=fixture(t),report=inspectOnlineBase(base,build);
  assert.equal(report.staticCompatible,true);assert.equal(report.installerOwned,true);assert.equal(report.runtimePreflightRequired,true);
  assert.equal(report.residentSha256,residentFingerprint(files.toReversed()));
  fs.writeFileSync(path.join(build,'runtime/client-bridge-bootstrap.cjs'),'/* changed bootstrap */');
  assert.equal(inspectOnlineBase(base,build).staticCompatible,false);
  fs.appendFileSync(path.join(base,'codlet.exe'),'changed');
  assert.throws(()=>inspectOnlineBase(base,build),/differs from distribution/);
});
test('partial module metadata accepts only unique fixed Core module identities',async t=>{
  const {build}=fixture(t);
  const selected=await onlineCoreMetadata(build,{moduleIds:['core-ui-provider']});
  assert.deepEqual(selected.modules,[{id:'core-ui-provider',path:'runtime/core-modules/core-ui-provider.cjs'}]);
  await assert.rejects(onlineCoreMetadata(build,{moduleIds:['core-ui-provider','core-ui-provider']}),/duplicate/);
  await assert.rejects(onlineCoreMetadata(build,{moduleIds:['arbitrary-script']}),/Unknown/);
});
test('online builder keeps the old executable and publishes no generic legacy selector',{skip:process.platform!=='win32'},t=>{
  const {root,base,build,files}=fixture(t),output=path.join(root,'output');
  const child=spawnSync('powershell.exe',['-NoLogo','-NoProfile','-NonInteractive','-ExecutionPolicy','Bypass','-File',path.join(repository,'scripts/Build-OnlineRuntime.ps1'),'-BaseDirectory',base,'-BuildRoot',build,'-Version','1.0.0-rc.11','-Channel','preview','-ModuleIds','core-ui-provider','-OutputDirectory',output],{windowsHide:true,encoding:'utf8'});
  assert.equal(child.status,0,child.stdout+child.stderr);
  const receipt=JSON.parse(fs.readFileSync(path.join(output,'online-build.json'),'utf8'));
  const manifest=JSON.parse(fs.readFileSync(path.join(output,'runtime-update-manifest.json'),'utf8'));
  assert.equal(receipt.residentSha256,residentFingerprint(files));
  for(const file of files)assert.deepEqual(manifest.files.find(item=>item.path===file.path),file);
  assert.deepEqual(manifest.online.modules,[{id:'core-ui-provider',path:'runtime/core-modules/core-ui-provider.cjs'}]);
  assert.equal(fs.existsSync(path.join(output,'codlet-update-preview.json')),false);
  assert.equal(sha(fs.readFileSync(path.join(output,receipt.archive))),receipt.sha256);
});
test('source-only builder and release validation retain residents without selecting renderer or Host modules',{skip:process.platform!=='win32'},t=>{
  const {root,base,build,files}=fixture(t),output=path.join(root,'source-only');
  const arguments_=['-NoLogo','-NoProfile','-NonInteractive','-ExecutionPolicy','Bypass','-File',path.join(repository,'scripts/Build-OnlineRuntime.ps1'),'-BaseDirectory',base,'-BuildRoot',build,'-Version','1.0.0-rc.21','-Channel','preview','-SourceOnly','-OutputDirectory',output];
  const built=spawnSync('powershell.exe',arguments_,{windowsHide:true,encoding:'utf8'});
  assert.equal(built.status,0,built.stdout+built.stderr);
  const receipt=JSON.parse(fs.readFileSync(path.join(output,'online-build.json'),'utf8'));
  const manifest=JSON.parse(fs.readFileSync(path.join(output,'runtime-update-manifest.json'),'utf8'));
  assert.deepEqual(receipt.components,['runtime/core-modules/client-source.cjs']);
  assert.equal(receipt.residentSha256,residentFingerprint(files));
  assert.equal(Object.hasOwn(manifest.online,'modules'),false);
  assert.equal(Object.hasOwn(manifest.online,'moduleAbi'),false);
  assert.deepEqual(manifest.files.map(file=>file.path),['codlet.exe','runtime/core-modules/client-source.cjs','runtime/node-runtime.json']);
  for(const file of files)assert.deepEqual(manifest.files.find(item=>item.path===file.path),file);
  assert.equal(fs.existsSync(path.join(output,'codlet-update-preview.json')),false);
  const validation=path.join(root,'validate-source-only.ps1');
  fs.writeFileSync(validation,`param([string]$Publisher,[string]$Archive,[string]$Resident)
. $Publisher
Assert-WindowsUpdateZip $Archive '1.0.0-rc.21' -ResidentSha256 $Resident
$rejected=$false
try { Assert-WindowsUpdateZip $Archive '1.0.0-rc.21' -ResidentSha256 ('f'*64) } catch { $rejected=$_.Exception.Message -like '*resident files differ*' }
if(-not $rejected){throw 'A source-only payload accepted the wrong resident selector'}
foreach($mode in @('unsupported-abi','empty-modules')){
  $copy=$Archive+'.'+$mode+'.zip';[IO.File]::Copy($Archive,$copy,$false)
  $zip=[IO.Compression.ZipFile]::Open($copy,[IO.Compression.ZipArchiveMode]::Update)
  try {
    $entry=$zip.GetEntry('runtime-update-manifest.json');$reader=[IO.StreamReader]::new($entry.Open())
    try {$manifest=$reader.ReadToEnd()|ConvertFrom-Json} finally {$reader.Dispose()}
    $entry.Delete();$manifest.online|Add-Member -NotePropertyName moduleAbi -NotePropertyValue $(if($mode -eq 'unsupported-abi'){2}else{1})
    if($mode -eq 'empty-modules'){$manifest.online|Add-Member -NotePropertyName modules -NotePropertyValue @()}
    $writer=[IO.StreamWriter]::new($zip.CreateEntry('runtime-update-manifest.json').Open())
    try {$writer.Write(($manifest|ConvertTo-Json -Depth 12))} finally {$writer.Dispose()}
  } finally {$zip.Dispose()}
  $rejected=$false
  try {Assert-WindowsUpdateZip $copy '1.0.0-rc.21' -ResidentSha256 $Resident} catch {$rejected=$_.Exception.Message -like '*Invalid online*'}
  if(-not $rejected){throw ('A source-only payload accepted '+$mode)}
}
`);
  const checked=spawnSync('powershell.exe',['-NoLogo','-NoProfile','-NonInteractive','-ExecutionPolicy','Bypass','-File',validation,'-Publisher',path.join(repository,'scripts/Publish-Release.ps1'),'-Archive',path.join(output,receipt.archive),'-Resident',receipt.residentSha256],{windowsHide:true,encoding:'utf8'});
  assert.equal(checked.status,0,checked.stdout+checked.stderr);
  const refused=spawnSync('powershell.exe',[...arguments_,'-ModuleIds','core-ui-provider'],{windowsHide:true,encoding:'utf8'});
  assert.notEqual(refused.status,0);
  assert.match(refused.stdout+refused.stderr,/SourceOnly cannot be combined with ModuleIds/);
});
test('MSI timing reports preserve cancellation and distinguish action intervals from transaction duration',()=>{
  const values=[['start','setup',0],['start','msi-transaction',5],['action','RemoveExistingProducts',8],['action','InstallFiles',13],['request','cancel',15],['end','msi-transaction',20,1602],['end','setup',22,1602]].map(([event,stage,elapsedMs,code])=>({schema:1,event,stage,elapsedMs,...(code===undefined?{}:{code})}));
  const report=analyzeInstallTiming(values.map(value=>JSON.stringify(value)).join('\n'));
  assert.equal(report.exitCode,1602);assert.equal(report.totalMs,22);assert.equal(report.spans.find(item=>item.stage==='msi-transaction').durationMs,15);
  assert.deepEqual(report.actionIntervalTotalsMs,{RemoveExistingProducts:5,InstallFiles:7});
  assert.throws(()=>analyzeInstallTiming(values.toReversed().map(value=>JSON.stringify(value)).join('\n')),/non-monotonic/);
});
