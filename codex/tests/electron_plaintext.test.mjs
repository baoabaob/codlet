import test from 'node:test';
import assert from 'node:assert/strict';
import { createHash } from 'node:crypto';
import { EventEmitter } from 'node:events';
import { Readable } from 'node:stream';
import Module, { createRequire } from 'node:module';
import path from 'node:path';
import fs from 'node:fs';
import os from 'node:os';
const { installDesktopPlaintext, routedThreadMessage, reviewedSourceProfiles } = createRequire(import.meta.url)('../host/electron-plaintext.cjs');

test('reviewed Owl source hashes are complete SHA-256 values with a mapped class', () => {
  for (const profile of Object.values(reviewedSourceProfiles)) {
    assert.match(profile.hash,/^[a-f0-9]{64}$/u);
    assert.match(profile.symbol,/^[A-Za-z_$][A-Za-z0-9_$]*$/u);
  }
});

test('current Windows source discovery pins match exact reviewed roles without claiming Native acceptance',()=>{
 const root=process.env.CODLET_CORE_ROOT??path.resolve(import.meta.dirname,'../..');
 const report=JSON.parse(fs.readFileSync(path.join(root,'docs/native-source-26.1007.9446.0.json'),'utf8'));
 assert.equal(report.kind,'exact-source-review-with-extracted-method-probes');
 for(const [name,role]of Object.entries(report.roles))assert.deepEqual(reviewedSourceProfiles[name],{hash:role.hash,kind:role.kind,symbol:role.symbol});
 assert.ok(report.limitations.some(value=>value.includes('Actual Native')));
});

const bootstrap = `class Pt {
  assertAllowed(url) { if (!url.startsWith('https://provider.example/') && !url.startsWith('https://other.example/')) throw Error('policy'); }
  async fetch(url, init) { globalThis.fixtureRequests.push({url,body:init.body,credentials:init.credentials,headers:init.headers});if(url.endsWith('/fetch-redirect'))return new Response(null,{status:302,headers:{location:'https://other.example/final'}});if(url.endsWith('/fetch-redirect-307'))return new Response(null,{status:307,headers:{location:'/continued'}});if(url.endsWith('/cross-chain-start'))return new Response(null,{status:307,headers:{location:'https://other.example/final'}});return new Response('upstream', {status:200,headers:{'content-type':'text/plain'}}); }
  request(options) { const call=new (require('node:events').EventEmitter)(); let redirectFollowed=false,aborted=false;
    call.getUploadProgress=()=>({started:true,current:1,total:1});call.followRedirect=()=>{redirectFollowed=true};
    call.abort=()=>{aborted=true;call.emit('error',new Error('aborted'))};
    call.end=body=>{globalThis.fixtureRequests.push({url:options.url,body,method:options.method,credentials:options.credentials,origin:options.origin,useSessionCookies:options.useSessionCookies,headers:options.headers});
      queueMicrotask(()=>{if(aborted)return;const redirect=options.url.endsWith('/redirect')||options.url.endsWith('/fetch-redirect')||options.url.endsWith('/fetch-redirect-307')||options.url.endsWith('/cross-chain-start')||options.url.endsWith('/multi-hop');
        if(redirect){const destinations=options.url.endsWith('/multi-hop')?['https://provider.example/middle','https://other.example/final']:
          [options.url.endsWith('/fetch-redirect-307')?'https://provider.example/continued':'https://other.example/final'];
          for(const destination of destinations){redirectFollowed=false;call.emit('redirect',options.url.endsWith('/fetch-redirect-307')?307:302,'GET',destination,{});if(!redirectFollowed||aborted)return;}}
        const reply=require('node:stream').Readable.from([Buffer.from('upstream')]);reply.statusCode=200;reply.headers={'content-type':'text/plain'};call.emit('response',reply);});};return call;}
}; module.exports={Pt};`;
const main = `class wEe {
  constructor(network){this.network=network;}
  async performDesktopFetch({progress=false,redirect=false,redirect307=false,multi=false,cross=false,crossChain=false}={}) { if (!progress) return this.network.fetch('https://provider.example/'+(multi?'multi-hop':crossChain?'cross-chain':cross?'cross':redirect307?'fetch-redirect-307':redirect?'fetch-redirect':'responses'),{method:'POST',body:'original',credentials:'include',headers:redirect||cross?{authorization:'Bearer secret',cookie:'session=secret'}:undefined});
    return await new Promise((resolve,reject)=>{const request=this.network.request({url:'https://provider.example/'+(cross?'cross-upload':redirect?'redirect':'upload'),method:'POST',useSessionCookies:true,headers:redirect||cross?{authorization:'Bearer secret',cookie:'session=secret'}:undefined});request.on('error',reject);request.on('response',resolve);request.end('original');}); }
}; module.exports={wEe};`;
const hash = code => createHash('sha256').update(code).digest('hex');
function compile(name, code) { const filename=path.join(process.cwd(),name), module=new Module(filename); module.filename=filename; module.paths=Module._nodeModulePaths(process.cwd()); module._compile(code,filename); return module.exports; }
test('HTTP and Stdio never consult Core update admission, including repeated Native errors',async()=>{
  const nativeError=Error('Native request failed');globalThis.nativeContinuityError=nativeError;globalThis.nativeContinuityCalls=0;
  const boot=`class Pt {assertAllowed(){}fetch(){}request(){const request=new(require('node:events').EventEmitter)();request.abort=()=>{};request.end=()=>{globalThis.nativeContinuityCalls++;queueMicrotask(()=>request.emit('error',globalThis.nativeContinuityError));};return request;}}module.exports={Pt};`;
  const stdio=`class Gs{constructor(proc){this.proc=proc;}send(message){globalThis.nativeContinuityCalls++;if(message==='throw')throw globalThis.nativeContinuityError;return message;}}module.exports={Gs};`;
  const owned=new EventEmitter(),onlineUpdates=new Proxy({}, {get(){assert.fail('Native must not consult Core admission or receipts');}});
  const hook=installDesktopPlaintext({app:{isReady:()=>false}},{source:{interceptHttp(input,{forward}){return forward(input,{signal:new AbortController().signal});}},onlineUpdates,ownsBackendProcess:proc=>proc===owned,deadlineUnixMs:Date.now()+1000},{expectedHashes:{'bootstrap-DK4EfNwt.js':hash(boot),'main-LM8MUIFp.js':hash(main),'application-network-startup-YSC7OAs0.js':hash(stdio)}});
  try {
    const {Pt}=compile('bootstrap-DK4EfNwt.js',boot),{wEe}=compile('main-LM8MUIFp.js',main),{Gs}=compile('application-network-startup-YSC7OAs0.js',stdio),wrapper=new wEe(new Pt()),native=new Gs(owned);
    for(let i=0;i<300;i++)await assert.rejects(wrapper.performDesktopFetch({progress:i%2===0}),error=>error===nativeError);
    assert.equal(native.send('native-message'),'native-message');assert.throws(()=>native.send('throw'),error=>error===nativeError);
    assert.equal(globalThis.nativeContinuityCalls,302);
  } finally {hook.close();delete globalThis.nativeContinuityError;delete globalThis.nativeContinuityCalls;}
});
test('Stdio preparation failure falls through once and accepted sends survive source retirement',async()=>{
  const code=`class Gs{constructor(proc){this.proc=proc;this.sent=[];}send(message){this.sent.push(message);return message;}}module.exports={Gs};`;
  const proc=new EventEmitter();let rejectRoute;
  const source={interceptHttp(){},reserveRoute(){return{baseUrl:'http://127.0.0.1:45678/route/',ready:new Promise((_resolve,reject)=>{rejectRoute=reject;}),close(){}};}};
  const hook=installDesktopPlaintext({app:{isReady:()=>false}},{source,ownsBackendProcess:value=>value===proc,deadlineUnixMs:Date.now()+1000},{expectedHashes:{'application-network-startup-YSC7OAs0.js':hash(code)}});
  try {
    const {Gs}=compile('application-network-startup-YSC7OAs0.js',code),native=new Gs(proc),message=JSON.stringify({id:1,method:'thread/start',params:{config:{'model_providers.custom.base_url':'https://provider.example/v1'}}});
    native.send(message);native.send('second');hook.close();rejectRoute(Error('Core route unavailable'));
    await new Promise(resolve=>setImmediate(resolve));assert.deepEqual(native.sent,[message,'second']);
  } finally {hook.close();}
});
test('an unavailable Core HTTP source falls through only before Native has dispatched',async()=>{
  globalThis.fixtureRequests=[];
  const error=Object.assign(Error('Core source closed'),{code:'peer_closed'});let afterDispatch=false;
  const source={async interceptHttp(input,{forward}) {if(afterDispatch)await forward(input,{signal:new AbortController().signal});throw error;}};
  const hook=installDesktopPlaintext({app:{isReady:()=>false}},{source,deadlineUnixMs:Date.now()+1000},{expectedHashes:{'bootstrap-DK4EfNwt.js':hash(bootstrap),'main-LM8MUIFp.js':hash(main)}});
  try {
    const {Pt}=compile('bootstrap-DK4EfNwt.js',bootstrap),{wEe}=compile('main-LM8MUIFp.js',main),wrapper=new wEe(new Pt());
    assert.equal(await (await wrapper.performDesktopFetch()).text(),'upstream');
    assert.equal(await new Response(Readable.toWeb(await wrapper.performDesktopFetch({progress:true}))).text(),'upstream');
    assert.equal(globalThis.fixtureRequests.length,2);assert.ok(globalThis.fixtureRequests.every(request=>String(request.body)==='original'));
    afterDispatch=true;
    for(const progress of [false,true])await assert.rejects(wrapper.performDesktopFetch({progress}),value=>value===error);
    assert.equal(globalThis.fixtureRequests.length,4);
  }finally{hook.close();delete globalThis.fixtureRequests;}
});

test('current four-module source mapping acquires each hook and restores split connection ownership',async()=>{
 const code={
  'bootstrap-iULMfRBf.js':bootstrap.replaceAll('Pt','tr'),
  'main-Bgi5Xaw-.js':main.replaceAll('wEe','ple'),
  'application-network-startup-YSC7OAs0.js':'class Gs{constructor(proc){this.proc=proc}send(message){return message}}module.exports={Gs,original:Gs.prototype.send}',
  'src-DCNiwad_.js':'class mB{constructor(proc){this.connection={proc}}routeIncomingMessage(message){return message}}module.exports={mB,original:mB.prototype.routeIncomingMessage}',
 };
 const proc=new EventEmitter(),modes=[];
 const hook=installDesktopPlaintext({app:{isReady:()=>false}},{source:{interceptHttp(){}},deadlineUnixMs:Date.now()+1000,ownsBackendProcess:value=>value===proc,updateAccountMode:(_proc,mode)=>modes.push(mode)},
  {expectedHashes:Object.fromEntries(Object.entries(code).map(([name,source])=>[name,hash(source)]))});
 let stdio,connection;
 try{
  compile('bootstrap-iULMfRBf.js',code['bootstrap-iULMfRBf.js']);compile('main-Bgi5Xaw-.js',code['main-Bgi5Xaw-.js']);stdio=compile('application-network-startup-YSC7OAs0.js',code['application-network-startup-YSC7OAs0.js']);
  assert.equal(hook.inspect().taskConfigurationAvailable,false);connection=compile('src-DCNiwad_.js',code['src-DCNiwad_.js']);
  assert.equal((await hook.ready()).available,true);assert.equal(hook.inspect().taskConfigurationAvailable,true);
  new connection.mB(proc).routeIncomingMessage({method:'account/updated',params:{authMode:'apiKey'}});assert.deepEqual(modes,['apiKey']);
 }finally{hook.close()}
 assert.equal(stdio.Gs.prototype.send,stdio.original);assert.equal(connection.mB.prototype.routeIncomingMessage,connection.original);
});

test('a bootstrap module can own both network policy and backend connection hooks',async()=>{
  const combined=bootstrap.replaceAll('Pt','yY').replace('module.exports={yY};',`class ON { constructor(proc){this.connection={proc};} routeIncomingMessage(message){return message;} };module.exports={yY,ON,originalFetch:yY.prototype.fetch,originalConnection:ON.prototype.routeIncomingMessage};`);
  const fetchWrapper=main.replaceAll('wEe','Dce');
  const stdio='class Hs { constructor(proc){this.proc=proc;} send(value){return value;} };module.exports={Hs,original:Hs.prototype.send};';
  const proc=new EventEmitter(),updates=[],source={interceptHttp(){},reserveRoute(){return {baseUrl:'http://127.0.0.1:40001/fixture',ready:Promise.resolve(),close(){}};}};
  const hook=installDesktopPlaintext({app:{isReady:()=>false}},{source,deadlineUnixMs:Date.now()+1000,ownsBackendProcess:child=>child===proc,updateAccountMode:(_proc,mode)=>updates.push(mode)},
    {expectedHashes:{'bootstrap-CYu4H4X5.js':hash(combined),'main-Dn18kdv3.js':hash(fetchWrapper),'application-network-startup-DN7Ktmlk.js':hash(stdio)}});
  let network,connection,transport;
  try{
    network=compile('bootstrap-CYu4H4X5.js',combined);compile('main-Dn18kdv3.js',fetchWrapper);transport=compile('application-network-startup-DN7Ktmlk.js',stdio);
    const status=await hook.ready();assert.equal(status.available,true);assert.equal(status.taskConfigurationAvailable,true);
    connection=new network.ON(proc);connection.routeIncomingMessage({method:'account/updated',params:{authMode:'apiKey'}});assert.deepEqual(updates,['apiKey']);
    new network.ON(new EventEmitter()).routeIncomingMessage({method:'account/updated',params:{authMode:'chatgpt'}});assert.deepEqual(updates,['apiKey']);
  }finally{hook.close();}
  assert.equal(network.yY.prototype.fetch,network.originalFetch);assert.equal(network.ON.prototype.routeIncomingMessage,network.originalConnection);assert.equal(transport.Hs.prototype.send,transport.original);
});

test('native lazy initializers run once before live class bindings are hooked',async()=>{
  const lazyBootstrap='let yY,ON;module.exports={calls:0,initialize(){this.calls++;yY=class {fetch(){} request(){} };ON=class {routeIncomingMessage(message){return message;} };}};';
  const lazyStdio='let Hs;module.exports={calls:0,initialize(){this.calls++;Hs=class {send(message){return message;} };}};';
  const fetchWrapper=main.replaceAll('wEe','Dce'),source={interceptHttp(){}};
  const hook=installDesktopPlaintext({app:{isReady:()=>false}},{source,deadlineUnixMs:Date.now()+1000},
    {expectedHashes:{'bootstrap-CYu4H4X5.js':hash(lazyBootstrap),'main-Dn18kdv3.js':hash(fetchWrapper),'application-network-startup-DN7Ktmlk.js':hash(lazyStdio)}});
  try{
    const boot=compile('bootstrap-CYu4H4X5.js',lazyBootstrap),stdio=compile('application-network-startup-DN7Ktmlk.js',lazyStdio);compile('main-Dn18kdv3.js',fetchWrapper);
    assert.equal(boot.calls,0);assert.equal(stdio.calls,0);assert.equal(hook.inspect().taskConfigurationAvailable,false);
    boot.initialize();stdio.initialize();const ready=await hook.ready();assert.equal(ready.available,true);assert.equal(ready.taskConfigurationAvailable,true);
    assert.equal(boot.calls,1);assert.equal(stdio.calls,1);
  }finally{hook.close();}
});

test('initialized lazy bindings receive a final verified probe after the readiness deadline',async()=>{
  const lazyBootstrap='let Pt;module.exports={initialize(){Pt=class {fetch(){} request(){}};}};';
  const lazyMain='let wEe;module.exports={initialize(){wEe=class {performDesktopFetch(){}};}};';
  const hook=installDesktopPlaintext({app:{isReady:()=>false}},{source:{interceptHttp(){}},deadlineUnixMs:Date.now()+1000},
    {expectedHashes:{'bootstrap-DK4EfNwt.js':hash(lazyBootstrap),'main-LM8MUIFp.js':hash(lazyMain)}});
  try {
    const bootstrap=compile('bootstrap-DK4EfNwt.js',lazyBootstrap),main=compile('main-LM8MUIFp.js',lazyMain);
    assert.equal(hook.inspect().available,false);
    bootstrap.initialize();main.initialize();
    assert.equal((await hook.ready({deadlineUnixMs:Date.now()-1})).available,true);
  }finally{hook.close();}
});

test('a temporarily unavailable reviewed lexical binding is retried without invoking native factories',async()=>{
  const bootstrap='let Pt=class {fetch(){}request(){}};module.exports={Pt};',main='let wEe=class {performDesktopFetch(){}};module.exports={wEe};';
  let ready=false;
  const compileRecord=(name,source)=>{const filename=path.join(process.cwd(),name),module=new Module(filename);module.filename=filename;module.paths=Module._nodeModulePaths(process.cwd());module._compile(source+'\nmodule.exports.evaluate=expression=>eval(expression);',filename);return{name,hash:hash(source),exported:module.exports,evaluate(expression){if(!ready)throw new ReferenceError('binding not initialized');return module.exports.evaluate(expression);}};};
  const records=[compileRecord('bootstrap-DK4EfNwt.js',bootstrap),compileRecord('main-LM8MUIFp.js',main)];
  const moduleRegistry={subscribe(callback){records.forEach(callback);return()=>{};}};
  const hook=installDesktopPlaintext({app:{isReady:()=>false}},{source:{interceptHttp(){}},moduleRegistry,deadlineUnixMs:Date.now()+1000},
    {expectedHashes:Object.fromEntries(records.map(record=>[record.name,record.hash]))});
  try {assert.equal(hook.inspect().bindingErrors.main,'ReferenceError');ready=true;assert.equal((await hook.ready()).available,true);assert.deepEqual(hook.inspect().bindingErrors,{});}
  finally{hook.close();}
});

test('verified incoming messages observe an existing connection without replaying its constructor',()=>{
  const code='let created=0;class mB {constructor(){created++;this.connection={};}routeIncomingMessage(message){return message;}}module.exports={mB,created:()=>created};';
  const native=compile('src-DCNiwad_.js',code),connection=new native.mB(),observed=[];
  const record={name:'src-DCNiwad_.js',hash:hash(code),evaluate:()=>native.mB};
  let observationError=false;
  const moduleRegistry={subscribe(callback){callback(record);return()=>{};},instance(value){if(observationError)throw Error('observer unavailable');observed.push(value);}};
  const original=native.mB.prototype.routeIncomingMessage;
  const hook=installDesktopPlaintext({app:{isReady:()=>true}},{source:{interceptHttp(){}},moduleRegistry,deadlineUnixMs:Date.now()+1000},{expectedHashes:{[record.name]:record.hash}});
  try{
    const message={id:1,result:{}};
    assert.equal(connection.routeIncomingMessage(message),message);
    assert.deepEqual(observed,[connection]);assert.equal(native.created(),1);
    observationError=true;assert.equal(connection.routeIncomingMessage(message),message);
    observationError=false;hook.close();connection.routeIncomingMessage(message);
    assert.equal(observed.length,1);assert.equal(native.mB.prototype.routeIncomingMessage,original);
  }finally{hook.close();}
});

for(const outcome of ['ready','failed','retired','changed'])test('Native restart preflight preserves its owner: '+outcome,async()=>{
  const code='class mB {constructor(){this.connection={proc:{}};this.calls=[];}routeIncomingMessage(value){return value;}async restart(options){this.calls.push(options);return "restarted";}}module.exports={mB};';
  const native=compile('src-DCNiwad_.js',code),connection=new native.mB();let complete,failPreparation;
  const record={name:'src-DCNiwad_.js',hash:hash(code),evaluate:()=>native.mB};
  const original=native.mB.prototype.restart;
  const hook=installDesktopPlaintext({app:{isReady:()=>true}},{source:{interceptHttp(){}},moduleRegistry:{subscribe(callback){callback(record);return()=>{};}},deadlineUnixMs:Date.now()+1000,
    prepareBackendRestart(transport){assert.equal(transport,connection.connection);return new Promise((resolve,reject)=>{complete=resolve;failPreparation=reject;});}
  },{expectedHashes:{[record.name]:record.hash}});
  try{
    const options={intent:'restart',killCodexProcess:false},pending=connection.restart(options);
    assert.deepEqual(connection.calls,[]);
    if(outcome==='failed')failPreparation(Object.assign(Error(),{code:'backend_config_unavailable'}));
    else {if(outcome==='retired')hook.close();else if(outcome==='changed')connection.connection={proc:{}};complete();}
    assert.equal(await pending,'restarted');assert.deepEqual(connection.calls,[options]);
  }finally{hook.close();assert.equal(native.mB.prototype.restart,original);}
});

test('split stdio and connection modules require both hashes and restore their own hooks',async()=>{
  const stdio='class $s { constructor(proc){this.proc=proc;this.sent=[];} send(message){this.sent.push(JSON.parse(message));} };module.exports={Stdio:$s,original:$s.prototype.send};';
  const connection='class Yh { constructor(proc){this.connection={proc};} routeIncomingMessage(message){return message;} };module.exports={Connection:Yh,original:Yh.prototype.routeIncomingMessage};';
  const proc=new EventEmitter(), updates=[];
  const source={interceptHttp(){},reserveRoute(){return {baseUrl:'http://127.0.0.1:40001/owned',ready:Promise.resolve(),close(){}};}};
  const hook=installDesktopPlaintext({app:{isReady:()=>false}},{source,deadlineUnixMs:Date.now()+1000,ownsBackendProcess:value=>value===proc,updateAccountMode:(_proc,mode)=>updates.push(mode)},
    {expectedHashes:{'application-network-startup-CY4ZWOz-.js':hash(stdio),'src-BSSLXJxP.js':hash(connection)}});
  let transport,manager;
  try {
    transport=compile('application-network-startup-CY4ZWOz-.js',stdio);
    assert.equal(hook.inspect().taskConfigurationAvailable,false);
    manager=compile('src-BSSLXJxP.js',connection);
    assert.equal(hook.inspect().taskConfigurationAvailable,true);
    const native=new transport.Stdio(proc);
    native.send(JSON.stringify({id:1,method:'thread/start',params:{config:{'model_providers.custom.base_url':'https://provider.example/v1'}}}));
    await new Promise(resolve=>setImmediate(resolve));
    assert.equal(native.sent[0].params.config['model_providers.custom.base_url'],'http://127.0.0.1:40001/owned');
    new manager.Connection(proc).routeIncomingMessage({method:'account/updated',params:{authMode:'apikey'}});
    new manager.Connection(new EventEmitter()).routeIncomingMessage({method:'account/updated',params:{authMode:'chatgpt'}});
    assert.deepEqual(updates,['apikey']);
  } finally {hook.close();}
  assert.equal(transport.Stdio.prototype.send,transport.original);
  assert.equal(manager.Connection.prototype.routeIncomingMessage,manager.original);
  const denied=installDesktopPlaintext({app:{isReady:()=>false}},{source,deadlineUnixMs:Date.now()+1000},{expectedHashes:{'application-network-startup-CY4ZWOz-.js':'0'.repeat(64)}});
  try{compile('application-network-startup-CY4ZWOz-.js',stdio);assert.equal(denied.inspect().taskConfigurationAvailable,false);assert.equal(denied.inspect().taskConfigurationReason,'contract_unavailable');}finally{denied.close();}
});

test('verified wEe context intercepts final fetch and upload request while preserving official options', async () => {
  globalThis.fixtureRequests=[];
  const inputs=[], finalUrls=[];
  const source={ async interceptHttp(input,{forward}) { inputs.push(input); const cross=input.url.includes('/cross');const result=await forward({...input,url:cross?'https://other.example/final':input.url,body:'rewritten',credentialMode:cross?'omit':'original'}, {signal:new AbortController().signal}); finalUrls.push(result.finalUrl);
    return {...result,body:(async function*(){yield Buffer.from('modified');})()}; } };
  const hook=installDesktopPlaintext({app:{isReady:()=>false}},{source,deadlineUnixMs:Date.now()+1000},{expectedHashes:{'bootstrap-DK4EfNwt.js':hash(bootstrap),'main-LM8MUIFp.js':hash(main)}});
  try {
    const { Pt }=compile('bootstrap-DK4EfNwt.js',bootstrap);
    const { wEe }=compile('main-LM8MUIFp.js',main);
    const network=new Pt(), wrapper=new wEe(network);
    assert.equal((await hook.ready()).available,true);
    assert.equal(await (await network.fetch('https://provider.example/plain',{body:'outside'})).text(),'upstream');
    assert.equal(await (await wrapper.performDesktopFetch()).text(),'modified');
    const upload=await wrapper.performDesktopFetch({progress:true});
    assert.equal(await new Response(Readable.toWeb(upload)).text(),'modified');
    const redirected=await wrapper.performDesktopFetch({progress:true,redirect:true});
    assert.equal(await new Response(Readable.toWeb(redirected)).text(),'modified');
    assert.equal(finalUrls.at(-1),'https://other.example/final');
    assert.equal(inputs[2].url,'https://provider.example/redirect');
    await wrapper.performDesktopFetch({cross:true});
    const crossUpload=await wrapper.performDesktopFetch({progress:true,cross:true});
    await new Response(Readable.toWeb(crossUpload)).text();
    assert.equal(globalThis.fixtureRequests.at(-2).credentials,'omit');
    assert.equal(globalThis.fixtureRequests.at(-1).useSessionCookies,false);
    assert(!Object.keys(globalThis.fixtureRequests.at(-2).headers).some(name=>['authorization','cookie'].includes(name.toLowerCase())));
    assert(!Object.keys(globalThis.fixtureRequests.at(-1).headers).some(name=>['authorization','cookie'].includes(name.toLowerCase())));
    assert.deepEqual(inputs.map(value=>value.body),['original','original','original','original','original']);
    assert.equal(globalThis.fixtureRequests[0].body,'outside');
    assert(globalThis.fixtureRequests.slice(1).every(value=>value.body===undefined || String(value.body)==='rewritten'));
    assert.equal(globalThis.fixtureRequests[1].credentials,'include');
    assert.equal(globalThis.fixtureRequests[2].useSessionCookies,true);
  } finally { hook.close(); delete globalThis.fixtureRequests; }
});

test('native ClientRequest follows redirects and reports the actual final origin to Core', async () => {
  globalThis.fixtureRequests=[];const seen=[], finals=[];
  const source={async interceptHttp(input,{forward}) {seen.push(input);const result=await forward({...input,credentialMode:'original'},{signal:new AbortController().signal});finals.push(result.finalUrl);return result;}};
  const hook=installDesktopPlaintext({app:{isReady:()=>false}},{source,deadlineUnixMs:Date.now()+1000},{expectedHashes:{'bootstrap-DK4EfNwt.js':hash(bootstrap),'main-LM8MUIFp.js':hash(main)}});
  try {
    const {Pt}=compile('bootstrap-DK4EfNwt.js',bootstrap),{wEe}=compile('main-LM8MUIFp.js',main);
    assert.equal(await (await new wEe(new Pt()).performDesktopFetch({redirect:true})).text(),'upstream');
    assert.deepEqual(seen.map(value=>value.url),['https://provider.example/fetch-redirect']);
    assert.deepEqual(finals,['https://other.example/final']);
    assert.equal(globalThis.fixtureRequests[0].credentials,'include');
    assert.equal(globalThis.fixtureRequests[0].method,'POST');
  } finally {hook.close();delete globalThis.fixtureRequests;}
});

test('every native redirect updates the final origin and rechecks Desktop policy', async () => {
  globalThis.fixtureRequests=[];const finalUrls=[];
  const source={async interceptHttp(input,{forward}) {const result=await forward({...input,credentialMode:'original'},{signal:new AbortController().signal});finalUrls.push(result.finalUrl);return result;}};
  const hook=installDesktopPlaintext({app:{isReady:()=>false}},{source,deadlineUnixMs:Date.now()+1000},{expectedHashes:{'bootstrap-DK4EfNwt.js':hash(bootstrap),'main-LM8MUIFp.js':hash(main)}});
  try {
    const {Pt}=compile('bootstrap-DK4EfNwt.js',bootstrap),{wEe}=compile('main-LM8MUIFp.js',main);
    assert.equal(await (await new wEe(new Pt()).performDesktopFetch({multi:true})).text(),'upstream');
    assert.deepEqual(finalUrls,['https://other.example/final']);
  } finally {hook.close();delete globalThis.fixtureRequests;}

  globalThis.fixtureRequests=[];
  const restricted=bootstrap.replace("if (!url.startsWith", "if (url.endsWith('/middle') || !url.startsWith");
  const denied=installDesktopPlaintext({app:{isReady:()=>false}},{source,deadlineUnixMs:Date.now()+1000},{expectedHashes:{'bootstrap-DK4EfNwt.js':hash(restricted),'main-LM8MUIFp.js':hash(main)}});
  try {
    const {Pt}=compile('bootstrap-DK4EfNwt.js',restricted),{wEe}=compile('main-LM8MUIFp.js',main);
    await assert.rejects(new wEe(new Pt()).performDesktopFetch({multi:true}),/policy/u);
  } finally {denied.close();delete globalThis.fixtureRequests;}
});

test('fetch same-origin credentials supply the origin required by Electron ClientRequest', async () => {
  globalThis.fixtureRequests=[];
  const source={async interceptHttp(input,{forward}) {return forward({...input,credentialMode:'original'},{signal:new AbortController().signal});}};
  const sameOriginMain=main.replace("credentials:'include'", "credentials:'same-origin'");
  const hook=installDesktopPlaintext({app:{isReady:()=>false}},{source,deadlineUnixMs:Date.now()+1000},{expectedHashes:{'bootstrap-DK4EfNwt.js':hash(bootstrap),'main-LM8MUIFp.js':hash(sameOriginMain)}});
  try {
    const {Pt}=compile('bootstrap-DK4EfNwt.js',bootstrap),{wEe}=compile('main-LM8MUIFp.js',sameOriginMain);
    assert.equal(await (await new wEe(new Pt()).performDesktopFetch()).text(),'upstream');
    assert.equal(globalThis.fixtureRequests[0].credentials,'same-origin');
    assert.equal(globalThis.fixtureRequests[0].origin,'https://provider.example');
  } finally {hook.close();delete globalThis.fixtureRequests;}
});

test('native redirect keeps the request actually forwarded and plugin credential omission', async () => {
  globalThis.fixtureRequests=[];const seen=[];
  const source={async interceptHttp(input,{forward}) {
    seen.push(input);
    const rewrite=input.url.endsWith('/fetch-redirect-307') ? {...input,method:'PUT',body:'effective-body',credentialMode:'original'}
      : input.url.endsWith('/cross-chain') ? {...input,url:'https://other.example/cross-chain-start',credentialMode:'omit'}
      : {...input,credentialMode:'original'};
    return forward(rewrite,{signal:new AbortController().signal});
  }};
  const hook=installDesktopPlaintext({app:{isReady:()=>false}},{source,deadlineUnixMs:Date.now()+1000},{expectedHashes:{'bootstrap-DK4EfNwt.js':hash(bootstrap),'main-LM8MUIFp.js':hash(main)}});
  try {
    const {Pt}=compile('bootstrap-DK4EfNwt.js',bootstrap),{wEe}=compile('main-LM8MUIFp.js',main),wrapper=new wEe(new Pt());
    await wrapper.performDesktopFetch({redirect307:true});
    assert.equal(seen.length,1);
    assert.equal(globalThis.fixtureRequests[0].method,'PUT');
    assert.equal(globalThis.fixtureRequests[0].body,'effective-body');
    seen.length=0;globalThis.fixtureRequests=[];
    await wrapper.performDesktopFetch({crossChain:true});
    assert.equal(seen.length,1);
    assert.equal(globalThis.fixtureRequests[0].credentials,'omit');
  } finally {hook.close();delete globalThis.fixtureRequests;}
});

test('native redirect denies a destination rejected by the official network policy', async () => {
  globalThis.fixtureRequests=[];
  const source={async interceptHttp(input,{forward}) {return forward({...input,credentialMode:'original'},{signal:new AbortController().signal});}};
  const restricted=bootstrap.replace("!url.startsWith('https://other.example/')", "true");
  const hook=installDesktopPlaintext({app:{isReady:()=>false}},{source,deadlineUnixMs:Date.now()+1000},{expectedHashes:{'bootstrap-DK4EfNwt.js':hash(restricted),'main-LM8MUIFp.js':hash(main)}});
  try {
    const {Pt}=compile('bootstrap-DK4EfNwt.js',restricted),{wEe}=compile('main-LM8MUIFp.js',main);
    await assert.rejects(new wEe(new Pt()).performDesktopFetch({redirect:true}),/policy/u);
  } finally {hook.close();delete globalThis.fixtureRequests;}
});

test('an aborted Desktop fetch cancels the original Electron request', async () => {
  let started; const dispatched=new Promise(resolve=>{started=resolve});globalThis.fixtureAborted=false;
  const hangingBootstrap=`class Pt {assertAllowed(){}fetch(){throw Error('unexpected original fetch')}request(){const call=new (require('node:events').EventEmitter)();call.abort=()=>{globalThis.fixtureAborted=true;call.emit('error',Error('aborted'))};call.end=()=>globalThis.fixtureStarted();return call}};module.exports={Pt};`;
  const cancellableMain=`class wEe {constructor(network){this.network=network}performDesktopFetch(signal){return this.network.fetch('https://provider.example/hang',{method:'GET',signal})}};module.exports={wEe};`;
  const source={interceptHttp(input,{forward,signal}) {return forward({...input,credentialMode:'original'},{signal});}};
  globalThis.fixtureStarted=started;
  const hook=installDesktopPlaintext({app:{isReady:()=>false}},{source,deadlineUnixMs:Date.now()+1000},{expectedHashes:{'bootstrap-DK4EfNwt.js':hash(hangingBootstrap),'main-LM8MUIFp.js':hash(cancellableMain)}});
  try {
    const {Pt}=compile('bootstrap-DK4EfNwt.js',hangingBootstrap),{wEe}=compile('main-LM8MUIFp.js',cancellableMain);
    const controller=new AbortController(), pending=new wEe(new Pt()).performDesktopFetch(controller.signal);
    await dispatched;controller.abort();
    await assert.rejects(pending,{code:'desktop_request_aborted'});
    assert.equal(globalThis.fixtureAborted,true);
  } finally {hook.close();delete globalThis.fixtureAborted;delete globalThis.fixtureStarted;}
});

test('bodyless Desktop responses release each source exchange, including HEAD', async () => {
  let active=0,cancelled=0;
  const bodylessMain=`class wEe {constructor(network){this.network=network}performDesktopFetch(method='GET'){return this.network.fetch('https://provider.example/bodyless',{method})}};module.exports={wEe};`;
  const source={async interceptHttp(input) {
    if (++active > 4) throw Error('source capacity exhausted');
    return {status:input.method==='HEAD'?200:204,headers:[],body:{async cancel(){active--;cancelled++},async *[Symbol.asyncIterator](){yield Buffer.from('unwanted')}}};
  }};
  const hook=installDesktopPlaintext({app:{isReady:()=>false}},{source,deadlineUnixMs:Date.now()+1000},{expectedHashes:{'bootstrap-DK4EfNwt.js':hash(bootstrap),'main-LM8MUIFp.js':hash(bodylessMain)}});
  try {
    const {Pt}=compile('bootstrap-DK4EfNwt.js',bootstrap),{wEe}=compile('main-LM8MUIFp.js',bodylessMain),wrapper=new wEe(new Pt());
    for(let index=0;index<6;index++) assert.equal((await wrapper.performDesktopFetch()).body,null);
    assert.equal((await wrapper.performDesktopFetch('HEAD')).body,null);
    assert.equal(active,0);assert.equal(cancelled,7);
  } finally {hook.close();}
});

test('task-local Responses provider is routed at Stdio JSONL send without changing model or provider choice', () => {
  const input={id:1,method:'thread/start',params:{model:'chosen-model',modelProvider:'custom',config:{'model_providers.custom':{name:'Custom',wire_api:'responses',base_url:'https://original.example/v1',requires_openai_auth:false}}}};
  const urls=[];
  const output=JSON.parse(routedThreadMessage(JSON.stringify(input),url=>{urls.push(url);return 'http://127.0.0.1:43210/route/';}));
  assert.deepEqual(urls,['https://original.example/v1']);
  assert.equal(output.params.model,input.params.model);
  assert.equal(output.params.modelProvider,input.params.modelProvider);
  assert.equal(output.params.config['model_providers.custom'].base_url,'http://127.0.0.1:43210/route/');
  assert.equal(input.params.config['model_providers.custom'].base_url,'https://original.example/v1');
  assert.equal(routedThreadMessage(JSON.stringify({...input,method:'turn/start'}),()=>{throw Error('must not route');}),JSON.stringify({...input,method:'turn/start'}));
  assert.throws(()=>routedThreadMessage(JSON.stringify({...input,params:{...input.params,config:{'model_providers.custom.base_url':'https://user:secret@original.example/v1'}}}),()=>''),{code:'backend_provider_unsupported'});
  assert.throws(()=>routedThreadMessage(JSON.stringify({...input,params:{...input.params,config:{'model_providers.bad.name.base_url':'https://original.example/v1'}}}),()=>''),{code:'backend_provider_unsupported'});
  assert.throws(()=>routedThreadMessage(JSON.stringify({id:3,method:'thread/start',params:{modelProvider:'unverified-chat'}}),()=>'',provider=>provider==='openai'),{code:'backend_provider_unsupported'});
  const whole=JSON.parse(routedThreadMessage(JSON.stringify({...input,params:{...input.params,config:{model_providers:{custom:{wire_api:'responses',base_url:'https://original.example/v1'}}}}}),()=> 'http://127.0.0.1:43210/route/'));
  assert.equal(whole.params.config.model_providers.custom.base_url,'http://127.0.0.1:43210/route/');
});

test('verified local Stdio hook covers renderer and internal JSONL sends; other processes retain original data', async t => {
  const directory=fs.mkdtempSync(path.join(os.tmpdir(),'codlet-stdio-'));t.after(()=>fs.rmSync(directory,{recursive:true,force:true}));
  const filename=path.join(directory,'src-C3YaUE83.js');
  const sourceCode=`class mQ {constructor(proc){this.proc=proc;this.sent=[];}send(message){this.sent.push(message)}} class un {constructor(connection){this.connection=connection;}routeIncomingMessage(message){return message}} module.exports={dn:mQ,un};`;
  fs.writeFileSync(filename,sourceCode);
  const owned=new EventEmitter(), other=new EventEmitter(), reservations=[], modes=[];
  const source={interceptHttp(){},reserveRoute({upstreamBaseUrl}) { const route={baseUrl:'http://127.0.0.1:45678/route/',ready:Promise.resolve(),close(){},upstreamBaseUrl};reservations.push(route);return route; }};
  const hook=installDesktopPlaintext({app:{isReady:()=>false}},{source,deadlineUnixMs:Date.now()+1000,ownsBackendProcess:proc=>proc===owned,updateAccountMode:(proc,mode)=>modes.push([proc,mode])},{expectedHashes:{'src-C3YaUE83.js':hash(sourceCode)}});
  try {
    const {dn,un}=createRequire(import.meta.url)(filename), request=JSON.stringify({id:2,method:'thread/start',params:{config:{'model_providers.custom.base_url':'https://provider.example/v1'}}});
    const local=new dn(owned), unrelated=new dn(other);
    local.send(request);unrelated.send(request);
    await new Promise(resolve=>setImmediate(resolve));
    assert.equal(JSON.parse(local.sent[0]).params.config['model_providers.custom.base_url'],'http://127.0.0.1:45678/route/');
    assert.equal(unrelated.sent[0],request);
    assert.equal(reservations[0].upstreamBaseUrl,'https://provider.example/v1');
    const manager=new un(local);manager.routeIncomingMessage({method:'account/updated',params:{authMode:'chatgpt'}});
    assert.deepEqual(modes,[[owned,'chatgpt']]);
  } finally {hook.close();}
});

test('unsupported Stdio source leaves verified Desktop fetch source available', async () => {
  const source={interceptHttp(input,{forward}) {return forward(input,{signal:new AbortController().signal});}};
  const hook=installDesktopPlaintext({app:{isReady:()=>false}},{source,deadlineUnixMs:Date.now()+1000},{expectedHashes:{
    'bootstrap-DK4EfNwt.js':hash(bootstrap),'main-LM8MUIFp.js':hash(main),'src-C3YaUE83.js':'0'.repeat(64),
  }});
  try {
    compile('bootstrap-DK4EfNwt.js',bootstrap);compile('main-LM8MUIFp.js',main);
    compile('src-C3YaUE83.js','class mQ{};module.exports={};');
    const state=await hook.ready();
    assert.equal(state.available,true);assert.equal(state.taskConfigurationAvailable,false);
    assert.equal(state.reason,null);assert.equal(state.taskConfigurationReason,'contract_unavailable');
  } finally {hook.close();}
});
