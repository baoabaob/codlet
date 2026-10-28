import { workspaceError, activityPlacement, providersFor, wrapProviders } from './workspace-dom.js';

function options(value,previous={pressed:false,disabled:false,shortcut:null}) {
  if(!value||typeof value!=='object'||Object.keys(value).some(key=>!['id','label','icon','shortcut','pressed','disabled','onInvoke'].includes(key)))throw workspaceError('invalid_argument','Invalid native action options');
  const next={...previous,...value};
  if(!/^[\w.-]{1,64}$/.test(next.id??'')||typeof next.label!=='string'||!next.label||next.label.length>128||typeof next.onInvoke!=='function'||typeof next.pressed!=='boolean'||typeof next.disabled!=='boolean'||next.shortcut!=null&&(typeof next.shortcut!=='string'||next.shortcut.length>128))throw workspaceError('invalid_argument','Invalid native action identity or state');
  if(!next.icon||!Array.isArray(next.icon.paths)||!next.icon.paths.length||next.icon.paths.length>16||next.icon.paths.some(path=>typeof path!=='string'||path.length>8192||!/^[\w\s.,+\-]+$/.test(path))||typeof(next.icon.viewBox??'0 0 24 24')!=='string')throw workspaceError('invalid_argument','Native action requires filled SVG paths');
  return next;
}
export function createWorkspaceActions({document,load,activity,check,report}) {
  const records=new Set();let prepared,disposed=false;
  function ensure(){if(!prepared){const pending=Promise.resolve().then(load).then(value=>{if(disposed)throw workspaceError('workspace_retired','Native action provider retired');return value;}).finally(()=>{if(prepared===pending)prepared=null;});prepared=pending;}return prepared;}
  function render(record) {
    if(record.disposed||record.failed||!record.native)return;
    const N=record.native,R=N.React,h=R.createElement,opts=record.options,placement=activityPlacement(activity());
    if(!placement)return;
    check();record.live();
    const providers=providersFor(placement.button);
    if(record.button!==placement.button||providers.length!==record.providers?.length||providers.some(([type,value],index)=>record.providers[index][0]!==type||record.providers[index][1]!==value)){
      record.providers=providers;record.button=placement.button;record.dirty=true;
    }
    if(!record.root){record.Commit=function(){R.useLayoutEffect(()=>record.resolve());return null;};record.root=N.Client.createRoot(record.container,{onUncaughtError:record.fail,onCaughtError:record.fail});}
    let sibling=record.container.nextSibling;while(sibling?.nodeType===1&&sibling.matches('[data-codlet-workspace-owned]'))sibling=sibling.nextSibling;
    if(record.container.parentElement!==placement.parent||sibling!==placement.anchor)placement.anchor.before(record.container);
    if(!record.dirty)return;record.dirty=false;
    const reference=placement.button.querySelector('svg'),computed=reference&&document.defaultView.getComputedStyle(reference);
    const icon=h('svg',{'aria-hidden':true,'data-no-autosize':true,viewBox:opts.icon.viewBox??'0 0 24 24',width:computed?.width??'16px',height:computed?.height??'16px',fill:'currentColor',className:reference?.getAttribute('class')?.split(/\s+/).filter(name=>name.startsWith('_Icon_')).join(' ')},...opts.icon.paths.map((path,index)=>h('path',{key:index,d:path})));
    const control=h(N.Button,{'aria-label':opts.label,'aria-pressed':opts.pressed,'data-codlet-workspace-action':opts.id,color:'secondary',variant:'ghost',pill:false,uniform:true,size:'md',iconSize:'sm',selected:opts.pressed,disabled:opts.disabled,onClick:()=>{if(record.disposed||record.options.disabled)return;try{check();record.live();Promise.resolve(record.options.onInvoke()).catch(report);}catch(error){report(error);}}},icon);
    const tree=h(N.Tooltip,{tooltipContent:opts.label,shortcut:opts.shortcut,side:'bottom',variant:'tooltip',cloneCustomTrigger:false,closeOnTriggerClick:true},control);
    record.root.render(wrapProviders(N,record.providers,h(R.Fragment,null,tree,h(record.Commit))));
  }
  function attempt(record){try{render(record);}catch(error){if(['workspace_host_pending','ui_host_pending'].includes(error.code))return;record.fail(error);}}
  function register(value,owner,live){
    check();if(records.size>=64)throw workspaceError('resource_limit','Too many native actions');
    const record={options:options(value),disposed:false,dirty:true,live};
    if([...records].some(other=>other.owner===owner&&other.options.id===record.options.id))throw workspaceError('duplicate_action','Native action already registered');record.owner=owner;
    let resolve,reject;const ready=new Promise((yes,no)=>{resolve=yes;reject=no;});ready.catch(()=>{});record.resolve=resolve;record.reject=reject;record.fail=error=>{record.failed=true;reject(error);report(error);};
    record.container=document.createElement('span');record.container.dataset.codletWorkspaceOwned=owner;record.container.style.display='contents';records.add(record);
    ensure().then(value=>{if(!record.disposed){record.native=value;attempt(record);}},record.fail).catch(record.fail);
    return Object.freeze({ready,
      update(partial){live();if(record.disposed)throw workspaceError('workspace_retired','Native action retired');if(partial?.id!=null&&partial.id!==record.options.id)throw workspaceError('invalid_argument','Native action identity cannot change');record.options=options(partial,record.options);record.dirty=true;queueMicrotask(()=>attempt(record));},
      dispose(){if(record.disposed)return;record.disposed=true;records.delete(record);reject(workspaceError('workspace_retired','Native action retired before readiness'));if(record.root)record.native.DOM.flushSync(()=>record.root.unmount());record.container.remove();},
    });
  }
  return{register,
    displaced(mutations){return [...records].some(record=>!record.disposed&&mutations.some(mutation=>[...mutation.removedNodes].some(node=>node===record.container||node.contains?.(record.container)||node===record.button||node.contains?.(record.button))));},
    reconcile(){for(const record of records)attempt(record);},dispose(){disposed=true;for(const record of records){record.disposed=true;record.reject(workspaceError('workspace_retired','Native action provider retired'));if(record.root)record.native.DOM.flushSync(()=>record.root.unmount());record.container.remove();}records.clear();}};
}
