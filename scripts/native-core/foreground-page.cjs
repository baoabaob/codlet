'use strict';
// Serialized into the already-owned main world. Observation only: no clicks,
// focus, DOM/style writes, editor reads, native imports or navigation.
function installForegroundObserver(options) {
  const marker = globalThis[Symbol.for(options.markerKey)];
  if (marker?.sampleId !== options.sampleId || marker?.nonce !== options.nonce) throw Error('Owned foreground marker mismatch');
  const key = Symbol.for(options.key);
  if (globalThis[key]) throw Error('Foreground observer already installed');
  let active = null, dropped = 0;
  const supported = [...(globalThis.PerformanceObserver?.supportedEntryTypes ?? [])];
  const observers = [], errors = [];
  const box = node => { const r = node.getBoundingClientRect(); return {x:r.x,y:r.y,width:r.width,height:r.height}; };
  const describe = node => {
    if (!node || node.nodeType !== 1) return null;
    const s = getComputedStyle(node);
    return {tag:node.tagName,role:node.getAttribute('role'),rect:box(node),appRegion:s.getPropertyValue('app-region') || s.getPropertyValue('-webkit-app-region'),pointerEvents:s.pointerEvents,
      display:s.display,visibility:s.visibility,opacity:s.opacity,position:s.position,zIndex:s.zIndex,transform:s.transform,clipPath:s.clipPath,overflow:s.overflow,inert:!!node.inert,
      consumerRoot:node.hasAttribute('data-csw-root'),pane:node.hasAttribute('data-csw-id'),titlebar:node.hasAttribute('data-app-shell-titlebar'),applicationMenuBar:node.hasAttribute('data-app-shell-application-menu-bar')};
  };
  const viewport = () => ({time:performance.now(),timeOrigin:performance.timeOrigin,visibility:document.visibilityState,focused:document.hasFocus(),innerWidth,innerHeight,outerWidth,outerHeight,devicePixelRatio,
    screenX,screenY,screen:{width:screen.width,height:screen.height,availWidth:screen.availWidth,availHeight:screen.availHeight},
    visualViewport:visualViewport?{width:visualViewport.width,height:visualViewport.height,offsetLeft:visualViewport.offsetLeft,offsetTop:visualViewport.offsetTop,scale:visualViewport.scale}:null});
  const push = (kind, value) => { if (!active) return; if (active.records.length >= 2048) { dropped++; return; } active.records.push({kind,...value}); };
  const mark = (stage, time, detail = {}) => {
    if (!active || !Number.isFinite(time) || time < active.started || time > performance.now()+1) return;
    if(active.records.length>=2048){dropped++;return;}
    const name = 'codlet-fg/'+options.sampleId+'/'+active.label+'/'+stage+'/'+active.markNames.length;
    try { performance.mark(name,{startTime:time}); active.markNames.push(name); } catch (error) { errors.push(String(error.message)); }
    push('stage',{stage,time,mark:name,...detail});
  };
  const event = e => {
    if (!active || !e.isTrusted) return;
    const captured = performance.now(), raw = e.timeStamp, time = raw > 1e12 ? raw-performance.timeOrigin : raw;
    const validClock = Number.isFinite(time) && time >= active.started && time <= captured+1;
    push('input',{type:e.type,trusted:true,time:validClock?time:null,rawTimeStamp:raw,captured,validClock,
      clientX:Number.isFinite(e.clientX)?e.clientX:null,clientY:Number.isFinite(e.clientY)?e.clientY:null,
      screenX:Number.isFinite(e.screenX)?e.screenX:null,screenY:Number.isFinite(e.screenY)?e.screenY:null,button:e.button??null,target:describe(e.target)});
    if (validClock) mark('input-'+e.type,time);
  };
  for (const type of ['pointerdown','pointerup','click','keydown','keyup']) window.addEventListener(type,event,{capture:true,passive:true});
  const visibility = () => push('visibility',{time:performance.now(),state:document.visibilityState});
  document.addEventListener('visibilitychange',visibility);
  for (const type of ['event','longtask','long-animation-frame']) if (supported.includes(type)) {
    try {
      const observer = new PerformanceObserver(list => {
        for (const e of list.getEntries()) if (active && e.startTime >= active.started) push(type,{
          name:e.name,startTime:e.startTime,duration:e.duration,processingStart:e.processingStart??null,processingEnd:e.processingEnd??null,interactionId:e.interactionId??null,
          renderStart:e.renderStart??null,styleAndLayoutStart:e.styleAndLayoutStart??null,firstUIEventTimestamp:e.firstUIEventTimestamp??null});
      });
      observer.observe({type,buffered:false,...(type==='event'?{durationThreshold:16}:{})}); observers.push(observer);
    } catch (error) { errors.push(type+': '+error.message); }
  }
  const api = {
    info:()=>({viewport:viewport(),supportedEntryTypes:supported,errors:errors.slice(),eventTiming:{thresholdMs:16,durationQuantizationMs:8,absenceIsNotZero:true},paintEntriesAreLoadOnly:true}),
    inspect(points=[]){
      if (!Array.isArray(points) || points.length>16 || points.some(p=>!Number.isFinite(p.x)||!Number.isFinite(p.y))) throw Error('Expected at most 16 CSS viewport points');
      return {viewport:viewport(),points:points.map(point=>{
        const hits=document.elementsFromPoint(point.x,point.y).slice(0,16),ancestors=[];
        for(let node=hits[0],i=0;node&&i<12;node=node.parentElement,i++)ancestors.push(describe(node));
        return {point,hits:hits.map(describe),ancestors};
      }),regions:[...document.querySelectorAll('[data-app-shell-titlebar],[data-app-shell-application-menu-bar],.draggable,.no-drag,[data-csw-root]')].slice(0,128).map(describe),
        limitation:'CSS hit/region candidates only; pointer-events:none drag regions may be absent from elementsFromPoint; not an OS caption hit-test'};
    },
    begin(label){
      if(active || !/^[a-z0-9-]{1,60}$/.test(label))throw Error('Invalid or overlapping foreground trial');
      for(const observer of observers)observer.takeRecords(); dropped=0;
      active={label,started:performance.now(),timeOrigin:performance.timeOrigin,before:viewport(),records:[],markNames:[]};
      mark('begin',active.started); return {label,started:active.started,timeOrigin:active.timeOrigin};
    },
    profile(events){
      if(!active || !Array.isArray(events) || events.length>4096)throw Error('Bounded active profile import required');
      const stages={'selection/start':'consumer-selection','input.navigate/navigationCommitted':'confirmed-input','selection/inputReady':'input-ready'};
      for(const e of events){const stage=stages[e.operation+'/'+e.phase];if(!stage||!Number.isSafeInteger(e.operationId))continue;
        const dedup=stage+':'+e.operationId;if(active.records.some(r=>r.dedup===dedup))continue;
        mark(stage,e.timestamp,{dedup,operationId:e.operationId,bindingRevision:e.bindingRevision??null,alias:/^thread-[0-9]+$/.test(e.threadAlias)?e.threadAlias:null});
      }
      return {records:active.records.length};
    },
    // Baseline native stages must come from the same public confirmed-input
    // contract, supplied by the owning fixture, never inferred from focus.
    stage(stage,time,proof={}){
      if(!['native-selection','confirmed-input'].includes(stage))throw Error('Unsupported public stage');
      if(stage==='confirmed-input' && (proof.inputConfirmed!==true || !Number.isSafeInteger(proof.revision) || proof.revision<1))throw Error('Strict public input receipt required');
      mark(stage,time,{bindingRevision:proof.revision??null});return true;
    },
    end(){
      if(!active)throw Error('No active foreground trial');
      for(const observer of observers){for(const e of observer.takeRecords())if(e.startTime>=active.started)push(e.entryType,{name:e.name,startTime:e.startTime,duration:e.duration,processingStart:e.processingStart??null,processingEnd:e.processingEnd??null,interactionId:e.interactionId??null});}
      mark('end',performance.now());const result={...active,after:viewport(),dropped,observerErrors:errors.slice()};for(const name of active.markNames)performance.clearMarks(name);active=null;return result;
    },
    dispose(){for(const observer of observers)observer.disconnect();for(const type of ['pointerdown','pointerup','click','keydown','keyup'])window.removeEventListener(type,event,true);document.removeEventListener('visibilitychange',visibility);for(const name of active?.markNames??[])performance.clearMarks(name);active=null;delete globalThis[key];return true;},
  };
  globalThis[key]=api;return api.info();
}
module.exports={installForegroundObserver};
