'use strict';
const fs=require('node:fs'),path=require('node:path');
let timer;
module.exports={activate(context){timer=setTimeout(async()=>{
  let sessionId;const output=path.join(context.root,'report.json');
  try{
    const {targetInfos}=await context.cdp.request('Target.getTargets');
    const expression='globalThis[Symbol.for("codlet.workspace.cold.audit")]?.inspect()??null';
    let target;
    for(const candidate of targetInfos.filter(item=>item.type==='page'&&item.url==='app://-/index.html')){
      ({sessionId}=await context.cdp.request('Target.attachToTarget',{targetId:candidate.targetId,flatten:true}));
      const response=await context.cdp.request('Runtime.evaluate',{expression,returnByValue:true},{sessionId});
      if(response.result?.value?.available){target=candidate;break;}
      await context.cdp.request('Target.detachFromTarget',{sessionId});sessionId=null;
    }
    if(!target)throw Error('No native target with an initialized cold-transcript probe is available');
    let value;
    for(let attempt=0;attempt<80&&!context.signal.aborted;attempt++){
      const evaluated=await context.cdp.request('Runtime.evaluate',{expression,returnByValue:true},{sessionId});value=evaluated.result?.value;
      if(value?.available&&value.phase==='idle')await context.cdp.request('Runtime.evaluate',{expression:'void globalThis[Symbol.for("codlet.workspace.cold.audit")].run();"started"',returnByValue:true},{sessionId});
      if(value?.result)break;
      await new Promise(resolve=>setTimeout(resolve,500));
    }
    fs.writeFileSync(output,JSON.stringify({targetId:target.targetId,value},null,2));
  }catch(error){fs.writeFileSync(output,JSON.stringify({error:error.message},null,2));}
  finally{if(sessionId)try{await context.cdp.request('Target.detachFromTarget',{sessionId});}catch{}}
},200);},deactivate(){clearTimeout(timer);}};
