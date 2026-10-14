'use strict';
const fs=require('node:fs'),path=require('node:path');
let pending;
module.exports={activate(context){pending=setTimeout(async()=>{
  let sessionId;
  try{
    const {targetInfos}=await context.cdp.request('Target.getTargets'),target=targetInfos.find(target=>target.targetId==='F6A028F01F7CF0D943DB75CF88BA040F');
    if(!target)throw Error('The reported native target is unavailable');
    ({sessionId}=await context.cdp.request('Target.attachToTarget',{targetId:target.targetId,flatten:true}));
    let result;
    for(let attempt=0;attempt<60&&!context.signal.aborted;attempt++){
      const evaluated=await context.cdp.request('Runtime.evaluate',{expression:'globalThis[Symbol.for("codlet.workspace.navigation.audit")]??null',returnByValue:true},{sessionId});
      result=evaluated.result?.value;if(result?.result)break;
      await new Promise(resolve=>setTimeout(resolve,250));
    }
    fs.writeFileSync(path.join(context.root,'report.json'),JSON.stringify({targetId:target.targetId,result},null,2));
  }catch(error){fs.writeFileSync(path.join(context.root,'report.json'),JSON.stringify({error:error.message}));}
  finally{if(sessionId)try{await context.cdp.request('Target.detachFromTarget',{sessionId});}catch{}}
},0);},deactivate(){clearTimeout(pending);}};
