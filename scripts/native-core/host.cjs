// Explicit lab-only instrumentation. No network listener or application messages.
const fs = require('node:fs');
const path = require('node:path');
const settings = JSON.parse(fs.readFileSync(path.join(__dirname, 'settings.json'), 'utf8'));
let context, sessionId, timer, stopped = false, lastId;
const wait = ms => new Promise(resolve => setTimeout(resolve, ms));
async function attach() {
  const {targetInfos} = await context.cdp.request('Target.getTargets');
  const target = targetInfos.find(t => t.targetId === settings.targetId);
  if (!target || target.type !== 'page' || !target.url.startsWith('app://-/index.html')) throw Error('Pinned owned Target unavailable');
  ({sessionId} = await context.cdp.request('Target.attachToTarget', {targetId:target.targetId,flatten:true}));
}
async function evaluate(expression, awaitPromise = true) {
  if (!sessionId) await attach();
  const reply = await context.cdp.request('Runtime.evaluate', {expression,awaitPromise,returnByValue:true}, {sessionId,timeoutMs:15000});
  if(reply.exceptionDetails) throw Error(reply.exceptionDetails.exception?.description ?? reply.exceptionDetails.text);
  return reply.result?.value;
}
async function invoke(action, options) {
  return evaluate(`globalThis.__codletCoreCostLab[${JSON.stringify(action)}](${JSON.stringify(options ?? {})})`);
}
async function command(input) {
  if(!/^[a-z0-9-]{1,80}$/.test(input.id))throw Error('Invalid command ID');
  if(!sessionId)await attach();
  if(!input.options?.background&&['inspect','setup','runCase','theme','nativeClick','capture'].includes(input.action)){
    await context.cdp.request('Page.bringToFront',{}, {sessionId});
  }
  if(input.action === 'inspect') {
    if(!sessionId) await attach();
    return evaluate(`({visible:document.visibilityState,focused:document.hasFocus(),viewport:[innerWidth,innerHeight],fixture:!!globalThis.__codletCoreCostLab,buttons:[...document.querySelectorAll('button')].map(b=>({label:b.getAttribute('aria-label'),title:b.getAttribute('title'),expanded:b.getAttribute('aria-expanded'),testid:b.getAttribute('data-testid'),text:(b.textContent||'').trim().slice(0,60),rect:(()=>{const r=b.getBoundingClientRect();return [r.x,r.y,r.width,r.height]})()})).filter(b=>b.rect[2]>0&&b.rect[3]>0).slice(0,55)})`);
  }
  if(input.action==='architecture'){
    const version=await context.cdp.request('Browser.getVersion');
    let browserWindow;try{browserWindow=await context.cdp.request('Browser.getWindowForTarget',{targetId:settings.targetId});}catch(error){browserWindow={error:String(error.message)};}
    const document=await evaluate(`({visibility:document.visibilityState,hasFocus:document.hasFocus(),userAgent:navigator.userAgent,windowKeys:Object.getOwnPropertyNames(globalThis).filter(k=>/owl|uikit|native|electron/i.test(k)),bridgeKeys:globalThis.electronBridge?Object.keys(globalThis.electronBridge):[]})`);
    return {targetId:settings.targetId,version,browserWindow,document};
  }
  if(['setup','runCase','theme','cleanup','status','armNative','nativeResult','beginIdle','endIdle','lifecycle','drainReact'].includes(input.action))return invoke(input.action,input.options);
  if(input.action === 'nativeClick') {
    const armed=await invoke('armNative',input.options);
    await context.cdp.request('Input.dispatchMouseEvent',{type:'mousePressed',x:armed.x,y:armed.y,button:'left',clickCount:1},{sessionId});
    await context.cdp.request('Input.dispatchMouseEvent',{type:'mouseReleased',x:armed.x,y:armed.y,button:'left',clickCount:1},{sessionId});
    for(let i=0;i<50;i++){await wait(40);const r=await invoke('nativeResult');if(r.done)return r;}
    throw Error('Native control response timed out');
  }
  if(input.action === 'counters') {
    const dom=await context.cdp.request('Memory.getDOMCounters',{}, {sessionId});
    const heap=await context.cdp.request('Runtime.getHeapUsage',{}, {sessionId});
    return {dom,heap,fixture:await invoke('status')};
  }
  if(input.action === 'gc') {await context.cdp.request('HeapProfiler.collectGarbage',{}, {sessionId,timeoutMs:15000});return {collected:true};}
  if(input.action === 'capture') {
    const r=await context.cdp.request('Page.captureScreenshot',{format:'jpeg',quality:40,fromSurface:true},{sessionId});
    const file=path.join(__dirname,'capture-'+input.id+'.jpg');fs.writeFileSync(file,Buffer.from(r.data,'base64'));return {file};
  }
  throw Error('Unknown lab command');
}
async function poll() {
  try {
    const file=path.join(__dirname,'command.json');
    if(fs.existsSync(file)) {
      const input=JSON.parse(fs.readFileSync(file,'utf8'));
      if(input.id!==lastId){lastId=input.id;let output;
        try{output={id:input.id,ok:true,result:await command(input)};}catch(error){output={id:input.id,ok:false,error:String(error.stack||error)};}
        fs.writeFileSync(path.join(__dirname,'response-'+input.id+'.json'),JSON.stringify(output,null,2)+'\n');
        // Idle samples stop polling entirely; one bounded timer wakes after them.
        if(output.ok&&input.action==='beginIdle'&&input.options?.idleMs===65000){timer=setTimeout(poll,65000);return;}
      }
    }
  } catch(error){context.log.error('Core cost lab command failed',String(error));}
  if(!stopped)timer=setTimeout(poll,200);
}
exports.activate = c => {context=c;try{lastId=JSON.parse(fs.readFileSync(path.join(__dirname,'command.json'),'utf8')).id;}catch{}timer=setTimeout(poll,300);};
exports.deactivate = async cleanup => {stopped=true;clearTimeout(timer);if(sessionId)try{await cleanup.cdp.request('Target.detachFromTarget',{sessionId});}catch{}};
