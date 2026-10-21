import { workspaceError, OWNED } from './workspace-dom.js';

const ACTION = 'button,a[href],input,select,textarea,[role="button"],[role="tab"],[role="menuitem"],[tabindex]';

// Native's plain and actionable title variants share these typography classes.
// Keep the title's siblings (thread actions) intact.
function headerParts(header) {
  const titles = [...header.querySelectorAll('.min-w-0.text-base.font-medium')].filter(node => !node.closest(OWNED));
  return { title: titles.length === 1 ? titles[0] : null,
    actions: [...header.querySelectorAll(ACTION)].filter(node => !node.closest(OWNED)) };
}

// Temporary presentation belongs to one caller, never to a panel model. It
// changes neither the Native route nor the saved title or permission settings.
export function createWorkspaceSelection({document,surface,snapshot,check,changed,isConfirmed}) {
  let record,disposed=false;
  function entry(node) {
    let saved=record.journal.get(node);
    if(!saved){saved={styles:new Map(),attributes:new Map()};record.journal.set(node,saved);}
    return saved;
  }
  function style(node,name,value) {
    const saved=entry(node).styles,current={value:node.style.getPropertyValue(name),priority:node.style.getPropertyPriority(name)};
    let field=saved.get(name);
    if(!field){field={...current,applied:value};saved.set(name,field);}
    else if(current.value!==field.applied||current.priority!=='important')Object.assign(field,current);
    field.applied=value;if(current.value!==value||current.priority!=='important')node.style.setProperty(name,value,'important');
  }
  function attribute(node,name,value) {
    const saved=entry(node).attributes,current=node.getAttribute(name);let field=saved.get(name);
    if(!field){field={value:current,applied:value};saved.set(name,field);}
    else if(current!==field.applied)field.value=current;
    field.applied=value;if(current!==value)node.setAttribute(name,value);
  }
  function restoreNode(node,saved) {
    for(const [name,field] of saved.styles)if(node.style.getPropertyValue(name)===field.applied&&node.style.getPropertyPriority(name)==='important')
      field.value?node.style.setProperty(name,field.value,field.priority):node.style.removeProperty(name);
    for(const [name,field] of saved.attributes)if(node.getAttribute(name)===field.applied)
      field.value==null?node.removeAttribute(name):node.setAttribute(name,field.value);
  }
  function restore() {
    if(!record)return;
    for(const [node,saved] of record.journal)restoreNode(node,saved);
    record.journal.clear();record.actions.clear();record.label?.remove();record.label=null;
    record.stopEvents?.();record.stopEvents=null;
  }
  function options(value,previous={threadId:null,emptyLabel:'No conversation selected'}) {
    if(!value||typeof value!=='object'||Array.isArray(value)||Object.keys(value).some(key=>!['threadId','emptyLabel'].includes(key)))throw workspaceError('invalid_argument','Invalid selection presentation');
    const next={...previous,...value};
    if(next.threadId!==null&&(typeof next.threadId!=='string'||!/^\w[\w-]{0,255}$/.test(next.threadId))||typeof next.emptyLabel!=='string'||!next.emptyLabel.length||next.emptyLabel.length>128)
      throw workspaceError('invalid_argument','Invalid selected identity or heading label');
    if(next.threadId!==null&&(snapshot().threadId!==next.threadId||isConfirmed&&!isConfirmed(next.threadId)))throw workspaceError('workspace_selection_not_confirmed','Native input does not match the selected identity');
    return next;
  }
  function reconcile() {
    if(!record?.active)return;
    const header=surface()?.header;
    if(record.header!==header){restore();record.header=header;}
    if(record.options.threadId!==null&&snapshot().threadId===record.options.threadId&&(!isConfirmed||isConfirmed(record.options.threadId))){restore();return;}
    if(!header?.isConnected)return;
    const {title,actions}=headerParts(header),retained=new Set(actions);if(title)retained.add(title);
    for(const [node,saved] of record.journal)if(!retained.has(node)){restoreNode(node,saved);record.journal.delete(node);}
    record.actions=new Set(actions);
    if(title){style(title,'visibility','hidden');style(title,'min-width','8em');attribute(title,'aria-hidden','true');}
    for(const node of actions){
      // Native disabled state covers buttons and form controls; inert and event
      // interception also cover anchors and custom actionable nodes.
      if('disabled' in node)attribute(node,'disabled','');
      attribute(node,'aria-disabled','true');attribute(node,'inert','');
      style(node,'pointer-events','none');
      if(!actions.some(parent=>parent!==node&&parent.contains(node)))style(node,'opacity','0.45');
    }
    if(!record.stopEvents){
      const events=['click','dblclick','auxclick','contextmenu','keydown'];
      const block=event=>{if(record?.header===header&&[...record.actions].some(node=>node===event.target||node.contains(event.target))){event.preventDefault();event.stopImmediatePropagation();}};
      for(const name of events)header.addEventListener(name,block,true);
      record.stopEvents=()=>{for(const name of events)header.removeEventListener(name,block,true);};
    }
    if(!record.label){record.label=document.createElement('span');record.label.dataset.codletWorkspaceOwned=record.owner;record.label.style.cssText='position:absolute;pointer-events:none;overflow:hidden;text-overflow:ellipsis;white-space:nowrap;transform:translateY(-50%);font-size:var(--text-base,16px);font-weight:500;';header.append(record.label);}
    if(record.label.parentElement!==header)header.append(record.label);
    if(record.label.textContent!==record.options.emptyLabel)record.label.textContent=record.options.emptyLabel;
    const headerRect=header.getBoundingClientRect(),titleRect=title?.getBoundingClientRect();
    const geometry={left:Math.max(8,titleRect?titleRect.left-headerRect.left:16)+'px',
      top:(titleRect?titleRect.top-headerRect.top+titleRect.height/2:headerRect.height/2)+'px',
      maxWidth:Math.max(0,titleRect?.width||headerRect.width-32)+'px'};
    for(const [key,value] of Object.entries(geometry))if(record.label.style[key]!==value)record.label.style[key]=value;
  }
  function acquire(value,owner,live) {
    check();live();if(disposed)throw workspaceError('workspace_retired','Selection presentation provider retired');
    if(record?.active)throw workspaceError('workspace_presentation_owned','Native heading presentation already has an owner');
    record={active:true,owner,options:options(value),journal:new Map(),actions:new Set(),header:null,label:null,stopEvents:null};const owned=record;reconcile();changed();
    return Object.freeze({update(value){check();live();if(!owned.active)throw workspaceError('workspace_retired','Selection presentation retired');owned.options=options(value,owned.options);reconcile();changed();},
      dispose(){if(!owned.active)return;owned.active=false;restore();record=null;changed();}});
  }
  return {acquire,reconcile,displaced(mutations){return !!record?.label&&mutations.some(mutation=>[...mutation.removedNodes].some(node=>node===record.label||node.contains?.(record.label)));},dispose(){disposed=true;if(record){record.active=false;restore();record=null;}}};
}
