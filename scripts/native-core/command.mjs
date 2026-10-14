import fs from 'node:fs';
import path from 'node:path';
import {randomUUID} from 'node:crypto';
import {setTimeout as delay} from 'node:timers/promises';
import {pathToFileURL} from 'node:url';
export async function command(directory,action,options={},timeoutMs=20000){
  const id=randomUUID(),root=path.resolve(directory),input={id,action,options};
  const temporary=path.join(root,'next-command.json');fs.writeFileSync(temporary,JSON.stringify(input));fs.renameSync(temporary,path.join(root,'command.json'));
  const response=path.join(root,'response-'+id+'.json'),end=Date.now()+timeoutMs;
  while(Date.now()<end){if(fs.existsSync(response)){const r=JSON.parse(fs.readFileSync(response,'utf8'));if(r.id!==id)throw Error('Wrong command receipt');if(!r.ok)throw Error(r.error);return r.result;}await delay(100);}
  throw Error('Owned fixture command timed out: '+action);
}
if(process.argv[1]&&import.meta.url===pathToFileURL(path.resolve(process.argv[1])).href){
  const [directory,action,options]=process.argv.slice(2);console.log(JSON.stringify(await command(directory,action,options?JSON.parse(options):{})));
}
