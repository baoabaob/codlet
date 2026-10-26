'use strict';
const fs=require('node:fs'),path=require('node:path');
let pending;
module.exports={activate(context){pending=setTimeout(async()=>{
  let sessionId;
  try{
    const {targetInfos}=await context.cdp.request('Target.getTargets'),matches=[];
    for(const candidate of targetInfos.filter(value=>value.type==='page'&&value.url==='app://-/index.html')){
      let candidateSession;
      try{
        ({sessionId:candidateSession}=await context.cdp.request('Target.attachToTarget',{targetId:candidate.targetId,flatten:true}));
        const value=await context.cdp.request('Runtime.evaluate',{expression:'!!globalThis[Symbol.for("codlet.workspace.navigation.audit")]',returnByValue:true},{sessionId:candidateSession});
        if(value.result?.value===true)matches.push(candidate);
      }finally{if(candidateSession)await context.cdp.request('Target.detachFromTarget',{sessionId:candidateSession});}
    }
    if(matches.length!==1)throw Error('A unique current navigation fixture Target is required');
    const target=matches[0];
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
