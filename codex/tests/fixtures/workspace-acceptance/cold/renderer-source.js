import { deferredNavigation, locateHost } from '../../../../frontend/src/adapter/navigation.js';
import { createWorkspaceDiscovery } from '../../../../frontend/src/adapter/workspace-discovery.js';
import { createTranscripts } from '../../../../frontend/src/adapter/workspace-transcript.js';
import { createTranscripts as originalTranscripts } from '../../../../.artifacts/workspace-cold-probe/original-transcript.js';
import { findWorkspaceSurface } from '../../../../frontend/src/adapter/workspace-dom.js';

const symbol=Symbol.for('codlet.workspace.cold.audit');
let audit,navigation,discovery,engines=[],holders=[];
export function activate(context){
  let host;try{host=locateHost();}catch(error){globalThis[symbol]={inspect:()=>({available:false,error:error.message})};return;}
  if(host.auxiliary){globalThis[symbol]={inspect:()=>({auxiliary:true})};return;}
  navigation=deferredNavigation(context);discovery=createWorkspaceDiscovery(navigation.native);
  audit={phase:'idle',states:[],reads:[],diagnostics:[],inspect:()=>({available:true,phase:audit.phase,result:audit.result}),run};
  globalThis[symbol]=audit;
  async function run(){
    if(audit.phase!=='idle')return;audit.phase='discovering';
    const results=[];
    try{
      const native=await discovery.transcript(),manager=native.manager,route=()=>locateHost().navigator.location.pathname,before=route();
      const cold=manager.getCachedConversations().filter(thread=>thread.resumeState==='needs_resume'&&manager.getStreamRole(thread.id)==null&&before!=='/local/'+thread.id).slice(0,6);
      if(cold.length<6)throw Error('This run requires six different unselected cold cached tasks');
      for(const [kind,ids,factory]of [['original',cold.slice(0,2),originalTranscripts],['fixed',cold.slice(2),createTranscripts]]){
        audit.phase=kind;
        const N={...native,manager:new Proxy(manager,{get(target,key){const value=target[key];return ['loadBackgroundThreadHistoryPage','loadRemainingTurnItems'].includes(key)?async(...args)=>{const read={kind,method:key,threadId:args[0],started:performance.now()};audit.reads.push(read);try{return await value.apply(target,args);}finally{read.ms=performance.now()-read.started;}}:value;}})};
        const engine=factory({document,load:async()=>N,surface:()=>findWorkspaceSurface(document),check:()=>discovery.connection(),report:error=>audit.diagnostics.push({code:error.code,message:error.message})});engines.push(engine);
        const holder=document.createElement('div');holder.dataset.codletWorkspaceOwned=context.pluginId;
        holder.style.cssText='position:fixed;left:-12000px;top:0;width:440px;height:320px;display:flex;flex-direction:column;';document.body.append(holder);holders.push(holder);
        const views=ids.map(thread=>{
          const box=document.createElement('div');box.style.cssText='height:320px;min-height:320px;width:440px;';holder.append(box);
          const item={kind,id:thread.id,before:{resumeState:thread.resumeState,streamRole:manager.getStreamRole(thread.id)?.role??'none'},started:performance.now(),phase:'loading'};
          const handle=engine.mount(box,{threadId:thread.id,readOnly:true,trackReadState:false,onState:state=>{item.phase=state.phase;if(state.phase==='ready')item.readyMs=performance.now()-item.started;audit.states.push({kind,id:thread.id,phase:state.phase});}},context.pluginId+':'+kind);
          handle.ready.catch(()=>{});return {box,handle,item};
        });
        await new Promise(resolve=>{const timer=setTimeout(resolve,kind==='original'?3000:12000);if(kind==='fixed'){const done=()=>{clearTimeout(timer);resolve();};Promise.all(views.map(view=>view.handle.ready)).then(done,done);}});
        for(const {box,handle,item}of views){const body=box.querySelector('[data-thread-find-target="conversation"]');
          Object.assign(item,{bodyLength:body?.textContent.trim().length??0,scroller:!!box.querySelector('.thread-scroll-container'),after:{resumeState:manager.getConversation(item.id)?.resumeState,streamRole:manager.getStreamRole(item.id)?.role??'none'}});results.push({...item});handle.dispose();}
        engine.dispose();holder.remove();
      }
      audit.result={status:results.filter(item=>item.kind==='fixed').every(item=>item.phase==='ready'&&item.bodyLength>0&&item.before.resumeState==='needs_resume'&&item.after.resumeState==='needs_resume'&&item.after.streamRole==='none')&&route()===before?'passed':'failed',results,reads:audit.reads,diagnostics:audit.diagnostics,routeUnchanged:route()===before};
    }catch(error){audit.result={status:'failed',results,code:error.code,message:error.message,diagnostics:audit.diagnostics};}
    finally{for(const engine of engines)engine.dispose();for(const holder of holders)holder.remove();audit.phase='done';}
  }
}
export function deactivate(){for(const engine of engines)engine.dispose();for(const holder of holders)holder.remove();discovery?.dispose();navigation?.dispose();if(globalThis[symbol]===audit)delete globalThis[symbol];engines=[];holders=[];audit=navigation=discovery=null;}
