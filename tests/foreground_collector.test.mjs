import assert from 'node:assert/strict';
import test from 'node:test';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import vm from 'node:vm';
import {createRequire} from 'node:module';
import {analyze,calibrate,mapCssPoint,comparePair,parseTrace} from '../scripts/native-core/foreground-analyze.mjs';
const require=createRequire(import.meta.url);
const {createCollector}=require('../scripts/native-core/foreground-collector.cjs');

function pageFixture(){
  let now=10;const listeners=new Map(),marks=[],cleared=[],observers=[];
  const node={nodeType:1,tagName:'DIV',parentElement:null,inert:false,getAttribute:()=>null,hasAttribute:n=>n==='data-app-shell-titlebar',getBoundingClientRect:()=>({x:0,y:0,width:1280,height:36})};
  const window={addEventListener:(name,fn)=>listeners.set(name,fn),removeEventListener:name=>listeners.delete(name)};
  const document={visibilityState:'visible',hasFocus:()=>true,addEventListener:()=>{},removeEventListener:()=>{},elementsFromPoint:()=>[node],querySelectorAll:()=>[node]};
  class Observer{static supportedEntryTypes=['event','longtask','long-animation-frame','paint'];constructor(callback){this.callback=callback;observers.push(this);}observe(options){this.options=options;}disconnect(){this.closed=true;}takeRecords(){return[];}}
  const performance={timeOrigin:1800000000000,now:()=>now,mark:(name,{startTime})=>marks.push({name,ph:'I',pid:123,ts:5000000+startTime*1000}),clearMarks:name=>cleared.push(name)};
  const context=vm.createContext({window,document,performance,PerformanceObserver:Observer,innerWidth:1280,innerHeight:820,outerWidth:1280,outerHeight:820,devicePixelRatio:1.5,
    screenX:10,screenY:20,screen:{width:2400,height:1600,availWidth:2400,availHeight:1560},visualViewport:{width:1280,height:820,offsetLeft:0,offsetTop:0,scale:1},
    getComputedStyle:()=>({getPropertyValue:()=> 'drag',pointerEvents:'none',display:'block',visibility:'visible',opacity:'1',position:'fixed',zIndex:'30',transform:'none',clipPath:'none',overflow:'visible'})});
  vm.runInContext("globalThis[Symbol.for('marker')]={sampleId:'sample-1',nonce:'owned-nonce'}",context);
  return{context,marks,cleared,listeners,observers,setTime:n=>{now=n;},input:(time,trusted=true)=>{now=time;listeners.get('click')({type:'click',isTrusted:trusted,timeStamp:time,clientX:600,clientY:18,screenX:910,screenY:47,button:0,target:node});}};
}
async function fixture(t,{busyTrace=false,wrongMarker=false,failDisableOnce=false,noTraceComplete=false,traceEndError=false}={}){
  const dir=fs.mkdtempSync(path.join(os.tmpdir(),'codlet-foreground-test-'));
  t.after(()=>{assert.equal(path.dirname(path.resolve(dir)),path.resolve(os.tmpdir()));assert.ok(path.basename(dir).startsWith('codlet-foreground-test-'));fs.rmSync(dir,{recursive:true,maxRetries:10,retryDelay:20});});
  const page=pageFixture(),calls=[];let fg;
  const cdp={request:async(method,params,options)=>{
    calls.push({method,params,options});
    assert.doesNotMatch(method,/^Input\.|bringToFront|attachToTarget|navigate|setDevice|setWindow/);
    if(method==='Target.getTargets')return{targetInfos:[{targetId:'target-1',type:'page',url:'app://-/index.html'}]};
    if(method==='Runtime.evaluate')return{result:{value:vm.runInContext(params.expression,page.context)}};
    if(method==='Tracing.start'&&busyTrace)throw Error('Tracing already started by another client');
    if(method==='Page.startScreencast')fg.onEvent({method:'Page.screencastFrame',sessionId:'session-1',params:{sessionId:4,data:Buffer.from('fixture pixels').toString('base64'),metadata:{timestamp:1800000000.1}}});
    if(method==='Tracing.end'){
      if(traceEndError)throw Error('Tracing is not started');
      if(!noTraceComplete)fg.onEvent({method:'Tracing.tracingComplete',sessionId:null,params:{stream:'stream-1',dataLossOccurred:false}});
    }
    if(method==='IO.read')return{data:JSON.stringify({traceEvents:[...page.marks,{name:'DrawFrame',ph:'I',pid:123,ts:5045000}]}),eof:true};
    if(method==='Performance.getMetrics')return{metrics:[{name:'Timestamp',value:5}]};
    if(method==='Performance.disable'&&failDisableOnce&&calls.filter(c=>c.method==='Performance.disable').length===1)throw Error('injected disable failure');
    return{};
  }};
  fg=createCollector({cdp,sessionId:'session-1',targetId:'target-1',sampleId:'sample-1',markerKey:'marker',nonce:wrongMarker?'wrong':'owned-nonce',outputDirectory:dir});
  return{fg,dir,page,calls};
}
const trial={label:'zero-a',panels:0,dataHash:'a'.repeat(64),pairId:'pair-1',maxMs:30000,windowEvidence:{hwnd:'123',dpi:144}};

test('collector code records observer phases, early screencast frames and trace without input/attach APIs',async t=>{
  const {fg,dir,page,calls}=await fixture(t);await fg.probe();
  const inspected=await fg.inspect([{x:600,y:18}]);assert.equal(inspected.points[0].hits[0].appRegion,'drag');
  await fg.begin(trial);page.input(20,false);page.input(25,true);page.setTime(60);
  await fg.profile([{operation:'selection',phase:'start',timestamp:26,operationId:1,threadAlias:'thread-1'},{operation:'input.navigate',phase:'navigationCommitted',timestamp:45,operationId:2,bindingRevision:3,threadAlias:'thread-1'},{operation:'selection',phase:'inputReady',timestamp:48,operationId:1}]);
  const result=await fg.end();const trace=parseTrace(fs.readFileSync(path.join(dir,'zero-a/trace.json'),'utf8')),summary=analyze(result,trace);
  assert.equal(summary.inputToSelectionMs,1);assert.equal(summary.inputToConfirmedMs,20);assert.equal(summary.clock.correlated,true);
  assert.equal(summary.actualVisibleFrameLatencyMs,null);assert.equal(summary.presentationStatus,'not-observed-in-this-capture');
  assert.equal(result.frames.length,1);assert.ok(calls.some(c=>c.method==='Page.screencastFrameAck'));
  assert.ok(calls.some(c=>c.method==='IO.close'));assert.equal(page.cleared.length,page.marks.length);
  await fg.dispose();assert.equal(page.listeners.size,0);assert.ok(page.observers.every(o=>o.closed));
});

test('a rejected tracing start never ends the foreign trace and remains observability data',async t=>{
  const {fg,calls,page}=await fixture(t,{busyTrace:true});await fg.probe();await fg.begin(trial);page.setTime(20);
  const result=await fg.end();await fg.dispose();assert.equal(result.trace.accepted,false);
  assert.equal(result.functionalGate,'not-evaluated');assert.equal(calls.filter(c=>c.method==='Tracing.end').length,0);
});

test('failed metrics cleanup is retained and retried during disposal',async t=>{
  const {fg,calls,page}=await fixture(t,{failDisableOnce:true});await fg.probe();await fg.begin(trial);page.setTime(20);
  const result=await fg.end();assert.ok(result.errors.some(e=>e.includes('performance disable')));
  await fg.dispose();assert.equal(calls.filter(c=>c.method==='Performance.disable').length,2);
});

test('accepted trace end without completion is not repeated and page observer still retires',async t=>{
  const {fg,calls,page}=await fixture(t,{noTraceComplete:true});await fg.probe();await fg.begin(trial);page.setTime(20);
  const result=await fg.end();assert.equal(result.traceEnd.accepted,true);assert.equal(result.traceCompletionObserved,false);assert.equal(result.traceFile,null);
  assert.ok(result.errors.some(e=>e.includes('completion not observed')));const cleaned=await fg.dispose();
  assert.equal(cleaned.pageObserverDisposed,true);assert.equal(calls.filter(c=>c.method==='Tracing.end').length,1);assert.equal(page.listeners.size,0);
});

test('failed trace cleanup is reported only after independent page cleanup has run',async t=>{
  const {fg,page}=await fixture(t,{traceEndError:true});await fg.probe();await fg.begin(trial);page.setTime(20);
  await assert.rejects(fg.dispose(),error=>{assert.match(error.message,/Tracing is not started/);assert.equal(error.cleanup.pageObserverDisposed,true);return true;});
  assert.equal(page.listeners.size,0);assert.ok(page.observers.every(o=>o.closed));
});

test('root forwarding is counted independently from own-session events and subscription end is recorded',async t=>{
  const {fg,page}=await fixture(t);await fg.probe();await fg.begin(trial);
  fg.onEvent({method:'Tracing.bufferUsage',sessionId:null,params:{percentFull:0.1}});fg.onSubscriptionEnd('injected stream closed');page.setTime(20);
  const r=await fg.end();await fg.dispose();assert.ok(r.forwardedEvents.root>=2);assert.equal(r.forwardedEvents.methods['Tracing.tracingComplete'],1);
  assert.equal(r.subscriptionState.ended,true);assert.ok(r.errors.some(e=>e.includes('subscription ended')));
});

test('foreign session frames are ignored, frame cap is explicit and all own frames are acknowledged',async t=>{
  const {fg,calls,page}=await fixture(t);await fg.probe();await fg.begin({...trial,saveFrames:false});
  fg.onEvent({method:'Page.screencastFrame',sessionId:'foreign',params:{data:'',sessionId:1}});
  for(let i=0;i<125;i++)fg.onEvent({method:'Page.screencastFrame',sessionId:'session-1',params:{data:'eA==',sessionId:i,metadata:{timestamp:i}}});
  page.setTime(20);const r=await fg.end();await fg.dispose();assert.equal(r.frames.length,120);assert.equal(r.framesTruncated,true);
  assert.equal(calls.filter(c=>c.method==='Page.screencastFrameAck').length,126);
  assert.equal(r.forwardedEvents.ownSession,126,'early queued frames must not be counted twice');
});

test('owned nonce mismatch refuses page installation',async t=>{
  const {fg,page}=await fixture(t,{wrongMarker:true});await assert.rejects(fg.probe(),/marker mismatch/);assert.equal(page.listeners.size,0);
});

test('confirmed baseline stage requires an explicit strict input receipt, not focus',async t=>{
  const {fg,page}=await fixture(t);await fg.probe();await fg.begin(trial);page.setTime(20);
  await assert.rejects(fg.stage('confirmed-input',20,{focused:true}),/Strict public/);
  await fg.stage('confirmed-input',20,{inputConfirmed:true,revision:3});await fg.end();await fg.dispose();
});

test('late events from before arming are retained as invalid-clock and not used as trial input',async t=>{
  const {fg,page,dir}=await fixture(t);await fg.probe();await fg.begin(trial);page.input(9);page.setTime(20);const r=await fg.end();await fg.dispose();
  assert.equal(analyze(r,parseTrace(fs.readFileSync(path.join(dir,'zero-a/trace.json'),'utf8'))).trustedClick,null);
});

test('presentation-named events remain candidates until actual Target/frame/visible-content linkage is reviewed',()=>{
  const capture={label:'a',page:{accepted:true,value:{records:[],before:{},after:{}}},traceFile:{complete:true},errors:[]};
  const a=analyze(capture,{traceEvents:[{name:'FramePresented',ts:100,pid:5,ph:'I'},{name:'EventLatency',ts:90,dur:10,pid:5,ph:'X'}]});
  assert.equal(a.presentationStatus,'needs-target-flow-and-visible-content-correlation');assert.equal(a.actualVisibleFrameLatencyMs,null);
  assert.equal(analyze({...capture,bufferUsage:[{percentFull:1}]}).incomplete,true);
});

test('coordinate mapping requires an independent landmark and rejects drift',()=>{
  const anchors=[{css:{x:10,y:10},screen:{x:115,y:215}},{css:{x:110,y:210},screen:{x:265,y:515}},{css:{x:70,y:80},screen:{x:205,y:320}}];
  const m=calibrate(anchors);assert.equal(m.verified,true);assert.deepEqual(mapCssPoint(m,{x:20,y:30}),{x:130,y:245});
  anchors[2].screen.x+=10;assert.equal(calibrate(anchors).verified,false);assert.throws(()=>calibrate(anchors.slice(0,2)),/independent/);
});

test('paired samples reject mismatched data/viewport and do not invent percentiles',()=>{
  const viewport={innerWidth:1280,innerHeight:820,devicePixelRatio:1.5,timeOrigin:123,visibility:'visible'};
  const zero={...trial,targetId:'target',windowEvidence:{targetId:'target',coordinatorRunId:'run-1',desktopPid:123,desktopCreated:'1234',hwnd:'456',dpi:144,targetDpiAwareness:2,clientRect:{width:1920,height:1230},clientOrigin:{x:100,y:200},visible:true,foreground:true,minimized:false},page:{value:{before:viewport,after:viewport}}};
  assert.equal(comparePair(zero,{...zero,panels:5}).comparable,true);
  assert.equal(comparePair(zero,{...zero,panels:5,dataHash:'b'.repeat(64)}).comparable,false);
  assert.equal(comparePair(zero,{...zero,panels:5,windowEvidence:{...zero.windowEvidence,dpi:96}}).comparable,false);
});

test('large trace identifiers retain exact integer spelling',()=>{
  assert.equal(parseTrace('{"id":134363310244631275}').id,'134363310244631275');
});
