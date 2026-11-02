// Navigation registration does not need React, styles, or a UI owner. Acquire
// those only while the native adapter actually exposes this page's mount.
const registrationHealth=new WeakMap();
function pageUI(base,lease){
  let glyph;try{glyph=JSON.parse(lease.dataset.codletNativeDownload??'null');}catch{}
  const viewBox=typeof glyph?.viewBox==='string'?glyph.viewBox.trim().split(/\s+/).map(Number):null;
  if(viewBox?.length!==4||viewBox.some(value=>!Number.isFinite(value))||!Array.isArray(glyph?.paths)||!glyph.paths.length||glyph.paths.some(value=>typeof value!=='string'||!/^[MmLlHhVvCcSsQqTtAaZz0-9eE+.,\s-]+$/.test(value)))return base;
  const Download=props=>base.React.createElement('svg',{width:'1em',height:'1em',viewBox:glyph.viewBox,fill:'none',...props},...glyph.paths.map((d,index)=>base.React.createElement('path',{key:index,d,fill:'currentColor'})));
  return Object.freeze({...base,icons:Object.freeze({...base.icons,Download})});
}
export default async function registerPage(context, {label, icon = 'Cube', toolbar = false, render, onActivate, onDeactivate}, acquireUI, onDispose = null, onCreate = null) {
  if (typeof render !== 'function') throw new Error('A page render function is required');
  if (typeof toolbar !== 'boolean') throw new Error('Toolbar must be a boolean');
  const abort = new AbortController();
  const health=registrationHealth.get(context)??{attempt:null,failed:false},attempt={};health.attempt=attempt;registrationHealth.set(context,health);
  let live = true, lease = null, observer = null, registrationObserver = null, host = null, view = null;
  const clean = actions => {const errors=[];for(const action of actions)try{action();}catch(error){errors.push(...(error instanceof AggregateError?error.errors:[error]));}return errors;};
  const fail = errors => {if(errors.length===1)throw errors[0];if(errors.length)throw new AggregateError(errors,'Page cleanup failed');};
  const detach = () => {
    const old = view, hadHost = host; view = host = null;
    return clean([()=>old?.mounted?.unmount(),()=>{if(hadHost)onDeactivate?.();},()=>old?.ui.dispose()]);
  };
  const stop = () => {
    if(!live)return;live=false;
    const errors=clean([()=>abort.abort(),()=>observer?.disconnect(),()=>registrationObserver?.disconnect()]);
    errors.push(...detach(),...clean([()=>lease?.remove(),()=>unregister(),()=>onDispose?.(stop)]));
    fail(errors);
  };
  const unregister = context.onDeactivate(stop);
  const assertLive = () => {if(!live)throw new Error('Page owner retired');};
  try {
    onCreate?.(stop);
    if(!document.body||!document.head)await new Promise((resolve,reject)=>{
      const done=()=>{document.removeEventListener('DOMContentLoaded',ready);abort.signal.removeEventListener('abort',cancelled);};
      const ready=()=>{done();resolve();},cancelled=()=>{done();reject(new Error('Page owner retired before document readiness'));};
      document.addEventListener('DOMContentLoaded',ready,{once:true});abort.signal.addEventListener('abort',cancelled,{once:true});
    });
    assertLive();
    const token=crypto.randomUUID();lease=document.createElement('span');
    lease.hidden=true;lease.dataset.codletPageLease=token;lease.dataset.codletPageOwner=context.pluginId;
    lease.dataset.codletGeneration=String(context.generation);document.body.appendChild(lease);
    const assertLease=()=>{
      assertLive();
      if(!lease.isConnected)throw Object.assign(new Error('The native page registration was retired'),{code:'ui_retired'});
      if(lease.dataset.codletPageLease!==token||lease.dataset.codletPageOwner!==context.pluginId||lease.dataset.codletGeneration!==String(context.generation))throw Object.assign(new Error('The native page registration owner changed'),{code:'invalid_owner'});
    };
    let reply=await context.rpc.request({name:'codex.ui.navigation.page',api:1,scope:'target'},'register',{label,icon,token,...(toolbar?{toolbar:true}:{})});
    assertLive();
    if(reply?.api!==1||reply.token!==token)throw new Error('Invalid native page registration');
    if(reply.pending===true){
      const path=reply.path;
      reply=await new Promise((resolve,reject)=>{
        const done=()=>{registrationObserver?.disconnect();registrationObserver=null;abort.signal.removeEventListener('abort',cancelled);};
        const finish=(error,value)=>{done();error?reject(error):resolve(value);};
        const cancelled=()=>finish(new Error('Page owner retired during registration'));
        const inspect=()=>{
          try{
            const text=lease.dataset.codletPageRegistration;
            if(text){
              const value=JSON.parse(text);
              if(value?.api!==1||value.token!==token||!['ready','unavailable','failed'].includes(value.status))throw new Error('Invalid native page registration result');
              if(value.status==='failed'){
                if(typeof value.error?.message!=='string'||typeof value.error?.code!=='string')throw new Error('Invalid native page registration failure');
                throw Object.assign(new Error(value.error.message),{code:value.error.code});
              }
              if(value.status==='ready'&&(value.path!==path||value.available===false)||value.status==='unavailable'&&(value.path!==null||value.available!==false))throw new Error('Invalid native page registration result');
              if(value.status==='ready')assertLease();
              finish(null,value);return;
            }
            if(!lease.isConnected)throw Object.assign(new Error('The native page registration was retired'),{code:'ui_retired'});
          }catch(error){finish(error);}
        };
        registrationObserver=new MutationObserver(inspect);
        registrationObserver.observe(lease,{attributes:true,attributeFilter:['data-codlet-page-registration']});
        registrationObserver.observe(document.documentElement,{childList:true,subtree:true});
        abort.signal.addEventListener('abort',cancelled,{once:true});
        inspect();
      });
      assertLive();
    }
    if(reply.available===false&&reply.path===null){stop();return Object.freeze({path:null,dispose:stop});}
    if(typeof reply.path!=='string'||reply.available===false)throw new Error('Invalid native page registration');
    assertLease();
    const reconcile=()=>{
      if(!live)return;
      if(!lease.isConnected){stop();return;}
      const next=[...document.querySelectorAll('[data-codlet-page-host]')].find(element=>element.dataset.codletPageHost===token)??null;
      if(next!==host){
        const errors=detach();if(errors.length){errors.push(...clean([stop]));fail(errors);}
        if(!live)return;host=next;
        if(host){
          const ui=pageUI(acquireUI(),lease);view={ui,mounted:null};
          const node=ui.container(),toolbarNode=toolbar?ui.container():null,overlay=ui.container();
          Object.assign(view,{node,toolbar:toolbarNode,overlay});
          const scope={contains:target=>node.contains(target)||!!toolbarNode?.contains(target)||overlay.contains(target)};
          if(toolbarNode){toolbarNode.remove();toolbarNode.style.width='100%';toolbarNode.style.minWidth='0';}
          node.style.height='100%';node.style.minHeight='0';node.style.minWidth='0';
          overlay.dataset.codletPageOverlays=token;overlay.style.display='contents';
          host.appendChild(node);onActivate?.();
          view.mounted=ui.mount(node,render({ui,toolbar:toolbarNode}),overlay,scope);
        }
      }
      if(view?.toolbar){
        const target=host&&[...document.querySelectorAll('[data-codlet-page-toolbar]')].find(element=>element.dataset.codletPageToolbar===token);
        if(target){if(view.toolbar.parentElement!==target)target.appendChild(view.toolbar);}else view.toolbar.remove();
      }
    };
    observer=new MutationObserver(records=>{
      const contains=target=>!!view&&(view.node?.contains(target)||view.toolbar?.contains(target)||view.overlay?.contains(target));
      const markers='[data-codlet-page-host], [data-codlet-page-toolbar]';
      const changed=records.some(record=>!contains(record.target)&&[...record.addedNodes,...record.removedNodes].some(node=>node.nodeType===1&&(node.matches(markers)||node.querySelector(markers))));
      if(lease.isConnected&&(!host||host.isConnected)&&!changed)return;
      try{reconcile();}catch(error){const errors=[error,...clean([stop])];try{fail(errors);}catch(failure){context.reportDiagnostic?.({code:'ui_cleanup_failed',message:String(failure?.message??failure).slice(0,3000)});}}
    });
    observer.observe(document.documentElement,{childList:true,subtree:true});reconcile();assertLease();
    if(health.attempt===attempt&&health.failed)try{context.reportDiagnostic?.({code:'ui_page_registration_failed',message:'Native page registration recovered',level:'info',resolved:true});health.failed=false;}catch{}
    return Object.freeze({path:reply.path,dispose:stop,setBadge(label){
      assertLive();
      if(label!==null&&(typeof label!=='string'||!label.trim()||label.length>160))throw new Error('A page badge requires a short accessible label or null');
      if(label===null)delete lease.dataset.codletPageBadge;
      else lease.dataset.codletPageBadge=label;
    }});
  }catch(error){
    if(live&&health.attempt===attempt)try{context.reportDiagnostic?.({code:'ui_page_registration_failed',message:String(error?.message??error).slice(0,1000),level:'error'});health.failed=true;}catch{}
    fail([error,...clean([stop])]);
  }
}
