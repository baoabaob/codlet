'use strict';
let dispose;
module.exports.deactivate=()=>{dispose?.();dispose=null;};
module.exports.activate=async context=>{
  if(innerWidth<480||innerHeight<400)return;
  let alive=true,timer;
  const report=document.createElement('div');report.hidden=true;
  report.dataset.remoteCompatibilityAcceptance='running';document.body.append(report);
  const state={phase:'running',checks:[],clientStatus:null,runtimeVersion:null,error:null};
  const save=()=>{report.dataset.remoteCompatibilityAcceptance=state.phase;report.textContent=JSON.stringify(state);};
  dispose=()=>{alive=false;clearTimeout(timer);report.remove();};context.onDispose(dispose);
  const request=(method,params=null)=>context.rpc.request({name:'codlet.runtime.manage',api:1,scope:'runtime'},method,params,{timeoutMs:5000});
  const assert=(value,message)=>{if(!value)throw Error(message);};
  try {
    const started=Date.now();
    while(alive){
      const value=await request('versionStatus');state.runtimeVersion=value.runtimeVersion;state.clientStatus=value.clientStatus;save();
      if(value.clientStatus?.source==='remote-manifest')break;
      assert(Date.now()-started<20000,'Remote metadata was not observed');
      await new Promise(resolve=>{timer=setTimeout(resolve,250);});
    }
    if(!alive)return;
    assert(state.runtimeVersion==='0.2.0-preview.24','Unexpected Core version');
    assert(state.clientStatus.matchesRunningClient===true,'Current adapter prerequisites did not match');
    assert(state.clientStatus.compatibilityCatalog.checkedAtUnixMs>0,'Missing successful check time');
    state.checks.push({id:'remote.version-status',status:'passed'});
    const checked=await request('checkClientCompatibility');
    assert(checked.source==='remote-manifest','Manual refresh did not retain valid data');
    state.checks.push({id:'remote.manual-check',status:'passed'});
    let rejected=false;
    try{await request('checkClientCompatibility',{url:'https://example.invalid/override'});}catch(error){rejected=error.code==='invalid_params'||String(error).includes('invalid_params');}
    assert(rejected,'Caller-selected source was not rejected');
    state.checks.push({id:'remote.fixed-source',status:'passed'});
    const listing=await request('list');
    assert(listing.clientStatus.matchesRunningClient===true,'Management list did not include current compatibility');
    assert(listing.clientStatus.compatibilityCatalog.revision===state.clientStatus.compatibilityCatalog.revision,'Catalog snapshot drifted');
    state.checks.push({id:'remote.management-list',status:'passed'});
    state.phase='complete';save();
  } catch(error) {if(alive){state.phase='failed';state.error=String(error);save();}}
};
