'use strict';
// Extends the original 0.0.1 consumer with plugin-owned service checks.
let cleanup;
const SYMBOL=Symbol.for('codlet.functional.acceptance');
const cap=(name,scope='target')=>({name,api:1,scope});
const assert=(condition,message)=>{if(!condition)throw Error(message);};
async function openDraftWhenReady(ask,isAlive,params,timeoutMs=12000){
  const deadline=Date.now()+timeoutMs;let pending;
  while(isAlive()){
    const remaining=deadline-Date.now();if(remaining<=0)throw pending??Error('Timed out waiting for draft navigation');
    try{return await ask('codex.ui.navigation.page','newTaskDraft',params,{timeoutMs:Math.min(10000,remaining)});}
    catch(error){
      // The adapter reports this before invoking the native draft action.
      // An uncertain timeout or another error must never replay the action.
      if(error.code!=='ui_host_pending'&&!/^ui_host_pending:/.test(error.message??''))throw error;
      pending=error;await new Promise(resolve=>setTimeout(resolve,Math.min(80,Math.max(0,deadline-Date.now()))));
    }
  }
  throw Error('Test retired');
}
module.exports.deactivate=()=>{cleanup?.();cleanup=null;};
module.exports.activate=async context=>{
  cleanup?.();if(innerWidth<480||innerHeight<400)return;
  let alive=true,running=false,page,fixtureThread,resolveThread,api;
  const disposals=[],listeners=new Set(),nodes=[];
  const state={schema:1,version:context.version,generation:context.generation,phase:'idle',checks:[],host:null,fixture:null};
  const report=document.createElement('div');report.hidden=true;report.dataset.compatibilityAcceptance='idle';document.body.append(report);nodes.push(report);
  const ask=(name,method,args={},options={})=>context.rpc.request(cap(name,name==='compatibility.acceptance.host'?'runtime':'target'),method,args,{timeoutMs:10000,...options});
  const save=()=>{if(!alive)return;report.dataset.compatibilityAcceptance=state.phase;report.textContent=JSON.stringify(state);listeners.forEach(fn=>fn());};
  const wait=async(check,timeout=12000)=>{const end=Date.now()+timeout;while(alive&&Date.now()<end){const value=await check();if(value)return value;await new Promise(resolve=>setTimeout(resolve,60));}throw Error(alive?'Timed out waiting for a test contract':'Test retired');};
  const check=async(id,fn)=>{const start=Date.now();try{const detail=await fn();state.checks.push({id,status:'passed',milliseconds:Date.now()-start,detail});return detail;}catch(error){state.checks.push({id,status:'failed',milliseconds:Date.now()-start,error:{code:error.code??'test_failed',message:error.message}});return null;}finally{save();}};
  const retire=()=>{if(!alive)return;alive=false;resolveThread?.(null);for(const dispose of disposals.splice(0).reverse())try{dispose();}catch{}page?.dispose();for(const node of nodes)node.remove();listeners.clear();if(globalThis[SYMBOL]===api)delete globalThis[SYMBOL];};
  cleanup=retire;context.onDeactivate(retire);
  const zh=context.i18n.locale.startsWith('zh'),label=zh?'功能测试':'Functional tests';
  function Panel({ui}){
    const React=ui.React,h=React.createElement,C=ui.components;
    const [,refresh]=React.useState(0);React.useEffect(()=>{const update=()=>refresh(value=>value+1);listeners.add(update);return()=>listeners.delete(update);},[]);
    const all=[...state.checks,...(state.host?.checks??[])],passed=all.filter(item=>item.status==='passed').length,failed=all.filter(item=>item.status==='failed').length,manual=all.filter(item=>item.status==='manual').length,executed=all.length-manual;
    const phase=zh?({idle:'未运行',running:'正在运行',waitingForFixtureThread:'等待独立测试任务',failed:'失败',complete:'完成'}[state.phase]??state.phase):state.phase;
    const summary=zh?`${phase} · 通过 ${passed}/${executed} · 失败 ${failed} · 未执行 ${manual}`:`${phase} · passed ${passed}/${executed} · failed ${failed} · not run ${manual}`;
    return h('section',{'data-functional-test-panel':'',style:{padding:24,display:'flex',flexDirection:'column',gap:16,maxWidth:1000,margin:'0 auto',width:'100%'}},
      h('h1',{style:{fontSize:24,fontWeight:600}},zh?'Codlet 功能测试':'Codlet functional tests'),
      h('p',null,zh?'复用原版兼容测试，并验证 Core 服务、后台通信和资源清理':'Extends compatibility checks with Core services, Host RPC and cleanup'),
      h('p',null,zh?'会创建一条未发送的测试草稿；模型调用检查仅在独立本地测试环境运行':'Creates an unsent test draft; model checks require an isolated local fixture'),
      h('div',{style:{display:'flex',gap:12,alignItems:'center'}},h(C.Button,{onClick:()=>void run(),disabled:running},zh?'运行功能测试':'Run functional tests'),h('span',{'data-functional-phase':state.phase,role:'status'},summary)),
      h('table',{style:{width:'100%',textAlign:'left',fontSize:13,borderCollapse:'collapse'}},h('thead',null,h('tr',null,h('th',{style:{padding:12}},zh?'检查':'Check'),h('th',{style:{padding:12,width:100}},zh?'结果':'Result'),h('th',{style:{padding:12}},zh?'详情':'Details'))),
        h('tbody',null,...all.map(item=>h('tr',{key:item.id,style:{borderBottom:'1px solid rgba(128,128,128,.2)'}},h('td',{style:{padding:12}},item.id),h('td',{style:{padding:12,color:item.status==='passed'?'#258045':item.status==='failed'?'#b64237':'inherit'}},item.status),h('td',{style:{padding:12,overflowWrap:'anywhere'}},item.error?.message??h('details',null,h('summary',null,zh?'查看详情':'View details'),h('pre',{style:{whiteSpace:'pre-wrap',fontSize:12,marginTop:8}},JSON.stringify(item.detail??{},null,2)))))))),
      h(C.Button,{variant:'soft',color:'secondary',onClick:()=>{const url=URL.createObjectURL(new Blob([JSON.stringify(state,null,2)],{type:'application/json'})),link=document.createElement('a');link.href=url;link.download='codlet-functional-test.json';link.click();setTimeout(()=>URL.revokeObjectURL(url),1000);}},zh?'导出报告':'Export report'));
  }
  let ownedUi;
  const createPage=context.ui.page?.bind(context.ui)??((ownedUi=context.ui.create()).page.bind(ownedUi));
  if(ownedUi)disposals.push(()=>ownedUi.dispose());
  page=await createPage({label,icon:'CodeSquareSlash',toolbar:true,render:({ui})=>ui.React.createElement(Panel,{ui})});
  if(!alive){page.dispose();return;}
  api={inspect:()=>state,pagePath:page.path,run,prepareFixture:()=>ask('compatibility.acceptance.host','native.begin'),
    supplyFixtureThread(id){if(state.fixture?.autorun&&typeof id==='string'){fixtureThread=id;resolveThread?.(id);return true;}return false;}};
  globalThis[SYMBOL]=api;
  async function backendChecks(){
    if(!state.fixture?.autorun){state.checks.push({id:'desktop.model-operations',status:'manual',detail:{reason:'Requires isolated local model fixture'}});save();return;}
    state.phase='waitingForFixtureThread';save();
    let deadline;
    const id=fixtureThread??await Promise.race([new Promise(resolve=>{resolveThread=resolve;}),new Promise((_,reject)=>{deadline=setTimeout(()=>reject(Error('Isolated fixture did not supply a test task')),20000);})]).finally(()=>clearTimeout(deadline));
    if(!id||!alive)throw Error('Test retired');
    const events=await ask('codex.backend.events','getApi'),submit=await ask('codex.ui.preSubmit','getApi');
    const stream=[];const releaseEvents=globalThis[Symbol.for(events.symbol)].onEvent(context,events.ticket,event=>stream.push(event));disposals.push(releaseEvents);
    let submitCalls=0;
    const hook=globalThis[Symbol.for(submit.symbol)].registerPreSubmit(context,submit.ticket,{id:'functional',enabled:true,timeoutMs:500},draft=>{
      if(draft.threadId===id&&draft.text.startsWith('[FUNCTIONAL]')){submitCalls++;return {text:draft.text.replace('[FUNCTIONAL]','').trim(),context:[{kind:'untrusted',text:'Synthetic functional test context'}]};}
    });disposals.push(hook);
    try{
      await check('desktop.task-open-read-and-configuration',async()=>{
        await ask('codex.backend.write','threads.open',{threadId:id});let latest;
        try{await wait(async()=>{latest=await ask('codex.backend.read','selection.get');return latest.threadId===id&&latest.resumeState==='resumed';});}
        catch(error){throw Error(error.message+' '+JSON.stringify(latest));}
        const thread=await ask('codex.backend.read','threads.get',{threadId:id}),configuration=await ask('codex.backend.read','threads.configuration',{threadId:id});assert(thread.id===id&&configuration.threadId===id,'Task identity changed');return {opened:true,provider:configuration.modelProvider};
      });
      await check('desktop.turn-start-stream-events-and-history',async()=>{
        await ask('compatibility.acceptance.host','native.begin');
        const started=await ask('codex.backend.write','turns.start',{threadId:id,text:'[FUNCTIONAL] codlet-original-request'});
        const completed=await wait(()=>stream.find(event=>event.type==='turn.completed'&&(event.turnId===started.turn.id||event.turn?.id===started.turn.id)),20000);
        assert(completed.turn?.status==='completed','Synthetic model turn failed');
        const turns=await ask('codex.backend.read','turns.list',{threadId:id,limit:10}),items=await ask('codex.backend.read','items.list',{threadId:id,limit:20});
        assert(turns.turns.some(turn=>turn.id===started.turn.id)&&items.items.length,'Turn history or items missing');
        const inspection=await ask('codex.ui.preSubmit','interceptors.list');assert(JSON.stringify(inspection).includes('functional'),'Submit hook missing');
        assert(submitCalls>0,'Submit hook did not execute');
        assert(items.items.some(item=>item.turnId===started.turn.id&&item.item.text?.includes('codlet-modified-response')),'Native model response transform did not reach history');
        const native=(await ask('compatibility.acceptance.host','inspect')).native;assert(native.request+native.clientFrames>0&&native.response+native.serverFrames>0,'Native traffic callbacks did not execute');
        return {completed:true,turns:turns.turns.length,items:items.items.length,events:stream.length,submitCalls,native};
      });
      await check('desktop.turn-steer-and-interrupt',async()=>{
        const started=await ask('codex.backend.write','turns.start',{threadId:id,text:'Interrupt this synthetic fixture turn'});
        const steered=await ask('codex.backend.write','turns.steer',{threadId:id,turnId:started.turn.id,text:'Additional fixture input'});assert(steered.turnId===started.turn.id,'Steer affected another turn');
        await ask('codex.backend.write','turns.interrupt',{threadId:id,turnId:started.turn.id});
        const completed=await wait(()=>stream.find(event=>event.type==='turn.completed'&&(event.turnId===started.turn.id||event.turn?.id===started.turn.id)),15000);assert(completed.turn?.status==='interrupted','Turn did not interrupt');return {steered:true,interrupted:true};
      });
      await check('desktop.approvals-query',async()=>{const value=await ask('codex.backend.read','approvals.list',{threadId:id});assert(Array.isArray(value.requests),'Approval schema changed');return {pending:value.requests.length,automaticApproval:false};});
    }finally{if(typeof hook==='function')hook();else hook.dispose?.();releaseEvents();}
  }
  async function run(){
    if(running||!alive)return;running=true;state.phase='running';state.checks=[];state.host=null;state.error=null;delete state.reportSaveError;save();
    try{
      const inspection=await ask('compatibility.acceptance.host','inspect');state.fixture=inspection.fixture;
      await check('renderer-host-rpc',async()=>{const value=await ask('compatibility.acceptance.host','echo',{value:{marker:'renderer'}});assert(value.value.marker==='renderer','RPC result changed');return {hostGeneration:value.hostGeneration};});
      await ask('compatibility.acceptance.host','run');
      await check('renderer-storage-and-cross-world-events',async()=>{
        const current=await context.services.storage.snapshot();assert(current.schema===1,'Storage schema changed');
        const topic=await ask('compatibility.acceptance.host','events'),subscription=await context.services.events.subscribe({topic:topic.topic,after:topic.cursor});
        try{const batch=await context.services.events.read({subscription:subscription.subscription,after:topic.cursor});assert(batch.events.some(item=>item.value.marker==='host-to-renderer'),'Host event did not reach Renderer');return {received:batch.events.length};}
        finally{await context.services.events.close({resource:subscription.subscription});}
      });
      await check('desktop.compatibility',async()=>{const ready=await ask('codex.desktop.compatibility','waitReady',{timeoutMs:10000},{timeoutMs:15000});assert(ready.available,'Desktop unavailable');return ready;});
      for(const method of ['threads.list','models.list','skills.list','providers.list'])await check('desktop.'+method,async()=>{
        const reply=await ask('codex.backend.read',method,method==='threads.list'||method==='models.list'?{limit:10}:{});return {fields:Object.keys(reply),count:(reply.threads??reply.models??reply.directories??reply.providers??[]).length};
      });
      await check('composer.action-click-and-cleanup',async()=>{
        if(!state.fixture.autorun)await openDraftWhenReady(ask,()=>alive,{prompt:'Codlet functional draft; do not submit'});
        const token=crypto.randomUUID(),lease=document.createElement('span');Object.assign(lease.dataset,{codletComposerActionLease:token,codletComposerActionOwner:context.pluginId,codletGeneration:String(context.generation)});document.body.append(lease);nodes.push(lease);
        try{await ask('codex.ui.composer.action','register',{token,label:'Functional check'});const button=await wait(()=>document.querySelector('[data-codlet-composer-action-instance="'+token+'"] button'));let clicked=false;lease.addEventListener('codlet:composer-action',()=>clicked=true,{once:true});button.click();assert(clicked,'Composer click did not reach the lease');}
        finally{await ask('codex.ui.composer.action','unregister',{token});lease.remove();}
        assert(!document.querySelector('[data-codlet-composer-action-instance="'+token+'"]'),'Composer action leaked');return {clicked:true,cleaned:true};
      });
      await check('native.page-toolbar-and-ui-controls',async()=>{
        const entry=await wait(()=>document.querySelector('[data-codlet-navigation-entry="'+context.pluginId+'"]'));entry.click();
        await wait(()=>document.querySelector('[data-functional-test-panel]'));assert(document.querySelector('[data-codlet-page-toolbar]'),'Native toolbar missing');return {page:true,toolbar:true,controls:true};
      });
      await check('native.editable-draft',async()=>{const result=await openDraftWhenReady(ask,()=>alive,{prompt:'Codlet functional draft; do not submit'});assert(result.opened&&result.submitted===false,'Draft unexpectedly submitted');return result;});
      await backendChecks();
      await wait(async()=>{const value=await ask('compatibility.acceptance.host','inspect');state.host=value.report;save();return ['complete','failed'].includes(value.report.phase);},35000);
      state.phase=[...state.checks,...state.host.checks].some(item=>item.status==='failed')?'failed':'complete';
    }catch(error){state.error={code:error.code??'test_failed',message:error.message};state.phase='failed';}
    finally{
      save();
      if(alive)try{await ask('compatibility.acceptance.host','save-report',{report:state});}
      catch(error){state.reportSaveError={code:error.code??'report_save_failed',message:error.message};}
      running=false;save();
    }
  }
  const initial=await ask('compatibility.acceptance.host','inspect');state.fixture=initial.fixture;save();
  if(initial.fixture.autorun)void run();
};
