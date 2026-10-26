// Test-only Native frontend atom namespace check. No values, drafts, other
// settings, navigation, focus, callbacks, storage writes or backend requests.
export async function inspectOwnedViewportAtoms(document) {
  const prefix='codlet.workspace.viewport.';
  const assets=[...new Set([...document.querySelectorAll('link[rel="modulepreload"]')].map(node=>node.href).filter(url=>/^app:\/\/-\/assets\/app-shared-[A-Za-z0-9_-]+\.js$/.test(url)))];
  if(assets.length!==1)throw Error('A unique loaded Native shared module is required');
  const module=await import(assets[0]),candidates=[];
  for(const value of new Set(Object.values(module)))if(typeof value==='function'&&value.length===1){
    let source;try{source=Function.prototype.toString.call(value);}catch{continue;}
    if(['Array.from(','.keys()', '.startsWith('].every(marker=>source.includes(marker)))candidates.push(value);
  }
  if(candidates.length!==1)throw Error('Native persisted atom namespace listing is unavailable');
  const keys=candidates[0](prefix);
  if(!Array.isArray(keys)||keys.some(key=>typeof key!=='string'||!key.startsWith(prefix)))throw Error('Native owned key result changed shape');
  return Object.freeze({frontendCacheOnly:true,prefix,count:keys.length,keys:Object.freeze([...keys])});
}
