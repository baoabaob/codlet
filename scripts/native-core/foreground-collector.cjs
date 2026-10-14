'use strict';
const fs=require('node:fs'),path=require('node:path');
const {installForegroundObserver}=require('./foreground-page.cjs');
const EVENT_METHODS=['Tracing.tracingComplete','Tracing.bufferUsage','Page.screencastFrame','Page.screencastVisibilityChanged'];
const CATEGORIES=['blink.user_timing','devtools.timeline','disabled-by-default-devtools.timeline','disabled-by-default-devtools.timeline.frame','cc','benchmark','viz','input','latencyInfo','toplevel'];
const message=error=>String(error?.message??error).slice(0,2000);
const recordError=(trial,text)=>{if(trial.errors.length<128)trial.errors.push(text);};
const plainDirectory=directory=>{
  const namespace='\\\\?\\';
  for(let p=path.resolve(directory);;){
    // Node on Windows can mis-handle lstat of the verbatim volume root itself.
    // Only that root uses its equivalent ordinary absolute spelling; preserve
    // verbatim semantics for every other directory (including trailing dots).
    const metadataPath=p.startsWith(namespace)&&/^[a-z]:\\$/i.test(p.slice(namespace.length))?p.slice(namespace.length):p;
    const s=fs.lstatSync(metadataPath);if(!s.isDirectory()||s.isSymbolicLink())throw Error('Plain output directory required');
    if(/^[a-z]:[\\/]$/i.test(metadataPath))break;
    let parent=path.dirname(p);
    if(/^[a-z]:$/i.test(parent)&&/^[a-z]:[\\/]/i.test(p)&&parent.toLowerCase()===p.slice(0,2).toLowerCase())parent+=p[2];
    if(parent===p)break;p=parent;
  }
};

// Caller owns and verifies this session, marker, registry and profile. This
// module never attaches, brings to front, navigates, dispatches input or quits.
function createCollector({cdp,sessionId,targetId,sampleId,markerKey,nonce,outputDirectory}){
  if(!sessionId||!targetId||!/^[a-z0-9-]{1,90}$/.test(sampleId)||!markerKey||!nonce)throw Error('Explicit owned identities required');
  plainDirectory(outputDirectory);const output=path.resolve(outputDirectory),key='codlet.core.foreground.'+sampleId;
  let initialized=false,trial=null,disposed=false;
  const subscriptionState={ended:false,reason:null};
  const request=(method,params={},root=false)=>cdp.request(method,params,{...(root?{}:{sessionId}),timeoutMs:10000});
  const evaluate=async expression=>{const r=await request('Runtime.evaluate',{expression,returnByValue:true,awaitPromise:false});if(r.exceptionDetails)throw Error(r.exceptionDetails.exception?.description??r.exceptionDetails.text);return r.result?.value;};
  const page=(method,args=[])=>evaluate(`globalThis[Symbol.for(${JSON.stringify(key)})][${JSON.stringify(method)}](...${JSON.stringify(args)})`);
  const save=(name,value)=>fs.writeFileSync(path.join(output,name),JSON.stringify(value,null,2)+'\n',{flag:'wx'});
  const attempt=async action=>{try{return {accepted:true,value:await action()};}catch(error){return {accepted:false,error:message(error)};}};
  async function probe(){
    if(disposed||initialized)throw Error('Collector already initialized/retired');
    const targets=await request('Target.getTargets',{},true),matches=targets.targetInfos?.filter(t=>t.targetId===targetId)??[];
    if(matches.length!==1||matches[0].type!=='page'||matches[0].url!=='app://-/index.html')throw Error('Owned app Target differs');
    const info={schema:1,sampleId,targetId,sessionId,createdAt:new Date().toISOString(),
      version:await attempt(()=>request('Browser.getVersion',{},true)),categories:await attempt(()=>request('Tracing.getCategories',{},true)),
      window:await attempt(()=>request('Browser.getWindowForTarget',{targetId},true)),layout:await attempt(()=>request('Page.getLayoutMetrics')),
      frameTree:await attempt(()=>request('Page.getFrameTree'))};
    info.page=await evaluate(`(${installForegroundObserver.toString()})(${JSON.stringify({sampleId,markerKey,nonce,key})})`);
    initialized=true;save('probe.json',info);return info;
  }
  function onEvent(event,forwarded=true){
    const t=trial;if(!t)return;
    const scope=event.sessionId==null?'root':event.sessionId===sessionId?'ownSession':'otherSession';
    if(forwarded){t.forwardedEvents[scope]++;
      if(EVENT_METHODS.includes(event.method))t.forwardedEvents.methods[event.method]=(t.forwardedEvents.methods[event.method]??0)+1;}
    const p=event.params??{};
    if(event.method.startsWith('Tracing.') && event.sessionId!=null)return;
    if(event.method.startsWith('Page.') && event.sessionId!==sessionId)return;
    if(event.method==='Tracing.tracingComplete' && t.traceCompletionExpected){t.traceComplete=p;t.traceOwned=false;t.traceCompletionExpected=false;t.resolveTrace(p);}
    if(event.method==='Tracing.bufferUsage' && t.traceOwned && t.bufferUsage.length<64)t.bufferUsage.push({at:Date.now(),...p});
    if(event.method==='Page.screencastVisibilityChanged' && t.visibility.length<128)t.visibility.push({at:Date.now(),visible:p.visible});
    if(event.method==='Page.screencastFrame' && t.castPending){if(t.earlyFrames.length<2)t.earlyFrames.push(event);return;}
    if(event.method==='Page.screencastFrame' && t.castOwned){
      // Ack every frame, even when local storage reaches its explicit limit.
      const ack=request('Page.screencastFrameAck',{sessionId:p.sessionId}).catch(error=>recordError(t,'frame ack: '+message(error)));t.pending.add(ack);ack.finally(()=>t.pending.delete(ack));
      try{
        const data=Buffer.from(p.data??'','base64');
        if(t.frames.length>=120||t.frameBytes+data.length>16*1024*1024){t.framesTruncated=true;return;}
        const name='frame-'+String(t.frames.length).padStart(4,'0')+'.jpg';
        if(t.saveFrames)fs.writeFileSync(path.join(t.directory,name),data,{flag:'wx'});
        t.frames.push({index:t.frames.length,file:t.saveFrames?name:null,metadata:p.metadata,receivedAt:Date.now(),bytes:data.length});t.frameBytes+=data.length;
      }catch(error){recordError(t,'frame storage: '+message(error));}
    }
  }
  async function begin({label,panels,dataHash,pairId,maxMs=30000,saveFrames=true,windowEvidence=null}){
    if(!initialized||disposed||trial)throw Error('Collector must be idle and initialized');
    if(!/^[a-z0-9-]{1,60}$/.test(label)||![0,5].includes(panels)||!/^[a-f0-9]{64}$/.test(dataHash)||!/^[a-z0-9-]{1,60}$/.test(pairId)||!Number.isInteger(maxMs)||maxMs<1000||maxMs>30000)throw Error('Invalid paired trial');
    const directory=path.join(output,label);fs.mkdirSync(directory);
    const t=trial={label,panels,dataHash,pairId,directory,saveFrames,windowEvidence:JSON.parse(JSON.stringify(windowEvidence)),traceOwned:false,traceCompletionExpected:false,traceEnd:null,castOwned:false,castPending:false,earlyFrames:[],performanceOwned:false,frames:[],frameBytes:0,framesTruncated:false,errors:[],bufferUsage:[],visibility:[],pending:new Set(),stopping:null,forwardedEvents:{root:0,ownSession:0,otherSession:0,methods:{}}};
    t.traceWait=new Promise(resolve=>{t.resolveTrace=resolve;});
    t.performance=await attempt(()=>request('Performance.enable',{timeDomain:'timeTicks'}));t.performanceOwned=t.performance.accepted;
    t.metricsBefore=await attempt(()=>request('Performance.getMetrics'));
    t.trace=await attempt(()=>request('Tracing.start',{transferMode:'ReturnAsStream',streamFormat:'json',streamCompression:'none',bufferUsageReportingInterval:1000,
      traceConfig:{recordMode:'recordUntilFull',traceBufferSizeInKb:16384,enableSampling:false,enableSystrace:false,includedCategories:CATEGORIES}},true));
    t.traceOwned=t.trace.accepted;t.traceCompletionExpected=t.trace.accepted;
    t.castPending=true;t.screencast=await attempt(()=>request('Page.startScreencast',{format:'jpeg',quality:60,maxWidth:1280,maxHeight:900,everyNthFrame:1}));t.castOwned=t.screencast.accepted;t.castPending=false;
    for(const event of t.earlyFrames)onEvent(event,false);t.earlyFrames=[];
    t.pageBegin=await attempt(()=>page('begin',[label]));
    t.timer=setTimeout(()=>{end({reason:'capture-deadline'}).catch(error=>{recordError(t,message(error));});},maxMs);t.timer.unref?.();
    return {label,trace:t.trace,screencast:t.screencast,performance:t.performance,page:t.pageBegin,maxMs,key};
  }
  async function finish(t,reason){
    clearTimeout(t.timer);
    t.page=await attempt(()=>page('end'));
    t.metricsAfter=await attempt(()=>request('Performance.getMetrics'));
    if(t.castOwned){const r=await attempt(()=>request('Page.stopScreencast'));if(!r.accepted)recordError(t,'stop screencast: '+r.error);else t.castOwned=false;}
    if(t.traceOwned){
      const stopped=await attempt(()=>request('Tracing.end',{},true));
      t.traceEnd=stopped;
      // An accepted end request consumes our right to issue end again. Flush
      // completion/stream delivery is a separate observation, not ownership.
      if(stopped.accepted)t.traceOwned=false;else recordError(t,'stop trace: '+stopped.error);
    }
    if(t.trace.accepted){
      let timer;const complete=await Promise.race([t.traceWait,new Promise(resolve=>{timer=setTimeout(()=>resolve(null),5000);})]);clearTimeout(timer);
      if(complete){t.traceOwned=false;t.traceComplete=complete;
        if(complete.stream){let bytes=0,descriptor;const readDeadline=Date.now()+15000;
          try{descriptor=fs.openSync(path.join(t.directory,'trace.json'),'wx');
            for(let reads=0;reads<1024;reads++){
              if(Date.now()>readDeadline)throw Error('Trace stream read deadline exceeded');
              const r=await request('IO.read',{handle:complete.stream,size:65536},true),chunk=Buffer.from(r.data??'',r.base64Encoded?'base64':'utf8');
              if(bytes+chunk.length>32*1024*1024)throw Error('Trace byte cap reached; trace is incomplete');fs.writeSync(descriptor,chunk);bytes+=chunk.length;
              if(r.eof){t.traceFile={file:'trace.json',bytes,complete:true};break;}
            }
            if(!t.traceFile)throw Error('Trace read cap reached');
          }catch(error){recordError(t,'trace read: '+message(error));t.traceFile={file:'trace.json',bytes,complete:false};}
          finally{if(descriptor!==undefined)fs.closeSync(descriptor);const r=await attempt(()=>request('IO.close',{handle:complete.stream},true));if(!r.accepted)recordError(t,'trace stream close: '+r.error);}
        }else recordError(t,'Tracing completed without stream');
      }else recordError(t,'Tracing completion not observed; verify root-event forwarding');
    }
    if(t.performanceOwned){const r=await attempt(()=>request('Performance.disable'));if(!r.accepted)recordError(t,'performance disable: '+r.error);else t.performanceOwned=false;}
    await Promise.allSettled([...t.pending]);
    const result={schema:1,sampleId,targetId,sessionId,label:t.label,panels:t.panels,dataHash:t.dataHash,pairId:t.pairId,reason,finishedAt:new Date().toISOString(),
      trace:t.trace,traceEnd:t.traceEnd,traceCompletionObserved:!!t.traceComplete,traceFile:t.traceFile??null,traceComplete:t.traceComplete??null,bufferUsage:t.bufferUsage,
      performance:t.performance,metricsBefore:t.metricsBefore,metricsAfter:t.metricsAfter,screencast:t.screencast,frames:t.frames,framesTruncated:t.framesTruncated,
      page:t.page,pageBegin:t.pageBegin,windowEvidence:t.windowEvidence,screencastVisibility:t.visibility,errors:t.errors,forwardedEvents:t.forwardedEvents,subscriptionState:{...subscriptionState},
      presentationStatus:'not-yet-correlated',functionalGate:'not-evaluated',
      limits:['Event Timing is thresholded/quantized and may finish before async confirmed input','Screencast timestamps are frame-swap metadata, not physical display timestamps','Frame/paint/presentation trace candidates require Target, clock, flow and visible-window correlation','No rAF, focus or arbitrary next frame is promoted to presentation']};
    fs.writeFileSync(path.join(t.directory,'capture.json'),JSON.stringify(result,null,2)+'\n',{flag:'wx'});
    if(!t.traceOwned&&!t.castOwned&&!t.performanceOwned)trial=null;
    return result;
  }
  function end({reason='caller-finished'}={}){if(!trial)throw Error('No active trial');return trial.stopping??=(finish(trial,reason));}
  async function dispose(cleanupCdp){
    if(cleanupCdp)cdp=cleanupCdp;
    if(disposed)return{disposed:true,alreadyDisposed:true};
    const failures=[],outcome={disposed:false,pageObserverDisposed:false,steps:[]};
    const clean=async(label,action)=>{try{const value=await action();outcome.steps.push({label,ok:true});return value;}catch(error){const failure={label,error:message(error)};failures.push(failure);outcome.steps.push({...failure,ok:false});}};
    const pending=trial?.stopping??(trial?end({reason:'collector-retired'}):null);
    if(pending)await clean('finish capture',()=>pending);
    // Retry only resources this collector successfully started. Never end a
    // foreign trace or repeat an already accepted end without completion.
    if(trial?.castOwned)await clean('stop screencast',async()=>{await request('Page.stopScreencast');trial.castOwned=false;});
    if(trial?.traceOwned)await clean('end trace',async()=>{await request('Tracing.end',{},true);trial.traceOwned=false;});
    if(trial?.performanceOwned)await clean('disable metrics',async()=>{await request('Performance.disable');trial.performanceOwned=false;});
    // Even failed file writes or protocol cleanup must not strand listeners.
    if(initialized)await clean('dispose page observer',async()=>{if(await page('dispose')!==true)throw Error('Page observer retirement was not acknowledged');outcome.pageObserverDisposed=true;initialized=false;});
    if(!failures.length){disposed=true;trial=null;outcome.disposed=true;return outcome;}
    const error=new AggregateError(failures.map(f=>new Error(f.label+': '+f.error)),'Foreground cleanup incomplete: '+failures.map(f=>f.label+': '+f.error).join('; '));error.cleanup=outcome;throw error;
  }
  const onSubscriptionEnd=reason=>{subscriptionState.ended=true;subscriptionState.reason=message(reason);if(trial)recordError(trial,'CDP event subscription ended: '+subscriptionState.reason);};
  return {probe,begin,end,dispose,onEvent,onSubscriptionEnd,key,inspect:points=>page('inspect',[points]),profile:events=>page('profile',[events]),stage:(stage,time,proof)=>page('stage',[stage,time,proof])};
}
module.exports={createCollector,EVENT_METHODS,CATEGORIES};
