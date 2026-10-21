import {OWNED,workspaceError} from './workspace-dom.js';

export function createComposerControls({document,surface,check,isConfirmed,changed}) {
  let record,disposed=false;
  const attribute=(node,name,value)=>{if(node.getAttribute(name)!==value)node.setAttribute(name,value);};
  const restoreNode=(native,journal)=>{
    if(native.style.getPropertyValue('display')==='none'&&native.style.getPropertyPriority('display')==='important')
      journal.display?native.style.setProperty('display',journal.display,journal.priority):native.style.removeProperty('display');
    for(const [name,applied] of [['inert',''],['aria-hidden','true']])if(native.getAttribute(name)===applied)
      journal[name]==null?native.removeAttribute(name):native.setAttribute(name,journal[name]);
  };
  const restore=()=>{if(record?.native)restoreNode(record.native,record.journal);if(record){record.native=null;record.journal=null;}};
  const mask=native=>{
    if(native.style.getPropertyValue('display')!=='none'||native.style.getPropertyPriority('display')!=='important')native.style.setProperty('display','none','important');
    attribute(native,'inert','');attribute(native,'aria-hidden','true');
  };
  const journal=native=>({display:native.style.getPropertyValue('display'),priority:native.style.getPropertyPriority('display'),inert:native.getAttribute('inert'),'aria-hidden':native.getAttribute('aria-hidden')});
  function options(value){
    if(!value||typeof value!=='object'||Array.isArray(value)||Object.keys(value).some(key=>!['control','threadId'].includes(key))||
      value.control!==undefined&&value.control!=='permissions'||value.threadId!==null&&(typeof value.threadId!=='string'||!/^[\w-]{1,256}$/.test(value.threadId)))
      throw workspaceError('invalid_argument','Invalid composer control binding');
    if(value.threadId!==null&&!isConfirmed(value.threadId))throw workspaceError('workspace_selection_not_confirmed','Native input does not match composer control');
    return value.threadId;
  }
  function reconcile(){
    if(!record?.active)return;
    const input=surface()?.composer;
    const candidates=input?[...input.querySelectorAll('[data-composer-navigation-target="permissions"]')].filter(node=>!node.closest(OWNED)):[];
    if(candidates.length>1){
      attribute(record.container,'inert','');
      for(const native of candidates){if(native!==record.native&&!record.blocked.has(native))record.blocked.set(native,journal(native));mask(native);}
      record.failed=true;throw workspaceError('workspace_control_unsupported','Native permission trigger is ambiguous');
    }
    if(record.failed)throw workspaceError('workspace_control_unsupported','Native permission trigger ownership failed; release the control lease');
    const native=candidates[0];
    if(!native?.isConnected){attribute(record.container,'inert','');record.container.remove();if(record.native&&!record.native.isConnected)restore();return;}
    if(native!==record.native){
      restore();record.native=native;record.journal=journal(native);
    }else{
      if(native.style.getPropertyValue('display')!=='none'||native.style.getPropertyPriority('display')!=='important'){
        record.journal.display=native.style.getPropertyValue('display');record.journal.priority=native.style.getPropertyPriority('display');
      }
      if(native.getAttribute('inert')!=='')record.journal.inert=native.getAttribute('inert');
      if(native.getAttribute('aria-hidden')!=='true')record.journal['aria-hidden']=native.getAttribute('aria-hidden');
    }
    if(record.container.parentElement!==native.parentElement||record.container.nextSibling!==native)native.before(record.container);
    mask(native);
    const confirmed=record.threadId!==null&&isConfirmed(record.threadId);
    if(confirmed)record.container.removeAttribute('inert');else attribute(record.container,'inert','');
    attribute(record.container,'aria-disabled',String(!confirmed));
  }
  function acquire(value,owner,live){
    check();live();if(disposed)throw workspaceError('workspace_retired','Composer control provider retired');
    if(record)throw workspaceError('workspace_control_owned','Native permission control already has an owner');
    const threadId=options(value),container=document.createElement('span');container.dataset.codletWorkspaceOwned=owner;container.style.display='contents';
    // A consumer's Core root handles its own events. They must not bubble into
    // the hidden Native dropdown's trigger handlers.
    const stop=event=>event.stopPropagation(),events=['click','pointerdown','keydown'];
    for(const event of events)container.addEventListener(event,stop);
    record={active:true,threadId,container,native:null,journal:null,blocked:new Map(),failed:false};const owned=record;
    const dispose=()=>{if(!owned.active)return;owned.active=false;restore();for(const [native,journal] of owned.blocked)restoreNode(native,journal);owned.blocked.clear();container.remove();for(const event of events)container.removeEventListener(event,stop);record=null;changed();};
    owned.dispose=dispose;
    try{reconcile();if(!owned.native)throw workspaceError('workspace_control_unsupported','Native permission trigger is not mounted');}catch(error){dispose();throw error;}
    changed();
    return Object.freeze({container,ready:Promise.resolve(),updateBinding(value){check();live();if(!owned.active)throw workspaceError('workspace_retired','Composer control retired');owned.threadId=options(value);reconcile();changed();return Promise.resolve();},dispose});
  }
  return {acquire,reconcile,dispose(){disposed=true;record?.dispose();}};
}
