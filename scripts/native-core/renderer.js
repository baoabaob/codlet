// Main-world test fixture, registered only in an explicitly owned empty lab.
let dispose;
exports.activate = context => {
  if(globalThis.__codletCoreCostLab)throw Error('Core cost fixture already active');
  let ui, panel, surfaces=[],records=[],observers=0,mediaListeners=0;
  let activeCase=null,native=null,mutationObserver=null;
  let idle;
  const visibilityChanged=()=>idle?.transitions.push({ms:performance.now()-idle.started,state:document.visibilityState});
  function beginIdle(){idle={started:performance.now(),initial:document.visibilityState,transitions:[]};document.addEventListener('visibilitychange',visibilityChanged);return {initial:idle.initial,roots:records.length};}
  function endIdle(){document.removeEventListener('visibilitychange',visibilityChanged);const result={...idle,elapsedMs:performance.now()-idle.started,final:document.visibilityState};idle=null;return result;}
  const stats=values=>{const a=values.slice().sort((a,b)=>a-b),at=p=>a[Math.floor((a.length-1)*p)]??null;return {n:a.length,p50:at(.5),p95:at(.95),p99:at(.99),max:a.at(-1)??null};};
  const frame=()=>new Promise(resolve=>requestAnimationFrame(resolve));
  const visible=()=>{if(document.visibilityState!=='visible')throw Error('Owned target is not visible');};
  const frames=async()=>{visible();await frame();await frame();visible();};
  const task=()=>new Promise(resolve=>{const channel=new MessageChannel();channel.port1.onmessage=()=>{channel.port1.close();channel.port2.close();resolve();};channel.port2.postMessage(null);});
  const settle=()=>activeCase?.background?task():frames();
  function createTrackedUI(){
    // Native lazily creates its plugin-lifetime locale observer. Initialize that
    // before counting UI-owner resources; it retires with the plugin generation.
    void context.i18n;
    const MO=globalThis.MutationObserver,mm=globalThis.matchMedia;
    globalThis.MutationObserver=class extends MO{
      constructor(...args){super(...args);observers++;let closed=false;const disconnect=this.disconnect.bind(this);this.disconnect=()=>{if(!closed){closed=true;observers--;}return disconnect();};}
    };
    globalThis.matchMedia=function(...args){const m=mm.apply(this,args),add=m.addEventListener.bind(m),remove=m.removeEventListener.bind(m);const tracked=new Set();m.addEventListener=(name,fn,...rest)=>{if(name==='change'&&!tracked.has(fn)){tracked.add(fn);mediaListeners++;}return add(name,fn,...rest);};m.removeEventListener=(name,fn,...rest)=>{if(name==='change'&&tracked.delete(fn))mediaListeners--;return remove(name,fn,...rest);};return m;};
    try{return context.ui.create();}finally{globalThis.MutationObserver=MO;globalThis.matchMedia=mm;}
  }
  function snapshot(){return {visible:document.visibilityState,focused:document.hasFocus(),roots:records.length,containers:surfaces.length,ownedObservers:observers,ownedMediaListeners:mediaListeners,ownedDom:document.querySelectorAll('[data-core-cost-lab]').length,ownedUiContainers:document.querySelectorAll('[data-codlet-generation][data-codlet-official-ui="dev.core-cost"],[data-codlet-generation][data-codlet-react-ui="dev.core-cost"]').length,case:activeCase};}
  function cleanup(){
    if(idle)endIdle();
    mutationObserver?.disconnect();mutationObserver=null;
    native?.cancel?.();native=null;
    const started=performance.now();ui?.dispose();ui=null;panel?.remove();panel=null;
    records=[];surfaces=[];activeCase=null;
    return {durationMs:performance.now()-started,...snapshot()};
  }
  function EffectReceipt({record}){ui.React.useLayoutEffect(()=>{record.effects++;});return null;}
  function content(record, version){
    const R=ui.React;
    const children=Array.from({length:activeCase.items},(_,i)=>R.createElement(['pre','button','aside','p'][i%4],{key:i,'data-fixture-item':i,style:{margin:'0',padding:'1px 3px',fontSize:'11px',lineHeight:'15px',whiteSpace:'pre-wrap',fontFamily:'monospace'}},`fixture ${record.index}:${i} ${i===version%activeCase.items?'updated '+version:'fixed'}`));
    const controls=R.createElement(ui.components.Button,{size:'sm',color:'secondary'},'Fixture control');
    return R.createElement(R.Fragment,null,R.createElement(EffectReceipt,{record}),R.createElement('div',{'data-fixture-revision':version},children),ui.createPortal(controls,record.controls));
  }
  async function setup(options){
    cleanup();
    const {roots=0,items=200,mode='scheduled',style='neutral-split',background=false}=options;
    if(!background)visible();
    if(![0,1,2,4,5,8].includes(roots)||![20,200,2000].includes(items)||!['scheduled','sync'].includes(mode)||!['neutral-split','styled'].includes(style))throw Error('Unsupported fixed fixture');
    activeCase={roots,items,mode,style,background};
    panel=document.createElement('section');panel.dataset.coreCostLab='panel';
    panel.style.cssText='position:fixed;left:360px;right:20px;top:115px;bottom:145px;z-index:2147480000;background:var(--color-surface,#fff);color:var(--color-text,#222);border:1px solid #888;border-radius:10px;padding:10px;display:flex;flex-direction:column;gap:6px;pointer-events:auto;';
    const label=document.createElement('div');label.textContent=`Core 固定数据测试 · ${roots} roots / ${items} items · ${mode} / ${style}`;label.style.cssText='font:12px system-ui;flex:none';panel.append(label);
    const grid=document.createElement('div');grid.style.cssText=`display:grid;grid-template-columns:repeat(${Math.min(4,Math.max(1,roots))},minmax(0,1fr));grid-auto-rows:minmax(0,1fr);gap:6px;min-height:0;flex:1`;panel.append(grid);document.body.append(panel);
    if(roots)ui=createTrackedUI();
    const initial=[];
    for(let i=0;i<roots;i++){
      const shell=document.createElement('div');shell.style.cssText='min-height:0;min-width:0;border:1px solid #aaa;display:flex;flex-direction:column;overflow:hidden';grid.append(shell);
      const node=ui.container(shell,{styled:style==='styled'});surfaces.push(node);node.style.cssText+=';overflow:auto;min-height:0;flex:1;';
      const controls=ui.container(shell,{styled:true});surfaces.push(controls);controls.style.cssText+=';flex:none;';
      const record={index:i,node,controls,version:1,committed:0,effects:0,waiters:new Map(),times:new Map(),commits:[],coalesced:0};
      const firstContent=content(record,0),started=performance.now();
      record.root=ui.mountReact(node,firstContent,{sync:mode==='sync',overlay:controls,scope:{contains:target=>shell.contains(target)},onCommit:revision=>{
        const now=performance.now();record.committed=revision;if(revision===1)initial.push(now-started);
        if(record.times.has(revision))record.commits.push(now-record.times.get(revision));
        for(const key of record.times.keys())if(key<=revision){if(key<revision)record.coalesced++;record.times.delete(key);}
        for(const [key,resolve] of record.waiters)if(key<=revision){record.waiters.delete(key);resolve(now);}
      }});records.push(record);
    }
    await Promise.all(records.map(r=>committed(r,1)));await settle();
    return {...snapshot(),initialCommit:stats(initial),styleBoundary:records.every(r=>style==='styled'||!r.node.closest('[data-codlet-official-ui]'))};
  }
  function committed(record,revision){return record.committed>=revision?Promise.resolve(performance.now()):new Promise(resolve=>record.waiters.set(revision,resolve));}
  async function runCase(options){
    if(!activeCase)throw Error('No fixture');if(!activeCase.background)visible();
    const samples=options.samples??30;if(samples<1||samples>60)throw Error('Sample bound');
    const request=[],construction=[],framesAfterCommit=[],visibleCompletion=[],intervals=[],longTasks=[];let raf,previous;
    const startingVisibility=document.visibilityState,visibilityChanges=[];
    const onVisibility=()=>visibilityChanges.push(document.visibilityState);document.addEventListener('visibilitychange',onVisibility);
    const onFrame=t=>{if(previous!=null)intervals.push(t-previous);previous=t;raf=requestAnimationFrame(onFrame);};if(!activeCase.background)raf=requestAnimationFrame(onFrame);
    const po=new PerformanceObserver(list=>{for(const entry of list.getEntries())longTasks.push(entry.duration);});po.observe({type:'longtask',buffered:false});
    records.forEach(r=>{r.commits=[];r.coalesced=0;});
    try{
      for(let sample=0;sample<samples;sample++){
        const buildStart=performance.now();
        const next=records.map(r=>content(r,r.version+1));
        construction.push(performance.now()-buildStart);
        const batchStart=performance.now();
        for(let index=0;index<records.length;index++){const r=records[index],version=r.version+1,before=performance.now();r.times.set(version,before);r.version=r.root.render(next[index]);request.push(performance.now()-before);if(r.version!==version)throw Error('Revision mismatch');}
        await Promise.all(records.map(r=>committed(r,r.version)));const afterCommit=performance.now();
        await settle();framesAfterCommit.push(performance.now()-afterCommit);visibleCompletion.push(performance.now()-batchStart);
      }
      const requests=records.reduce((n,r)=>n+r.commits.length+r.coalesced,0);
      if(requests!==request.length||records.some(r=>r.times.size))throw Error('Incomplete commits');
      longTasks.push(...po.takeRecords().map(e=>e.duration));
      return {case:activeCase,request:stats(request),fixtureConstructionPerBatch:stats(construction),commitLatency:stats(records.flatMap(r=>r.commits)),visibleFrameOpportunity:activeCase.background?null:stats(visibleCompletion),commitToTwoRaf:activeCase.background?null:stats(framesAfterCommit),frameIntervals:activeCase.background?null:stats(intervals),postedTaskCompletion:activeCase.background?stats(visibleCompletion):null,longTasks:activeCase.background?null:stats(longTasks),backgroundLongTaskObserver:activeCase.background?stats(longTasks):null,coalesced:records.reduce((n,r)=>n+r.coalesced,0),cancelled:0,domRevisionsMatch:records.every(r=>Number(r.node.querySelector('[data-fixture-revision]')?.getAttribute('data-fixture-revision'))===r.version),startingVisibility,visibilityChanges,visibility:document.visibilityState,focused:document.hasFocus()};
    }finally{cancelAnimationFrame(raf);po.disconnect();document.removeEventListener('visibilitychange',onVisibility);}
  }
  async function theme(){
    if(!activeCase?.background)visible();const styled=surfaces.filter(n=>n.hasAttribute('data-codlet-official-ui'));const writes=[];
    mutationObserver=new MutationObserver(entries=>writes.push(...entries));styled.forEach(n=>mutationObserver.observe(n,{attributes:true}));
    const sentinel=document.createElement('style');document.head.append(sentinel);await settle();writes.length=0;
    const repeated=[];for(let i=0;i<30;i++){const before=performance.now();sentinel.textContent=`/* Core test notification ${i} */`;await Promise.resolve();await Promise.resolve();repeated.push(performance.now()-before);}
    await settle();const sameSignatureWrites=writes.length;writes.length=0;
    let creationMs=null,existingWritesOnCreate=0;
    if(ui){const before=performance.now(),extra=ui.container(panel);creationMs=performance.now()-before;await settle();existingWritesOnCreate=writes.length;ui.removeContainer(extra);}
    const old=document.documentElement.getAttribute('data-theme'),wasDark=document.documentElement.classList.contains('dark');const changes=[];writes.length=0;
    try{for(let i=0;i<10;i++){const target=i%2?'light':'dark',before=performance.now();document.documentElement.classList.toggle('dark',target==='dark');document.documentElement.setAttribute('data-theme',target);await settle();changes.push({target,ms:performance.now()-before,themes:styled.map(n=>n.dataset.theme)});}}
    finally{document.documentElement.classList.toggle('dark',wasDark);if(old==null)document.documentElement.removeAttribute('data-theme');else document.documentElement.setAttribute('data-theme',old);sentinel.remove();await settle();mutationObserver.disconnect();mutationObserver=null;}
    return {case:activeCase,sameSignatureWrites,repeatedNotificationTaskMs:stats(repeated),newContainerCreateMs:creationMs,existingWritesOnCreate,themeFrameOpportunityMs:activeCase.background?null:stats(changes.map(x=>x.ms)),themePostedTaskMs:activeCase.background?stats(changes.map(x=>x.ms)):null,themeReceipts:changes,changedThemeAttributeWrites:writes.length};
  }
  async function lifecycle(){
    await setup({roots:8,items:20,mode:'scheduled',style:'neutral-split',background:true});
    records.forEach(r=>{r.commits=[];r.coalesced=0;});
    for(let i=0;i<25;i++)for(const r of records){const version=r.version+1;r.times.set(version,performance.now());r.version=r.root.render(content(r,version));}
    await Promise.all(records.map(r=>committed(r,r.version)));await task();
    const committedCount=records.reduce((n,r)=>n+r.commits.length,0),coalesced=records.reduce((n,r)=>n+r.coalesced,0);
    if(committedCount+coalesced!==200)throw Error('Burst accounting failed');
    const saved=records.slice(),before=saved.map(r=>r.committed);
    for(const r of saved)r.version=r.root.render(content(r,r.version+1));
    const released=cleanup();await task();await task();
    if(saved.some((r,i)=>r.committed!==before[i]))throw Error('A cancelled render committed after unmount');
    return {burstRequests:200,commits:committedCount,coalesced,cancelledPending:saved.length,lateCommits:0,released};
  }
  function drainReact(){const temporary=createTrackedUI();try{temporary.flushSync(()=>{});}finally{temporary.dispose();}return snapshot();}
  function armNative(options){
    native?.cancel?.();const {label}=options;
    if(label!=='sidebar')throw Error('Only audited sidebar controls are allowed');
    const button=[...document.querySelectorAll('button')].find(b=>['隐藏侧边栏','显示侧边栏'].includes(b.getAttribute('aria-label'))&&!panel?.contains(b));
    if(!button)throw Error('Audited native control missing');const rect=button.getBoundingClientRect();if(!rect.width||!rect.height)throw Error('Native control hidden');
    const sample={done:false,trusted:null,clickToMutationMs:null,clickToTwoRafMs:null,mutations:0,stressFrames:0,beforeExpanded:button.getAttribute('aria-expanded')};native=sample;let started,mo,stressRaf;
    const stress=()=>{if(sample.done)return;sample.stressFrames++;for(const r of records){const version=r.version+1;r.version=r.root.render(content(r,version));}stressRaf=requestAnimationFrame(stress);};
    if(options.stress)stressRaf=requestAnimationFrame(stress);
    const click=e=>{started=performance.now();sample.trusted=e.isTrusted;mo=new MutationObserver(entries=>{sample.mutations+=entries.length;if(sample.clickToMutationMs==null&&button.getAttribute('aria-expanded')!==sample.beforeExpanded)sample.clickToMutationMs=performance.now()-started;});mo.observe(button,{attributes:true,attributeFilter:['aria-expanded']});frames().then(()=>{sample.clickToTwoRafMs=performance.now()-started;sample.afterExpanded=button.getAttribute('aria-expanded');sample.done=true;mo.disconnect();cancelAnimationFrame(stressRaf);});};
    button.addEventListener('click',click,{once:true,capture:true});sample.cancel=()=>{button.removeEventListener('click',click,true);mo?.disconnect();cancelAnimationFrame(stressRaf);};
    return {x:rect.x+rect.width/2,y:rect.y+rect.height/2,label};
  }
  globalThis.__codletCoreCostLab={setup,runCase,theme,lifecycle,drainReact,cleanup,status:snapshot,beginIdle,endIdle,armNative,nativeResult:()=>native?{done:native.done,trusted:native.trusted,clickToMutationMs:native.clickToMutationMs,clickToTwoRafMs:native.clickToTwoRafMs,mutations:native.mutations,stressFrames:native.stressFrames,beforeExpanded:native.beforeExpanded,afterExpanded:native.afterExpanded}:null};
  dispose=()=>{cleanup();delete globalThis.__codletCoreCostLab;};context.onDeactivate(dispose);
};
exports.deactivate=()=>dispose?.();
