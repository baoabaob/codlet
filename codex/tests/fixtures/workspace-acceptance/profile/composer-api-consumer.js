const capability={name:'workspace.composer.audit',api:1,scope:'target'},symbol=Symbol.for('codlet.workspace.composer.api.result');
let audit,workspace;
export function activate(context){audit={phase:'idle',inspect:()=>({available:true,phase:audit.phase,result:audit.result,backup:audit.backup}),run,confirmBackup(){audit.confirm?.();audit.confirm=null;}};globalThis[symbol]=audit;
 async function run({threadIds=[],draftTest=false}={}){audit.phase='connecting';const saved=[],samples=[],switches=[],views=[];let originalInput,originalEditable,originalEditor,edited=false,restored=false;
  async function restoreAll(){for(const entry of saved.filter(v=>!v.primary))restore(entry);for(const entry of saved.filter(v=>v.primary))restore(entry);await new Promise(resolve=>setTimeout(resolve,1000));restored=true;}
  try{
   if(threadIds.length!==2||threadIds.some(id=>!/^[-\w]{8,256}$/.test(id)))throw Error('Pass exactly two explicit local test threadIds');
   const access=await context.rpc.request(capability,'getApi',{});workspace=globalThis[Symbol.for(access.symbol)].connect(context,access.ticket);if(workspace.getSnapshot().auxiliary){audit.result={status:'auxiliary'};return;}
   const original=workspace.getSnapshot().threadId;originalInput=workspace.getSurface().composer.element;originalEditable=originalInput.querySelector('[contenteditable="true"]');originalEditor=editorFor(originalInput,originalEditable);if(originalEditor)saved.push({editor:originalEditor,state:originalEditor.state,primary:true});
   const slot=workspace.createSlot('workspace.overlay'),holder=document.createElement('div');holder.style.cssText='position:fixed;left:-17000px;top:0;width:600px;';slot.container.append(holder);
   for(const threadId of [...new Set([...threadIds,original])]){
    const box=document.createElement('div');box.style.cssText='width:600px;height:auto;';holder.append(box);const start=performance.now(),handle=workspace.mountComposer(box,{threadId});const ready=await handle.ready,editable=box.querySelector('[contenteditable="true"]'),footer=box.querySelector('[data-thread-scroll-footer]'),editor=editorFor(box,editable);
    if(editor)saved.push({editor,state:editor.state,threadId});views.push({threadId,box,handle,editable,editor});samples.push({threadId,readyMs:performance.now()-start,ready,containerHeight:box.getBoundingClientRect().height,footerHeight:footer?.getBoundingClientRect().height,editorFound:!!editor,distinctFromPrimary:editable!==originalEditable});
   }
   const draft={attempted:draftTest&&views.every(v=>v.editor)&&!!originalEditor};
   if(draft.attempted){
    audit.backup={documents:saved.map(entry=>({threadId:entry.threadId??original,primary:!!entry.primary,doc:entry.state.doc.toJSON()}))};audit.phase='backup';let backupTimer;try{await new Promise((resolve,reject)=>{audit.confirm=resolve;backupTimer=setTimeout(()=>reject(Error('Durable draft backup was not acknowledged')),10000);});}finally{clearTimeout(backupTimer);audit.backup=null;}edited=true;
    const a='Codlet local draft A — restore after audit',b='Codlet local draft B — restore after audit\nSecond line\nThird line\nFourth line\nFifth line\nSixth line';
    writeDraft(views[0].editor,a);writeDraft(views[1].editor,b);await new Promise(resolve=>setTimeout(resolve,150));
    draft.aNonempty=views[0].editor.state.doc.textContent===a;draft.bNonempty=views[1].editor.state.doc.textContent.replaceAll('\n','')===b.replaceAll('\n','');draft.separate=views[0].editor.state.doc.textContent!==views[1].editor.state.doc.textContent;draft.primaryUnchanged=originalEditor.state.doc.eq(saved.find(v=>v.primary).state.doc);draft.grownContainerHeight=views[1].box.getBoundingClientRect().height;draft.grownFooterHeight=views[1].box.querySelector('[data-thread-scroll-footer]').getBoundingClientRect().height;draft.footerHeights=[...views[1].box.querySelectorAll('[data-thread-scroll-footer]')].map(node=>({height:node.getBoundingClientRect().height,containsInput:node.contains(views[1].editable)}));
   }
   audit.phase='switching';
   for(let repeat=0;repeat<2;repeat++)for(const view of views){for(const other of views)other.box.hidden=other!==view;const start=performance.now(),receipt=await view.handle.activate(),commitMs=performance.now()-start,focusStart=performance.now(),focused=view.handle.focus();switches.push({threadId:view.threadId,commitMs,focusMs:performance.now()-focusStart,focused,receipt,route:workspace.getSnapshot().threadId,retained:view.box.querySelector('[contenteditable="true"]')===view.editable});}
   if(edited){await restoreAll();draft.restored=saved.every(entry=>entry.editor.state.doc.eq(entry.state.doc));for(const view of views)view.handle.dispose();const reopened=[];for(const view of views){const handle=workspace.mountComposer(view.box,{threadId:view.threadId});await handle.ready;reopened.push({handle,view,editor:editorFor(view.box,view.box.querySelector('[contenteditable="true"]'))});}await new Promise(resolve=>setTimeout(resolve,600));draft.reopened=reopened.every(({view,editor})=>JSON.stringify(editor?.state.doc.toJSON())===JSON.stringify(saved.find(entry=>entry.threadId===view.threadId).state.doc.toJSON()));for(const item of reopened)item.handle.dispose();}
   audit.result={status:'passed',samples,switches,draft,routeUnchanged:workspace.getSnapshot().threadId===original,originalEditorRetained:originalInput.contains(originalEditable),distinctEditors:new Set(views.map(v=>v.editable)).size===views.length};
  }catch(error){audit.result={status:'failed',phase:audit.phase,code:error.code,message:error.message,samples,switches};}
  finally{if(edited&&!restored)try{await restoreAll();}catch{}workspace?.dispose();workspace=null;originalEditable?.focus({preventScroll:true});audit.phase='done';}
 }
}
function editorFor(container,editable){
 if(!editable)return null;const direct=editable.pmViewDesc?.view;if(direct?.state?.doc&&direct.dom===editable)return direct;
 const candidates=[container,...container.querySelectorAll('*')],roots=[];for(const node of candidates){const key=Object.keys(node).find(k=>k.startsWith('__reactContainer$'));if(key){const root=node[key];roots.push(root?.stateNode?.current??root);}}
 if(!roots.length){const key=Object.keys(container).find(k=>k.startsWith('__reactFiber$'));if(key)roots.push(container[key]);}
 const pending=[...roots],seen=new Set();while(pending.length&&seen.size<5000){const fiber=pending.pop();if(!fiber||seen.has(fiber))continue;seen.add(fiber);for(const value of Object.values(fiber.memoizedProps??{})){if(!value||typeof value!=='object')continue;try{if(value.view?.dom===editable&&value.view.state?.doc&&typeof value.view.dispatch==='function')return value.view;}catch{}}
 if(fiber.sibling)pending.push(fiber.sibling);if(fiber.child)pending.push(fiber.child);}
 return null;
}
function writeDraft(editor,text){const schema=editor.state.schema;if(!schema.nodes.paragraph)throw Error('The Native draft schema has no paragraphs');const content=text.split('\n').map(line=>schema.nodes.paragraph.create(null,line?schema.text(line):null));editor.dispatch(editor.state.tr.replaceWith(0,editor.state.doc.content.size,content).setMeta('addToHistory',false));}
function restore({editor,state}){editor.dispatch(editor.state.tr.replaceWith(0,editor.state.doc.content.size,state.doc.content).setMeta('addToHistory',false));editor.updateState(state);}
export function deactivate(){workspace?.dispose();if(globalThis[symbol]===audit)delete globalThis[symbol];}
