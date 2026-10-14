// Owned acceptance candidate only. Never loaded by a production Core bundle.
// Evidence is plain bounded data, and does not grant eval/debug access.
export const fixtureEvidenceSymbol='codlet.owned.online-factory-evidence.v1';
function recorder(component,{id,version}){
 if(!/^[a-f0-9]{64}$/.test(id)||typeof version!=='string'||version.length>64||!/^[a-z0-9-]+$/.test(component))throw Error('Invalid owned fixture stamp');
 return `function(stage){const key=Symbol.for(${JSON.stringify(fixtureEvidenceSymbol)});let value=globalThis[key];if(!value||value.api!==1||value.id!==${JSON.stringify(id)}){value={api:1,id:${JSON.stringify(id)},version:${JSON.stringify(version)},counts:{}};Object.defineProperty(globalThis,key,{value,configurable:true})}const name=${JSON.stringify(component)}+':'+stage;if(!Object.hasOwn(value.counts,name)&&Object.keys(value.counts).length>=128)return;value.counts[name]=Math.min(1000000,(value.counts[name]??0)+1)}`;
}
export function stampFixtureModule(component,source,identity){
 const record=recorder(component,identity),comment=`\n// codlet-owned-executed-fixture ${identity.version} ${identity.id}\n`;
 if(component==='host-bootstrap'){
  let result=`;(${record})('module-evaluated');\n`+source;
  for(const name of ['createEmbeddedServicesRuntime','createEmbeddedCodexHost','createEmbeddedSdkHost']){
   if(!result.includes(name+'('))throw Error('Host fixture factory call site missing: '+name);
   result=result.replaceAll(name+'(',`((${record})('factory:${name}'),${name})(`);
  }
  return result+comment;
 }
 if(component.startsWith('renderer-')&&component!=='renderer-core-services'){
  // Each original JS module is an expression factory. Keep its signature,
  // this binding and result; bootstrap/facade count only a fresh installation.
  const fresh=['renderer-bootstrap','renderer-facade'].includes(component);
  return `((factory)=>function(...args){const result=factory.apply(this,args);${fresh?"if(result?.ok===true&&result.reused!==true)":""}(${record})('factory');return result})(\n${source}\n)${comment}`;
 }
 const names=component==='client-source'?['installElectronTraffic','validateClientSource']:component==='renderer-core-services'?['createCoreServicesRuntime']:['activate','deactivate','saveState','restoreState'];
 return source+`\n;(()=>{const record=${record};record('module-evaluated');const original=module.exports,descriptors=Object.getOwnPropertyDescriptors(original),cache=new Map();for(const name of ${JSON.stringify(names)}){const descriptor=descriptors[name];if(!descriptor)continue;const value=original[name];if(typeof value!=='function')continue;const wrapped=function(...args){record('factory:'+name);const result=value.apply(this,args);${component==='client-source'?`if(name==='installElectronTraffic'&&result){const methods=Object.getOwnPropertyDescriptors(result);for(const stage of ['ready','restore','resume','confirmTakeover','suspend','close']){const fn=result[stage];if(typeof fn!=='function')continue;methods[stage]={enumerable:true,value:function(...args){record('runtime:'+stage);return fn.apply(this,args)}}}return Object.freeze(Object.defineProperties({},methods))}`:''}return result};if(descriptor.get)descriptors[name]={...descriptor,get:()=>wrapped};else descriptors[name]={...descriptor,value:wrapped}}module.exports=Object.defineProperties(Object.create(Object.getPrototypeOf(original)),descriptors)})();${comment}`;
}
