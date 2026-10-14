import fs from 'node:fs';
import path from 'node:path';
import {pathToFileURL} from 'node:url';
export const parseTrace=text=>JSON.parse(text,(_key,value,context)=>typeof value==='number'&&Number.isInteger(value)&&!Number.isSafeInteger(value)?context.source:value);

// Explicit landmark calibration. The third or later point independently checks
// the two-point affine mapping; devicePixelRatio alone is never a mapping proof.
export function calibrate(anchors,tolerancePx=3){
  if(!Number.isFinite(tolerancePx)||tolerancePx<0||tolerancePx>10)throw Error('Invalid calibration tolerance');
  if(!Array.isArray(anchors)||anchors.length<3)throw Error('Two calibration landmarks plus an independent check are required');
  for(const a of anchors)if(![a.css?.x,a.css?.y,a.screen?.x,a.screen?.y].every(Number.isFinite))throw Error('Invalid landmark');
  const [a,b]=anchors,dx=b.css.x-a.css.x,dy=b.css.y-a.css.y;
  if(Math.abs(dx)<20||Math.abs(dy)<20)throw Error('Calibration landmarks must span both axes');
  const sx=(b.screen.x-a.screen.x)/dx,sy=(b.screen.y-a.screen.y)/dy,tx=a.screen.x-sx*a.css.x,ty=a.screen.y-sy*a.css.y;
  if(sx<0.25||sy<0.25||sx>8||sy>8)throw Error('Implausible coordinate scale');
  const residuals=anchors.slice(2).map(p=>Math.hypot(tx+sx*p.css.x-p.screen.x,ty+sy*p.css.y-p.screen.y));
  return {sx,sy,tx,ty,residuals,tolerancePx,verified:residuals.every(e=>e<=tolerancePx),source:'Observed corresponding CSS/physical-screen landmarks; valid only at captured window/viewport/DPI'};
}
export function mapCssPoint(mapping,point){if(!mapping.verified||![point?.x,point?.y].every(Number.isFinite))throw Error('Unverified coordinate mapping or invalid point');return{x:mapping.tx+mapping.sx*point.x,y:mapping.ty+mapping.sy*point.y};}

export function analyze(capture,trace={}){
  const page=capture.page?.accepted?capture.page.value:null,records=page?.records??[],events=Array.isArray(trace)?trace:trace.traceEvents??[];
  const markerOffsets=[];
  for(const r of records.filter(r=>r.kind==='stage'&&['begin','end'].includes(r.stage))){const found=events.filter(e=>e.name===r.mark&&Number.isFinite(e.ts));if(found.length===1)markerOffsets.push({pid:found[0].pid,offsetMs:found[0].ts/1000-r.time});}
  const offsets=markerOffsets.map(m=>m.offsetMs),spread=offsets.length?Math.max(...offsets)-Math.min(...offsets):null;
  const clock=offsets.length>=2&&spread<=2&&new Set(markerOffsets.map(m=>m.pid)).size===1?{correlated:true,offsetMs:offsets.reduce((a,b)=>a+b,0)/offsets.length,spreadMs:spread,rendererPid:markerOffsets[0].pid}:{correlated:false,markerCount:offsets.length,spreadMs:spread};
  const input=records.find(r=>r.kind==='input'&&r.type==='click'&&r.validClock);
  const stage=name=>records.find(r=>r.kind==='stage'&&r.stage===name&&(!input||r.time>=input.time));
  const selected=stage('consumer-selection')??stage('native-selection'),confirmed=stage('confirmed-input');
  const timing=records.filter(r=>r.kind==='event'&&input&&r.name==='click'&&Math.abs(r.startTime-input.time)<=1);
  const candidates=events.filter(e=>/FramePresented|SubmitCompositorFrameToPresentationCompositorFrame|SubmitUpdateDisplayTreeToPresentationCompositorFrame|SwapStartToPresentation|LatchToPresentation|EventLatency|PipelineReporter|DrawFrame|SwapBuffers|PresentationFeedback/i.test(e.name??''));
  const inventory={};for(const e of candidates)inventory[e.name]=(inventory[e.name]??0)+1;
  const presentationCandidates=candidates.filter(e=>/FramePresented|ToPresentation|PresentationFeedback/.test(e.name)&&Number.isFinite(e.ts)).slice(0,2000).map(e=>({name:e.name,ph:e.ph,pid:e.pid,tid:e.tid,ts:e.ts,dur:e.dur??null,id:e.id??e.id2??null,args:e.args??null,
    rendererPidMatches:clock.correlated&&e.pid===clock.rendererPid,documentTimeMs:clock.correlated?e.ts/1000-clock.offsetMs:null}));
  return {schema:1,label:capture.label,panels:capture.panels,pairId:capture.pairId,dataHash:capture.dataHash,clock,
    trustedClick:input??null,inputToSelectionMs:input&&selected?selected.time-input.time:null,inputToConfirmedMs:input&&confirmed?confirmed.time-input.time:null,selectionToConfirmedMs:selected&&confirmed?confirmed.time-selected.time:null,
    eventTimingMatches:timing.map(e=>({...e,nextDocumentRenderEstimateMs:e.startTime+e.duration,inputDelayMs:e.processingStart-e.startTime,processingMs:e.processingEnd-e.processingStart})),
    signalInventory:inventory,presentationCandidates,presentationCandidatesTruncated:presentationCandidates.length<candidates.filter(e=>/FramePresented|ToPresentation|PresentationFeedback/.test(e.name)&&Number.isFinite(e.ts)).length,
    actualVisibleFrameLatencyMs:null,presentationStatus:presentationCandidates.length?'needs-target-flow-and-visible-content-correlation':'not-observed-in-this-capture',functionalGate:'separate-from-observability',
    incomplete:!page||page.dropped>0||capture.framesTruncated===true||capture.traceComplete?.dataLossOccurred===true||capture.bufferUsage?.some(v=>(v.percentFull??v.value??0)>=0.99)===true||capture.traceFile?.complete!==true||capture.errors?.length>0,
    limits:['Trace candidates are not automatically the frame containing confirmed async selection','EventLatency may terminate without presentation; inspect compositor breakdown and display/frame flow IDs','Frame swap/screencast, DrawFrame, focus and rAF are not physical visible-frame certificates','Absent Event Timing under the minimum threshold is not zero latency or a threshold failure']};
}
export function comparePair(zero,five){
  const reasons=[];if(zero.panels!==0||five.panels!==5)reasons.push('expected 0 then 5 panels');
  for(const key of ['pairId','dataHash','targetId'])if(!zero[key]||zero[key]!==five[key])reasons.push(key+' differs or missing');
  const a=zero.page?.value?.before,b=five.page?.value?.before;
  for(const key of ['innerWidth','innerHeight','devicePixelRatio'])if(a?.[key]===undefined||a[key]!==b?.[key])reasons.push(key+' differs or missing');
  const read=(value,key)=>key.split('.').reduce((v,k)=>v?.[k],value);
  for(const key of ['coordinatorRunId','desktopPid','desktopCreated','hwnd','dpi','targetDpiAwareness','clientRect.width','clientRect.height','clientOrigin.x','clientOrigin.y']){
    const value=read(zero.windowEvidence,key);if(value===undefined||value!==read(five.windowEvidence,key))reasons.push('window '+key+' differs or missing');
  }
  for(const capture of [zero,five]){
    const w=capture.windowEvidence;if(!w||!w.visible||!w.foreground||w.minimized||w.targetId!==capture.targetId)reasons.push(capture.panels+' panel window not confirmed foreground/visible for this Target');
    const before=capture.page?.value?.before,after=capture.page?.value?.after;
    for(const key of ['innerWidth','innerHeight','devicePixelRatio','timeOrigin','visibility'])if(before?.[key]===undefined||before[key]!==after?.[key])reasons.push(capture.panels+' panel '+key+' changed or missing within capture');
  }
  return {comparable:!reasons.length,reasons,semanticActionAndFixtureOrderRequireReview:true,percentiles:null};
}
if(process.argv[1]&&import.meta.url===pathToFileURL(path.resolve(process.argv[1])).href){
  const [file]=process.argv.slice(2);if(!file)throw Error('Usage: foreground-analyze.mjs <trial/capture.json>');
  const capture=JSON.parse(fs.readFileSync(file,'utf8')),tracePath=path.join(path.dirname(file),'trace.json');let trace={};
  if(capture.traceFile?.complete)trace=parseTrace(fs.readFileSync(tracePath,'utf8'));
  console.log(JSON.stringify(analyze(capture,trace),null,2));
}
