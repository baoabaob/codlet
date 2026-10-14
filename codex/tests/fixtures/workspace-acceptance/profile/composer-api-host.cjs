'use strict';
const fs=require('node:fs'),path=require('node:path');let timer;
module.exports={activate(context){timer=setTimeout(async()=>{
 let sessionId;const output=path.join(context.root,'report.json'),backup=path.join(context.root,'draft-backup.json');
 try{const args=JSON.parse(fs.readFileSync(path.join(context.root,'targets.json'),'utf8')),{targetInfos}=await context.cdp.request('Target.getTargets');let target;
  for(const candidate of targetInfos.filter(item=>item.type==='page'&&item.url==='app://-/index.html')){({sessionId}=await context.cdp.request('Target.attachToTarget',{targetId:candidate.targetId,flatten:true}));const response=await context.cdp.request('Runtime.evaluate',{expression:'globalThis[Symbol.for("codlet.workspace.composer.api.result")]?.inspect()??null',returnByValue:true},{sessionId});if(response.result?.value?.available){const state=response.result.value;if(state.phase!=='auxiliary'){target=candidate;break;}}await context.cdp.request('Target.detachFromTarget',{sessionId});sessionId=null;}
  if(!target)throw Error('An initialized composer API probe is required');let value;
  for(let attempt=0;attempt<100&&!context.signal.aborted;attempt++){const result=await context.cdp.request('Runtime.evaluate',{expression:'globalThis[Symbol.for("codlet.workspace.composer.api.result")]?.inspect()??null',returnByValue:true},{sessionId});value=result.result?.value;
   if(value?.phase==='idle')await context.cdp.request('Runtime.evaluate',{expression:'void globalThis[Symbol.for("codlet.workspace.composer.api.result")].run('+JSON.stringify(args)+');"started"',returnByValue:true},{sessionId});
   if(value?.backup){if(fs.existsSync(backup)){const old=JSON.parse(fs.readFileSync(backup,'utf8'));if(JSON.stringify(old)!==JSON.stringify(value.backup))throw Error('Existing original draft backup differs; restore it before testing');}else fs.writeFileSync(backup,JSON.stringify(value.backup,null,2),{flag:'wx'});await context.cdp.request('Runtime.evaluate',{expression:'globalThis[Symbol.for("codlet.workspace.composer.api.result")].confirmBackup();"backed-up"',returnByValue:true},{sessionId});}
   if(value?.result)break;await new Promise(resolve=>setTimeout(resolve,200));
  }
  fs.writeFileSync(output,JSON.stringify({targetId:target.targetId,value},null,2));
 }catch(error){fs.writeFileSync(output,JSON.stringify({error:error.message},null,2));}finally{if(sessionId)try{await context.cdp.request('Target.detachFromTarget',{sessionId});}catch{}}
},300);},deactivate(){clearTimeout(timer);}};
