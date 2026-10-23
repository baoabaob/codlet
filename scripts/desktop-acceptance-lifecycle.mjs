// Real CLI receipts and fixture retirement evidence are both required. Keep the
// event loop free while a command runs so the local model fixture can respond.
export async function auditAcceptanceLifecycle({pluginId, cycles=1, execute, readCleanup, save, pause=ms=>new Promise(resolve=>setTimeout(resolve,ms))}) {
  if(!Number.isSafeInteger(cycles)||cycles<1||cycles>100)throw Error('lifecycleCycles must be 1..100');
  const audit={pluginId,requestedCycles:cycles,completedCycles:0,commands:[],unsubmittedBusyRetries:0,passed:false};
  const retired=new Set();let lastRetirement;
  try {
    for(let cycle=1;cycle<=cycles;cycle++) {
      for(const action of ['reload','disable','enable']) {
        let receipt;
        for(let attempt=1;attempt<=20;attempt++) {
          try{receipt=await execute(action);break;}
          catch(error){
            // Core explicitly confirms these requests never reached admission.
            // Uncertain operations and timeouts must never repeat a mutation.
            if(attempt===20||!/^package helper: operation was not submitted \(Host control endpoint is serving another client\); retry the plugin command later to obtain a new receipt\s*$/.test(error.stderr??''))throw error;
            audit.unsubmittedBusyRetries++;await pause(250);
          }
        }
        const report=receipt.control?.operation?.completion?.report;
        if(receipt.outcome!=='completed'||report?.outcome!=='applied'||!Array.isArray(report.target_failures)||report.target_failures.length)throw Error('Fixture lifecycle did not apply: '+action);
        const cleanup=await readCleanup();
        if(cleanup.retired!==true||cleanup.generation==null)throw Error('Fixture did not record retirement: '+action);
        if(action==='enable') {
          if(cleanup.generation!==lastRetirement)throw Error('Enabling unexpectedly changed retirement evidence');
        } else {
          if(retired.has(cleanup.generation))throw Error('Stale fixture retirement evidence: '+action);
          retired.add(cleanup.generation);lastRetirement=cleanup.generation;
        }
        audit.commands.push({cycle,action,receipt,cleanup});
        await save(audit);
      }
      audit.completedCycles=cycle;
    }
    audit.passed=true;
  } catch(error) {audit.error=String(error);}
  await save(audit);
  return audit;
}

export async function settleAcceptanceLifecycle(audit,{readProbe,save,timeoutMs=10000,now=Date.now,pause=ms=>new Promise(resolve=>setTimeout(resolve,ms))}) {
  if(!audit.passed)return audit;
  const last=audit.commands.at(-1),report=last?.receipt?.control?.operation?.completion?.report;
  const generations=report?.generations?.filter(value=>value.plugin_id===audit.pluginId)??[];
  const expected=generations.length===1?generations[0].generation:null;
  try {
    if(last?.action!=='enable'||!Number.isSafeInteger(expected)||expected<=last.cleanup.generation)throw Error('Final enable generation is unconfirmed');
    const deadline=now()+timeoutMs;
    while(now()<deadline) {
      let probe;try{probe=await readProbe();}catch{}
      if(probe?.value?.generation===expected&&probe.value.phase==='ready'&&probe.value.reportNodes===1) {
        audit.finalRenderer={expectedGeneration:expected,...probe};await save(audit);return audit;
      }
      await pause(100);
    }
    throw Error('Final lifecycle renderer did not become ready');
  } catch(error) {audit.passed=false;audit.error=String(error);}
  await save(audit);return audit;
}
