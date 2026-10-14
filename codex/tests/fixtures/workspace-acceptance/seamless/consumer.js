const capability={name:'workspace.seamless.audit',api:1,scope:'target'},symbol=Symbol.for('codlet.workspace.seamless.result');
let audit,workspace,slot,navigation,action,lease;
export function activate(context){audit={phase:'idle',inspect:()=>({available:true,phase:audit.phase,result:audit.result}),run};globalThis[symbol]=audit;
 async function run(){if(audit.phase!=='idle')return;audit.phase='connecting';const phases=[],switches=[];let original;
  try{
   const access=await context.rpc.request(capability,'getApi',{});workspace=globalThis[Symbol.for(access.symbol)].connect(context,access.ticket);if(workspace.getSnapshot().auxiliary){audit.result={status:'auxiliary'};return;}
   original=workspace.getSnapshot().threadId;if(!original)throw Error('A selected local task is required');
   const stats=await context.rpc.request(capability,'stats',{}),ids=stats.cached.filter(thread=>thread.resumeState==='resumed').slice(0,3).map(thread=>thread.id);if(ids.length<3)throw Error('Three cached resumed tasks are required');
   slot=workspace.createSlot('workspace.overlay');const holder=document.createElement('div');holder.style.cssText='position:fixed;left:-18000px;top:0;width:480px;height:900px;display:flex;flex-direction:column;';slot.container.append(holder);
   const handles=ids.map(id=>{const box=document.createElement('div');box.style.cssText='width:480px;height:300px;min-height:300px;';holder.append(box);return{box,handle:workspace.mountTranscript(box,{threadId:id,readOnly:true,onState:state=>phases.push({id,phase:state.phase})})};});
   audit.phase='mounting';await Promise.all(handles.map(view=>view.handle.ready));
   const before=handles.map(view=>({scroller:view.box.querySelector('.thread-scroll-container'),body:view.box.querySelector('[data-thread-find-target="conversation"]')}));for(const view of handles)view.handle.setScrollPosition({top:-31,left:0});
   const readyStats=await context.rpc.request(capability,'stats',{}),readyPhases=phases.length;
   action=workspace.registerAction({id:'audit-action',label:'Adapter audit action',icon:{paths:['M3 3H21V21H3Z M5 5V19H11V5Z M13 5V19H19V5Z'],viewBox:'0 0 24 24'},shortcut:'Ctrl+Alt+Shift+F11',onInvoke(){audit.invoked=(audit.invoked??0)+1;}});await action.ready;
   const button=document.querySelector('[data-codlet-workspace-action="audit-action"]');button.click();action.update({pressed:true});
   const actionStyle=getComputedStyle(button),rect=button.getBoundingClientRect();audit.action={invoked:audit.invoked,width:rect.width,height:rect.height,borderRadius:actionStyle.borderRadius,tooltipAncestor:!!button.closest('[aria-describedby]'),parentClass:button.parentElement.className};
   const nativeActivity=[...document.querySelectorAll('#root button')].find(node=>node!==button&&node.getAttribute('aria-label')?.startsWith('查看活动'));audit.action.nativeWidth=nativeActivity?.getBoundingClientRect().width;audit.action.nativeHeight=nativeActivity?.getBoundingClientRect().height;audit.action.insideNativeTrigger=!!nativeActivity?.parentElement.contains(button);
   button.dispatchEvent(new PointerEvent('pointerover',{bubbles:true,pointerType:'mouse',clientX:rect.x+3,clientY:rect.y+3}));button.dispatchEvent(new PointerEvent('pointermove',{bubbles:true,pointerType:'mouse',clientX:rect.x+3,clientY:rect.y+3}));
   await new Promise(resolve=>setTimeout(resolve,800));const tooltip=[...document.querySelectorAll('[role="tooltip"]')].find(node=>node.textContent.includes('Adapter audit action'));audit.action.tooltip=tooltip?{text:tooltip.textContent,background:getComputedStyle(tooltip).backgroundColor,color:getComputedStyle(tooltip).color}:null;button.dispatchEvent(new PointerEvent('pointerout',{bubbles:true,pointerType:'mouse'}));
   navigation=workspace.createNavigation();await navigation.ready;lease=workspace.acquireSurface({composerEnabled:false});audit.phase='switching';
   for(const id of [...ids.filter(id=>id!==original).slice(0,2),original]){
    const start=performance.now(),operation=navigation.open({threadId:id}),syncMs=performance.now()-start;const executed=await operation.executed,executedMs=performance.now()-start,committed=await operation.committed,committedMs=performance.now()-start;
    if(executed.threadId!==id||committed.threadId!==id||workspace.getSnapshot().threadId!==id)throw Error('Native route/input confirmation mismatch');switches.push({id,syncMs,executedMs,committedMs,receipt:committed});operation.dispose();
   }
   const afterStats=await context.rpc.request(capability,'stats',{}),retained=handles.every((view,index)=>view.box.querySelector('.thread-scroll-container')===before[index].scroller&&view.box.querySelector('[data-thread-find-target="conversation"]')===before[index].body),loadingAgain=phases.slice(readyPhases).some(state=>state.phase==='loading');
   audit.result={status:retained&&!loadingAgain&&afterStats.roots===readyStats.roots&&afterStats.flushes===readyStats.flushes?'passed':'failed',switches,phases,retained,loadingAgain,readyStats,afterStats,action:audit.action,bodyLengths:before.map(view=>view.body?.textContent.trim().length??0),scrolls:handles.map(view=>view.handle.getScrollPosition()),restored:workspace.getSnapshot().threadId===original};
  }catch(error){audit.result={status:'failed',phase:audit.phase,code:error.code,message:error.message,switches,phases};if(original&&navigation)try{const op=navigation.open({threadId:original});await op.executed;}catch{}}
  finally{lease?.dispose();action?.dispose();navigation?.dispose();workspace?.dispose();audit.phase='done';}
 }
}
export function deactivate(){lease?.dispose();action?.dispose();navigation?.dispose();workspace?.dispose();if(globalThis[symbol]===audit)delete globalThis[symbol];audit=null;}
