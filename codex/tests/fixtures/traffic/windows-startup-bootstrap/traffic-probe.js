(async()=>{
  const module=await import('app://-/assets/app-shared-c568b0b98683.js');
  const root=document.getElementById('root'),key=root&&Object.keys(root).find(k=>k.startsWith('__reactContainer$'));
  const container=root?.[key],pending=[container?.stateNode?.current??container],seen=new Set();let scope;
  while(pending.length&&seen.size<20000){const f=pending.pop();if(!f||seen.has(f))continue;seen.add(f);const chain=f.memoizedProps?.value;
    if(chain instanceof Map&&chain.get(module.tSt?.id)?.token===module.tSt){scope={node:chain.get(module.tSt.id),chain};break;}
    if(f.sibling)pending.push(f.sibling);if(f.child)pending.push(f.child);
  }
  const consumer=globalThis.__codletCompatConsumer;
  if(consumer&&scope&&!globalThis.__codletTrafficResearch){
    const report=globalThis.__codletTrafficResearch={done:false};
    const wait=async predicate=>{for(let i=0;i<400;i++){if(await predicate())return;await new Promise(resolve=>setTimeout(resolve,50));}throw Error('fixture timeout');};
    const run=async(name,fn)=>{report.stage=name;report[name]=await fn();};
    (async()=>{
      await run('before',()=>consumer.request('codlet.compat.fixture','status'));
      const {baseUrl}=report.before;
      await run('desktop',async()=>{const values=[];for(const progress of [false,true]){
        const response=await module.nht({url:baseUrl+'/desktop/'+(progress?'progress':'fetch'),method:'POST',body:'codlet-original-request',headers:{'content-type':'text/plain'}},AbortSignal.timeout(6000),progress?()=>{}:undefined);
        values.push({progress,status:response.status,modified:await response.text()==='codlet-modified-response'});
      }return values;});
      const manager=module._C.read(scope.node,scope.chain,'local'),notifications=[];
      const release=manager.addNotificationCallback(['turn/completed'],event=>notifications.push(event));
      try{
        const thread=await manager.sendRequest('thread/start',{approvalPolicy:'never',sandbox:'read-only',baseInstructions:'Local synthetic transport research. No tools.'});
        report.turns=[];
        for(let index=0;index<2;index++){
          report.stage='turn-'+index;
          const result=await manager.sendRequest('turn/start',{threadId:thread.thread.id,input:[{type:'text',text:'Reply from the isolated traffic fixture.',text_elements:[]}]});
          await wait(()=>notifications.some(e=>e.params?.turn?.id===result.turn.id));
          const turn=notifications.find(e=>e.params?.turn?.id===result.turn.id).params.turn;
          report.turns.push({completed:turn.status==='completed',modified:turn.items.some(item=>item.type==='agentMessage'&&item.text==='codlet-modified-response'),error:turn.error?.message});
        }
      }finally{release();}
      await run('after',()=>consumer.request('codlet.compat.fixture','status'));
      report.accepted=report.desktop.every(v=>v.status===200&&v.modified)&&report.turns.length===2&&report.turns.every(t=>t.completed&&t.modified);
      report.done=true;report.stage='complete';
    })().catch(error=>{report.error=String(error);report.done=true;});
  }
  return JSON.stringify({report:globalThis.__codletTrafficResearch,text:document.body.innerText.slice(0,500),size:[innerWidth,innerHeight]});
})()
