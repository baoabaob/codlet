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
  const health=registrationHealth.get(context)??{latest:null,pending:null,failed:false,renderFailed:false},attempt={};health.latest=attempt;registrationHealth.set(context,health);
  let live = true, lease = null, observer = null, host = null, view = null, registered=false, settled=false, path=null, failureCode='ui_page_registration_failed';
  let resolveReady,rejectReady;
  const ready=new Promise((resolve,reject)=>{resolveReady=resolve;rejectReady=reject;});
  // Callers may use only the page handle. Its separate readiness rejection is
  // still observable by await, without becoming an unhandled rejection.
  ready.catch(()=>{});
  const cancelled=message=>Object.assign(new Error(message),{code:'ui_page_cancelled'});
  const superseded=()=>Object.assign(new Error('The page registration was replaced'),{code:'ui_page_superseded'});
  const cancellation=error=>['ui_page_cancelled','ui_page_superseded','ui_retired'].includes(error?.code);
  const diagnostic=value=>{try{context.reportDiagnostic?.(value);return true;}catch{return false;}};
  const reportFailure=(code,error)=>{
    if(code!=='ui_cleanup_failed'&&(health.latest!==attempt||cancellation(error)))return;
    if(diagnostic({code,message:String(error?.message??error).slice(0,1000),level:'error'})){
      if(code==='ui_page_registration_failed')health.failed=true;
      if(code==='ui_page_render_failed')health.renderFailed=true;
    }
  };
  const clearPending=()=>{
    if(health.pending!==attempt)return;
    health.pending=null;
    diagnostic({code:'ui_page_registration_pending',message:'Native page registration settled',level:'info',resolved:true});
  };
  const finish=(error,value,code='ui_page_registration_failed')=>{
    if(settled)return;settled=true;clearPending();
    if(error){
      if(live)reportFailure(code,error);
      rejectReady(error);
    }else{
      path=value.path;
      if(health.latest===attempt&&health.failed&&diagnostic({code:'ui_page_registration_failed',message:'Native page registration recovered',level:'info',resolved:true}))health.failed=false;
      resolveReady(Object.freeze({available:value.available!==false,path}));
    }
  };
  const clean = actions => {const errors=[];for(const action of actions)try{action();}catch(error){errors.push(...(error instanceof AggregateError?error.errors:[error]));}return errors;};
  const fail = errors => {if(errors.length===1)throw errors[0];if(errors.length)throw new AggregateError(errors,'Page cleanup failed');};
  const detach = () => {
    const old = view, hadHost = host; view = host = null;
    return clean([()=>old?.mounted?.unmount(),()=>{if(hadHost)onDeactivate?.();},()=>old?.ui.dispose()]);
  };
  const stop = (reason=cancelled('Page owner retired')) => {
    if(!live)return;live=false;
    finish(reason);clearPending();
    const errors=clean([()=>abort.abort(),()=>observer?.disconnect()]);
    errors.push(...detach(),...clean([()=>lease?.remove(),()=>unregister(),()=>onDispose?.(stop)]));
    if(errors.length)reportFailure('ui_cleanup_failed',errors.length===1?errors[0]:new AggregateError(errors,'Page cleanup failed'));
    fail(errors);
  };
  const unregister = context.onDeactivate(stop);
  const assertLive = () => {if(!live)throw cancelled('Page owner retired');};
  const assertLatest = () => {assertLive();if(health.latest!==attempt)throw superseded();};
  try {
    onCreate?.(stop);
    if(!document.body||!document.head)await new Promise((resolve,reject)=>{
      const done=()=>{document.removeEventListener('DOMContentLoaded',ready);abort.signal.removeEventListener('abort',cancelled);};
      const ready=()=>{done();resolve();},cancelled=()=>{done();reject(Object.assign(new Error('Page owner retired before document readiness'),{code:'ui_page_cancelled'}));};
      document.addEventListener('DOMContentLoaded',ready,{once:true});abort.signal.addEventListener('abort',cancelled,{once:true});
    });
    assertLatest();
    const token=crypto.randomUUID();lease=document.createElement('span');
    lease.hidden=true;lease.dataset.codletPageLease=token;lease.dataset.codletPageOwner=context.pluginId;
    lease.dataset.codletGeneration=String(context.generation);document.body.appendChild(lease);
    const assertLease=()=>{
      assertLive();
      if(!lease.isConnected)throw Object.assign(new Error('The native page registration was retired'),{code:'ui_retired'});
      if(lease.dataset.codletPageLease!==token||lease.dataset.codletPageOwner!==context.pluginId||lease.dataset.codletGeneration!==String(context.generation))throw Object.assign(new Error('The native page registration owner changed'),{code:'invalid_owner'});
    };
    const reply=await context.rpc.request({name:'codex.ui.navigation.page',api:1,scope:'target'},'register',{label,icon,token,...(toolbar?{toolbar:true}:{})});
    assertLatest();
    if(reply?.api!==1||reply.token!==token)throw new Error('Invalid native page registration');
    const page=Object.freeze({get path(){return path;},ready,dispose:stop,setBadge(label){
      assertLease();
      if(label!==null&&(typeof label!=='string'||!label.trim()||label.length>160))throw new Error('A page badge requires a short accessible label or null');
      if(label===null)delete lease.dataset.codletPageBadge;
      else lease.dataset.codletPageBadge=label;
    }});
    const unavailable=reply.available===false&&reply.path===null;
    if(!unavailable&&(typeof reply.path!=='string'||reply.available===false))throw new Error('Invalid native page registration');
    if(unavailable){finish(null,reply);stop();return page;}
    path=reply.path;
    const reservedPath=path;
    const inspectRegistration=()=>{
      if(settled)return;
      assertLatest();
      const text=lease.dataset.codletPageRegistration;
      if(text){
        const value=JSON.parse(text);
        if(value?.api!==1||value.token!==token||!['ready','unavailable','failed'].includes(value.status))throw new Error('Invalid native page registration result');
        if(value.status==='failed'){
          if(typeof value.error?.message!=='string'||typeof value.error?.code!=='string')throw new Error('Invalid native page registration failure');
          throw Object.assign(new Error(value.error.message),{code:value.error.code});
        }
        if(value.status==='ready'&&(value.path!==reservedPath||value.available===false)||value.status==='unavailable'&&(value.path!==null||value.available!==false))throw new Error('Invalid native page registration result');
        if(value.status==='unavailable'){finish(null,value);stop();return;}
        assertLease();registered=true;finish(null,value);return;
      }
      assertLease();
    };
    const reconcile=()=>{
      if(!live)return;
      inspectRegistration();
      if(!live||!registered)return;
      if(!lease.isConnected){stop();return;}
      failureCode='ui_page_render_failed';assertLease();
      const next=[...document.querySelectorAll('[data-codlet-page-host]')].find(element=>element.dataset.codletPageHost===token)??null;
      if(next!==host){
        const errors=detach();if(errors.length){failureCode='ui_cleanup_failed';fail(errors);}
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
          if(!live)return;
          view.mounted=ui.mount(node,render({ui,toolbar:toolbarNode}),overlay,scope);
          if(health.latest===attempt&&health.renderFailed&&diagnostic({code:'ui_page_render_failed',message:'Native page rendered successfully',level:'info',resolved:true}))health.renderFailed=false;
        }
      }
      if(view?.toolbar){
        const target=host&&[...document.querySelectorAll('[data-codlet-page-toolbar]')].find(element=>element.dataset.codletPageToolbar===token);
        if(target){if(view.toolbar.parentElement!==target)target.appendChild(view.toolbar);}else view.toolbar.remove();
      }
    };
    observer=new MutationObserver(records=>{
      if(!live)return;
      const contains=target=>!!view&&(view.node?.contains(target)||view.toolbar?.contains(target)||view.overlay?.contains(target));
      const markers='[data-codlet-page-host], [data-codlet-page-toolbar]';
      const changed=records.some(record=>record.target===lease||!contains(record.target)&&[...record.addedNodes,...record.removedNodes].some(node=>node.nodeType===1&&(node.matches(markers)||node.querySelector(markers))));
      if(settled&&lease.isConnected&&(!host||host.isConnected)&&!changed)return;
      try{reconcile();}catch(error){
        if(live){if(settled)reportFailure(failureCode,error);else finish(error);}
        clean([()=>stop(error)]);
      }
    });
    observer.observe(lease,{attributes:true,attributeFilter:['data-codlet-page-registration','data-codlet-page-owner','data-codlet-generation','data-codlet-page-lease']});
    observer.observe(document.documentElement,{childList:true,subtree:true});
    if(reply.pending===true){inspectRegistration();if(!settled){health.pending=attempt;diagnostic({code:'ui_page_registration_pending',message:'Waiting for Native page registration',level:'info'});}}
    else{assertLease();registered=true;finish(null,reply);}
    reconcile();
    return page;
  }catch(error){
    if(live){if(settled)reportFailure(failureCode,error);else finish(error,undefined,failureCode);}
    fail([error,...clean([stop])]);
  }
}
