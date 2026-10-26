// Static extraction only: never import or execute a client module.
import fs from 'node:fs';
import path from 'node:path';
import {createHash} from 'node:crypto';
const [archive,destination,...extraEntries]=process.argv.slice(2);
if(!archive||!destination)throw Error('Usage: node scripts/extract-isolation-source.mjs <app.asar> <new-output-directory>');
const fd=fs.openSync(archive,'r');
try{
  const archiveSize=fs.fstatSync(fd).size;
  const prefix=Buffer.alloc(16);if(fs.readSync(fd,prefix,0,16,0)!==16)throw Error('Truncated ASAR header');
  const headerSize=prefix.readUInt32LE(4),jsonSize=prefix.readUInt32LE(12);
  if(prefix.readUInt32LE(0)!==4||jsonSize>16*1024*1024||jsonSize>headerSize-8||8+headerSize>archiveSize)throw Error('Unsupported ASAR header');
  const buffer=Buffer.alloc(jsonSize);if(fs.readSync(fd,buffer,0,jsonSize,16)!==jsonSize)throw Error('Truncated ASAR metadata');
  const header=JSON.parse(buffer),entries=header.files?.['.vite']?.files?.build?.files;
  if(!entries)throw Error('Missing main-process build');
  const names=Object.keys(entries).filter(name=>name.endsWith('.js'));
  if(names.some(name=>!name||/[\\/:]/.test(name)||name==='.'||name==='..'))throw Error('Invalid main-process entry name');
  if(extraEntries.some(name=>!names.includes(name)))throw Error('Additional source entry missing');
  if(names.filter(name=>name.startsWith('main-')).length!==1)throw Error('Ambiguous main bundle');
  fs.mkdirSync(destination);const manifest={schema:1,files:[]};
  for(const name of names){
    const entry=entries[name],size=entry.size,offset=Number(entry.offset);
    if(entry.unpacked||entry.link||!Number.isSafeInteger(size)||size<0||size>64*1024*1024||!Number.isSafeInteger(offset)||offset<0||8+headerSize+offset+size>archiveSize)throw Error('Unsupported main-process entry');
    const data=Buffer.alloc(size);if(fs.readSync(fd,data,0,size,8+headerSize+offset)!==size)throw Error('Truncated ASAR entry');
    const relevant=/^(main-|build-flavor-).*\.js$/.test(name)||name==='preload.js'||extraEntries.includes(name)||['CODEX_ELECTRON_USER_DATA_PATH','CODEX_APP_SERVER_WS_URL','BUILD_FLAVOR','CODEX_SPARKLE_ENABLED','codex-ipc','requestSingleInstanceLock','CODEX_SQLITE_HOME','Starting app-server connection','initialize_handshake_result'].some(needle=>data.includes(needle));
    if(!relevant)continue;
    fs.writeFileSync(path.join(destination,name),data,{flag:'wx'});
    manifest.files.push({name,bytes:size,sha256:createHash('sha256').update(data).digest('hex')});
  }
  fs.writeFileSync(path.join(destination,'manifest.json'),JSON.stringify(manifest,null,2)+'\n',{flag:'wx'});console.log(JSON.stringify(manifest));
}finally{fs.closeSync(fd);}
