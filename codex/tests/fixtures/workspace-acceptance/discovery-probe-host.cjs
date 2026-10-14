'use strict';
const fs=require('node:fs'),path=require('node:path');
module.exports={async activate(context){
  const reports=[],expression=fs.readFileSync(path.join(context.root,'probe.js'),'utf8');
  const {targetInfos}=await context.cdp.request('Target.getTargets');
  for(const target of targetInfos.filter(target=>target.type==='page'&&target.url==='app://-/index.html')){
    let sessionId;
    try{
      ({sessionId}=await context.cdp.request('Target.attachToTarget',{targetId:target.targetId,flatten:true}));
      const result=await context.cdp.request('Runtime.evaluate',{expression,awaitPromise:true,returnByValue:true},{sessionId});
      reports.push({targetId:target.targetId,result:result.result?.value,exception:result.exceptionDetails?.exception?.description??result.exceptionDetails?.text});
    }catch(error){reports.push({targetId:target.targetId,error:error.message});}
    finally{if(sessionId)try{await context.cdp.request('Target.detachFromTarget',{sessionId});}catch{}}
  }
  fs.writeFileSync(path.join(context.root,'report.json'),JSON.stringify(reports,null,2));
},deactivate(){}};
