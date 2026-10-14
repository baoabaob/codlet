// Deterministic local ZIP; excludes fixtures, reports and test credentials.
import fs from 'node:fs';
import path from 'node:path';
import {createHash} from 'node:crypto';
import {deflateRawSync} from 'node:zlib';
const out=process.argv[2];if(!out||!path.isAbsolute(out))throw Error('Supply an absolute output directory');
const root=path.resolve(import.meta.dirname,'../../..'),source=path.join(import.meta.dirname,'consumer');
const manifest=JSON.parse(fs.readFileSync(path.join(source,'codlet.json'),'utf8'));
const files=['README.md','codlet.json','codlet-package.json','renderer.js','host.cjs'].map(name=>[name,fs.readFileSync(path.join(source,name))]);
for(const name of ['LICENSE','NOTICE'])files.push([name,fs.readFileSync(path.join(root,name))]);files.sort(([a],[b])=>a.localeCompare(b));
const crc32=data=>{let value=0xffffffff;for(const byte of data){value^=byte;for(let i=0;i<8;i++)value=(value>>>1)^((value&1)?0xedb88320:0);}return(value^0xffffffff)>>>0;};
const body=[],central=[];let offset=0;
for(const [filename,bytes]of files){
  const name=Buffer.from(filename),packed=deflateRawSync(bytes),crc=crc32(bytes);
  const header=Buffer.alloc(30);header.writeUInt32LE(0x04034b50);header.writeUInt16LE(20,4);header.writeUInt16LE(0x800,6);header.writeUInt16LE(8,8);header.writeUInt16LE(33,12);header.writeUInt32LE(crc,14);header.writeUInt32LE(packed.length,18);header.writeUInt32LE(bytes.length,22);header.writeUInt16LE(name.length,26);body.push(header,name,packed);
  const entry=Buffer.alloc(46);entry.writeUInt32LE(0x02014b50);entry.writeUInt16LE(20,4);entry.writeUInt16LE(20,6);entry.writeUInt16LE(0x800,8);entry.writeUInt16LE(8,10);entry.writeUInt16LE(33,14);entry.writeUInt32LE(crc,16);entry.writeUInt32LE(packed.length,20);entry.writeUInt32LE(bytes.length,24);entry.writeUInt16LE(name.length,28);entry.writeUInt32LE(offset,42);central.push(entry,name);offset+=header.length+name.length+packed.length;
}
const directory=Buffer.concat(central),end=Buffer.alloc(22);end.writeUInt32LE(0x06054b50);end.writeUInt16LE(files.length,8);end.writeUInt16LE(files.length,10);end.writeUInt32LE(directory.length,12);end.writeUInt32LE(offset,16);
const zip=Buffer.concat([...body,directory,end]),destination=path.join(out,`${manifest.id}-${manifest.version}.zip`);fs.mkdirSync(out,{recursive:true});fs.writeFileSync(destination,zip);
const report={path:destination,bytes:zip.length,sha256:createHash('sha256').update(zip).digest('hex'),files:files.map(([name])=>name)};
fs.writeFileSync(path.join(out,'package-report.json'),JSON.stringify(report,null,2));console.log(JSON.stringify(report));
