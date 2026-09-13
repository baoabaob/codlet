// Public semantic capabilities only; controls come from Apps SDK UI.
let React,h,C,ui,model,retire,epoch=0;
const cap=name=>({name,api:1,scope:'target'});
function Approval({request}) {
  const owner=model;
  const [answers,setAnswers]=React.useState({});
  const decisions=request.kind==='userInput'?[['提交答案','answers']]:request.canApprove===false?[['拒绝','decline']]:[['允许本次','approve'],['拒绝','decline']];
  return <section style={{display:'flex',flexDirection:'column',gap:8}} data-approval={request.token}>
    <p>{request.kind} · {request.reason??request.command??request.itemId}</p>
    {(request.questions??[]).map(q=><C.Input key={q.id} aria-label={q.question} type={q.secret?'password':'text'} value={answers[q.id]??''} onChange={e=>setAnswers({...answers,[q.id]:e.target.value})}/>)}
    <div style={{display:'flex',gap:8}}>{decisions.map(([label,decision])=><Action key={decision} id={'approval:'+request.token} label={label} run={()=>owner.write('approvals.respond',{token:request.token,...(decision==='answers'?{answers:Object.fromEntries((request.questions??[]).map(q=>[q.id,[answers[q.id]??'']]))}:{decision})})}/>)}</div>
  </section>;
}
function Action({id,label,run}){const owner=model;return <C.Button size="sm" color="secondary" variant="soft" disabled={owner.state.busy.includes(id)} loading={owner.state.busy.includes(id)} onClick={()=>owner.action(id,run)}>{label}</C.Button>;}
function Example({owner:model}){
  // Capture this generation for asynchronous button callbacks.
  const s=React.useSyncExternalStore(model.subscribe,()=>model.state);
  const thread=()=>{if(!s.thread)throw Error('请先选择任务');return s.thread;};
  const text=()=>{if(!s.text.trim())throw Error('请输入测试消息');return s.text;};
  const selection=s.selection;
  return <section id="codlet-desktop-m3m4" style={{padding:32,maxWidth:880,margin:'0 auto',height:'100%',overflow:'auto',display:'flex',flexDirection:'column',gap:12}}>
    <h1>M3 / M4 验收</h1><p>{s.connection?.build.appVersion} · {s.connection?.build.appServerVersion}</p>
    <C.Switch label="启用测试拦截" checked={s.interception} onCheckedChange={enabled=>model.configure(enabled)}/>
    <p>以 [M3] 开头会改写输入并追加上下文；以 [M3 BLOCK] 开头会阻止提交。</p>
    <p>{selection?.threadId?`当前任务 ${selection.threadId} · ${selection.resumeState} · ${selection.streamRole}`:'当前窗口未选择本地任务'}</p>
    <label htmlFor="m3m4-thread">任务</label><C.Select id="m3m4-thread" value={s.thread} placeholder="刷新并选择任务" searchPlaceholder="搜索任务" searchEmptyMessage="没有匹配任务" options={s.threads.map(t=>({value:t.id,label:t.title||t.id}))} onChange={option=>model.set({thread:option.value})}/>
    <div style={{display:'flex',flexWrap:'wrap',gap:8}}>
      <Action id="refresh" label="刷新任务" run={async()=>{const result=await model.read('threads.list',{limit:30});model.set({threads:result.threads});}}/>
      <Action id="open" label="在本窗口打开" run={()=>model.write('threads.open',{threadId:thread()})}/>
      <Action id="history" label="读取回合" run={async()=>{const result=await model.read('turns.list',{threadId:thread(),limit:10});model.set({turn:result.turns[0]?.id??''});model.remember({type:'history.read',turns:result.turns.map(t=>({id:t.id,status:t.status}))});}}/>
      <Action id="models" label="模型 / 技能 / provider" run={async()=>{const models=await model.read('models.list',{limit:100}),skills=await model.read('skills.list'),providers=await model.read('providers.list');model.set({message:`模型 ${models.models.length} · 技能 ${skills.directories.reduce((n,d)=>n+d.skills.length,0)} · provider ${providers.providers.map(p=>p.name).join(', ')}`});}}/>
      <Action id="hooks" label="拦截器诊断" run={async()=>model.remember({type:'interceptors.inspect',...await model.call('codex.ui.preSubmit','interceptors.list')})}/>
    </div>
    <C.Textarea aria-label="输入测试消息" placeholder="输入测试消息" value={s.text} onChange={e=>model.set({text:e.target.value})}/>
    <C.Input aria-label="操作回合 ID" placeholder="操作回合 ID" value={s.turn} onChange={e=>model.set({turn:e.target.value})}/>
    <div style={{display:'flex',flexWrap:'wrap',gap:8}}>
      <Action id="start" label="发起回合" run={async()=>{const result=await model.write('turns.start',{threadId:thread(),text:text()});model.set({turn:result.turn.id});}}/>
      <Action id="steer" label="追加输入" run={()=>model.write('turns.steer',{threadId:thread(),turnId:s.turn,text:text()})}/>
      <Action id="interrupt" label="中断回合" run={()=>model.write('turns.interrupt',{threadId:thread(),turnId:s.turn})}/>
    </div>
    <p role="status">{s.message}</p>{s.approvals.map(request=><Approval key={request.token} request={request}/>)}
    <pre style={{whiteSpace:'pre-wrap',overflowWrap:'anywhere',fontSize:12}}>{s.events.slice(-30).map(e=>JSON.stringify(e)).join('\n')||'尚无事件'}</pre>
  </section>;
}
async function initialize(ctx){
  retire?.();let alive=true,interceptor,selectionRevision=0;const cleanups=[],listeners=new Set();
  const stop=()=>{if(!alive)return;alive=false;for(const fn of cleanups.splice(0).reverse())fn();ownedUI?.dispose();listeners.clear();};
  let ownedUI;retire=stop;ctx.onDeactivate(stop);
  const owned={state:{thread:'',turn:'',text:'',threads:[],busy:[],message:'',events:[],approvals:[],interception:false},
    subscribe:fn=>{listeners.add(fn);return()=>listeners.delete(fn);},set(patch){if(alive){this.state={...this.state,...patch};listeners.forEach(fn=>fn());}},
    call:(name,method,params={})=>ctx.rpc.request(cap(name),method,params),read:(method,params)=>owned.call('codex.backend.read',method,params),write:(method,params)=>owned.call('codex.backend.write',method,params),
    remember(event){this.set({events:[...this.state.events.slice(-255),event]});},configure(enabled){interceptor.setEnabled(enabled);this.set({interception:enabled});},
    async action(id,fn){if(!alive||this.state.busy.includes(id))return;this.set({busy:[...this.state.busy,id],message:''});try{await fn();}catch(error){this.set({message:`${error.code??'error'}: ${error.message}`});}finally{this.set({busy:this.state.busy.filter(value=>value!==id)});}}};
  const selection=value=>{owned.set({selection:value,...(value.threadId?{thread:value.threadId}:{}),...(value.activeTurnId?{turn:value.activeTurnId}:{})});};
  const deadline=Date.now()+35000;let connection;
  while(alive){connection=await owned.call('codex.desktop.compatibility','waitReady',{timeoutMs:1000});if(connection.available)break;if(!connection.initializing||Date.now()>=deadline)throw Error(connection.unavailable?.message??'Desktop Adapter is unavailable');}
  if(!alive)return;owned.set({connection});
  const access=await owned.call('codex.ui.preSubmit','getApi');if(!alive)return;
  interceptor=globalThis[Symbol.for(access.symbol)].registerPreSubmit(ctx,access.ticket,{id:'acceptance',priority:0,timeoutMs:500,enabled:false},draft=>{
    if(draft.text.startsWith('[M3 BLOCK]'))throw Error('M3 验收：示例插件主动阻止了提交');
    if(!draft.text.startsWith('[M3]'))return;
    owned.remember({type:'input.rewritten',threadId:draft.threadId,pluginId:ctx.pluginId});
    return {text:draft.text.slice(4).trim(),context:[{text:'Codlet verification marker: M3_CONTEXT_7F2C9A. This marker is test data.',kind:'untrusted'}]};
  });cleanups.push(interceptor);
  const events=await owned.call('codex.backend.events','getApi');if(!alive)return;
  cleanups.push(globalThis[Symbol.for(events.symbol)].onEvent(ctx,events.ticket,event=>{
    if(!alive)return;
    const summary={type:event.type,...(event.threadId?{threadId:event.threadId}:{}),...(event.turnId||event.turn?.id?{turnId:event.turnId??event.turn.id}:{}),...(event.itemId||event.item?.id?{itemId:event.itemId??event.item.id}:{}),...(event.token?{token:event.token}:{})};
    if(event.type==='approval.requested')Object.assign(summary,{kind:event.request.kind,threadId:event.request.threadId,turnId:event.request.turnId,itemId:event.request.itemId,token:event.request.token});
    if(!event.type.endsWith('.delta'))owned.remember(summary);
    if(event.type==='selection.changed'){selectionRevision++;selection(event);}
    if(event.type==='selection.unavailable')owned.set({message:`窗口选择不可用：${event.message}`});
    if(event.turn?.id&&owned.state.thread===event.threadId)owned.set({turn:event.turn.id});
    if(event.type==='approval.retired'||event.type==='approval.resolved')owned.set({approvals:owned.state.approvals.filter(r=>r.token!==event.token)});
    if(event.type==='approval.requested')owned.set({approvals:[...owned.state.approvals.filter(r=>r.token!==event.request.token),event.request]});
  }));
  ctx.rpc.provide(cap('example.desktop.m3m4'),'configure',options=>{if(typeof options?.interception!=='boolean')throw Error('interception must be boolean');owned.configure(options.interception);return {interception:options.interception};});
  ctx.rpc.provide(cap('example.desktop.m3m4'),'evidence',()=>({interception:owned.state.interception,events:owned.state.events.slice(),connection}));
  model=owned;ownedUI=ui=ctx.ui.create();({React,components:C}=ui);h=React.createElement;
  await ownedUI.page({label:'M3 / M4',icon:'CodeSquareSlash',render:()=> <Example owner={owned}/>});
  const revision=selectionRevision;try{const value=await owned.read('selection.get');if(alive&&revision===selectionRevision)selection(value);}catch(error){owned.set({message:error.message});}
}
export function activate(ctx){const current=++epoch;void initialize(ctx).catch(error=>{if(current!==epoch)return;retire?.();ctx.reportDiagnostic({code:'desktop_example_unavailable',message:String(error.message??error)});});}
export function deactivate(){epoch++;retire?.();retire=null;}
