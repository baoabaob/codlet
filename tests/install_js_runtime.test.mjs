import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import {createHash} from 'node:crypto';
import {execFileSync} from 'node:child_process';
import {fileURLToPath} from 'node:url';
const hash=bytes=>createHash('sha256').update(bytes).digest('hex');
function archive(files){
  const body=[],directory=[];let offset=0;
  for(const [name,bytes]of files){
    const filename=Buffer.from(name);let crc=0xffffffff;
    for(const byte of bytes){crc^=byte;for(let bit=0;bit<8;bit++)crc=(crc>>>1)^((crc&1)?0xedb88320:0);}crc=(crc^0xffffffff)>>>0;
    const local=Buffer.alloc(30);local.writeUInt32LE(0x04034b50);local.writeUInt16LE(20,4);local.writeUInt32LE(crc,14);local.writeUInt32LE(bytes.length,18);local.writeUInt32LE(bytes.length,22);local.writeUInt16LE(filename.length,26);
    body.push(local,filename,bytes);
    const entry=Buffer.alloc(46);entry.writeUInt32LE(0x02014b50);entry.writeUInt16LE(20,4);entry.writeUInt16LE(20,6);entry.writeUInt32LE(crc,16);entry.writeUInt32LE(bytes.length,20);entry.writeUInt32LE(bytes.length,24);entry.writeUInt16LE(filename.length,28);entry.writeUInt32LE(offset,42);
    directory.push(entry,filename);offset+=local.length+filename.length+bytes.length;
  }
  const central=Buffer.concat(directory),end=Buffer.alloc(22);end.writeUInt32LE(0x06054b50);end.writeUInt16LE(files.length,8);end.writeUInt16LE(files.length,10);end.writeUInt32LE(central.length,12);end.writeUInt32LE(offset,16);
  return Buffer.concat([...body,central,end]);
}
test('Windows runtime staging publishes complete verified directories and preserves partial or linked destinations',{skip:process.platform!=='win32'},()=>{
  const temporary=fs.realpathSync.native(os.tmpdir()),root=fs.mkdtempSync(path.join(temporary,'codlet-runtime-stage-'));
  const scripts=path.join(root,'scripts'),pins=path.join(root,'runtime');fs.mkdirSync(scripts);fs.mkdirSync(pins);
  const script=path.join(scripts,'Install-JsRuntime.ps1');fs.copyFileSync(fileURLToPath(new URL('../scripts/Install-JsRuntime.ps1',import.meta.url)),script);
  const version='0.0.0-fixture',name=`node-v${version}-win-x64`,node=Buffer.from('owned synthetic node'),license=Buffer.from('owned synthetic license');
  const zip=path.join(root,'fixture.zip');fs.writeFileSync(zip,archive([[`${name}/node.exe`,node],[`${name}/LICENSE`,license]]));
  const pin={version,platforms:{'win-x64':{archiveSha256:hash(fs.readFileSync(zip)),executableSha256:hash(node),licenseSha256:hash(license)}}};
  const savePin=()=>fs.writeFileSync(path.join(pins,'node-runtime.json'),JSON.stringify(pin));savePin();
  const invoke=destination=>execFileSync('powershell.exe',['-NoLogo','-NoProfile','-NonInteractive','-ExecutionPolicy','Bypass','-File',script,'-Destination',destination,'-Platform','win-x64','-ArchivePath',zip],{encoding:'utf8',windowsHide:true,timeout:30000,stdio:'pipe'});
  let junction;
  try{
    const destination=path.join(root,'Codlet 中文 fixture'),runtime=path.join(destination,'runtime',name);
    pin.platforms['win-x64'].licenseSha256='f'.repeat(64);savePin();assert.throws(()=>invoke(destination));
    assert.equal(fs.existsSync(runtime),false);assert.deepEqual(fs.readdirSync(path.dirname(runtime)),[]);
    pin.platforms['win-x64'].licenseSha256=hash(license);savePin();invoke(destination);
    assert.deepEqual(fs.readFileSync(path.join(runtime,'node.exe')),node);assert.deepEqual(fs.readFileSync(path.join(runtime,'LICENSE')),license);
    assert.deepEqual(fs.readdirSync(path.dirname(runtime)),[name]);const before=fs.statSync(path.join(runtime,'node.exe')).mtimeMs;invoke(destination);assert.equal(fs.statSync(path.join(runtime,'node.exe')).mtimeMs,before);
    fs.unlinkSync(path.join(runtime,'LICENSE'));assert.throws(()=>invoke(destination));assert.deepEqual(fs.readFileSync(path.join(runtime,'node.exe')),node);assert.equal(fs.existsSync(path.join(runtime,'LICENSE')),false);
    const linked=path.join(root,'linked'),outside=path.join(root,'outside');fs.mkdirSync(linked);fs.mkdirSync(outside);junction=path.join(linked,'runtime');fs.symlinkSync(outside,junction,'junction');
    assert.throws(()=>invoke(linked));assert.deepEqual(fs.readdirSync(outside),[]);
  }finally{
    if(junction&&fs.existsSync(junction))fs.unlinkSync(junction);
    const relative=path.relative(temporary,root);assert.ok(relative&&!path.isAbsolute(relative)&&!relative.startsWith('..')&&!relative.includes(path.sep));assert.equal(fs.lstatSync(root).isSymbolicLink(),false);fs.rmSync(root,{recursive:true});
  }
});
