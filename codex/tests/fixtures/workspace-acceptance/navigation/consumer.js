const symbol=Symbol.for('codlet.workspace.navigation.audit'),capability={name:'workspace.audit.navigation',api:1,scope:'target'};
let audit;
export function activate(context){
  audit={phase:'running'};globalThis[symbol]=audit;
  Promise.resolve().then(async()=>{
    let description;const measurements=[],controlRpcMs=[];
    try{
      description=await context.rpc.request(capability,'describe',{});
      for(let sample=0;sample<2;sample++){const start=performance.now();await context.rpc.request(capability,'describe',{});controlRpcMs.push(performance.now()-start);}
      if(!description.original||description.warm.length!==2){audit.result={status:'control-only',controlRpcMs,measurements,reason:'Two already-resumed warm tasks and a local original route are required for navigation'};return;}
      for(const threadId of description.warm){const start=performance.now(),receipt=await context.rpc.request(capability,'open',{threadId});measurements.push({threadId,rpcMs:performance.now()-start,receipt});if(receipt.threadId!==threadId||receipt.status!=='opened'||receipt.metadataReads!==0)throw Error('Warm navigation receipt or cache fast path did not match');await new Promise(resolve=>setTimeout(resolve,50));}
      const restored=await context.rpc.request(capability,'open',{threadId:description.original});
      audit.result={status:'passed',measurements,controlRpcMs,restored:restored.threadId===description.original,restorationReceipt:restored};
    }catch(error){if(description?.original)try{await context.rpc.request(capability,'open',{threadId:description.original});}catch{}audit.result={status:'failed',measurements,error:error.message};}
    finally{audit.phase='done';}
  });
}
export function deactivate(){if(globalThis[symbol]===audit)delete globalThis[symbol];audit=null;}
