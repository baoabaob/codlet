let page,lease;
exports.activate=async context=>{
  const cap=name=>({name,api:1,scope:name==='codlet.compat.fixture'?'runtime':'target'});
  const request=(name,method,args={})=>context.rpc.request(cap(name),method,args,{timeoutMs:8000});
  const token=crypto.randomUUID();
  lease=document.createElement('span');lease.hidden=true;
  Object.assign(lease.dataset,{codletComposerActionLease:token,codletComposerActionOwner:context.pluginId,codletGeneration:String(context.generation)});
  document.body.append(lease);let clicks=0;lease.addEventListener('codlet:composer-action',()=>clicks++);
  await request('codex.ui.composer.action','register',{label:'Fixture action',token});
  page=await context.ui.page({label:'Compatibility fixture',icon:'Cube',render:({ui})=>ui.React.createElement('div',null,'Isolated compatibility fixture')});
  globalThis.__codletCompatConsumer={request,token,get clicks(){return clicks},pagePath:page.path,
    cleanup:()=>{page.dispose();lease.remove();}};
  context.onDeactivate(()=>{page.dispose();lease.remove();delete globalThis.__codletCompatConsumer;});
};
exports.deactivate=()=>{page?.dispose();lease?.remove();};
