import fs from 'node:fs';
import path from 'node:path';
import {randomUUID} from 'node:crypto';
import {setTimeout as delay} from 'node:timers/promises';
import {pathToFileURL} from 'node:url';
export async function command(directory,action,options={},timeoutMs=20000){
  const id=randomUUID(),root=path.resolve(directory),input={id,action,options};
  const lock=path.join(root,'command-writer.lock'),pending=path.join(root,'pending-command.json');
  const owner=fs.openSync(lock,'wx');
  const temporary=path.join(root,'next-command-'+id+'.json');
  try{
    if(fs.existsSync(pending)){
      const previous=JSON.parse(fs.readFileSync(pending,'utf8'));
      if(!/^[a-z0-9-]{1,80}$/.test(previous.id))throw Error('Invalid pending command identity');
      const receipt=path.join(root,'response-'+previous.id+'.json');
      if(!fs.existsSync(receipt)||JSON.parse(fs.readFileSync(receipt,'utf8')).id!==previous.id)throw Error('Previous owned fixture command remains unresolved: '+previous.id);
      fs.unlinkSync(pending);
    }
    fs.writeFileSync(pending,JSON.stringify(input),{flag:'wx'});
    fs.writeFileSync(temporary,JSON.stringify(input),{flag:'wx'});fs.renameSync(temporary,path.join(root,'command.json'));
    const response=path.join(root,'response-'+id+'.json'),end=Date.now()+timeoutMs;
    while(Date.now()<end){if(fs.existsSync(response)){const r=JSON.parse(fs.readFileSync(response,'utf8'));if(r.id!==id)throw Error('Wrong command receipt');fs.unlinkSync(pending);if(!r.ok)throw Error(r.error);return r.result;}await delay(100);}
    throw Error('Owned fixture command timed out: '+action);
  }finally{
    if(fs.existsSync(temporary))fs.unlinkSync(temporary);
    fs.closeSync(owner);fs.unlinkSync(lock);
  }
}
if(process.argv[1]&&import.meta.url===pathToFileURL(path.resolve(process.argv[1])).href){
  const [directory,action,options]=process.argv.slice(2);console.log(JSON.stringify(await command(directory,action,options?JSON.parse(options):{})));
}
