import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import Module,{createRequire} from 'node:module';
import {EventEmitter} from 'node:events';
const require=createRequire(import.meta.url);
const {observeModules}=require('../../runtime/client-bridge-bundle.cjs');
const {installDesktopPlaintext}=require('../host/electron-plaintext.cjs');
const {supportsRole}=require('../host/source-contracts.cjs');
const network=`const electron={net:{fetch:async()=>new Response('native'),request(){throw Error('unused request');}}};
class FutureNetwork { assertAllowed(url){if(!url.startsWith('https://provider.example/'))throw Error('policy');}
fetch(url,options){this.assertAllowed(url);return electron.net.fetch(url,options);}
request(options){this.assertAllowed(options.url);return electron.net.request(options);} } module.exports=FutureNetwork;`;
const wrapper=`class FutureFetch {constructor(network){this.options={applicationNetwork:network};}
performDesktopFetch(url,options={}){this.options.applicationNetwork.assertAllowed(url);if(options.progress)return this.performProgressRequest(url);return this.options.applicationNetwork.fetch(url,options);}
performProgressRequest(url){return this.options.applicationNetwork.request({url});} } module.exports=FutureFetch;`;
const stdio=`class FutureStdio {constructor(proc){this.proc=proc;this.readyState=1;this.ioStatsTracker={trackWritten(){}};}
send(message){if(this.readyState!==1)throw Error('closed');const line=message+'\\n';this.ioStatsTracker.trackWritten(Buffer.byteLength(line));this.proc.stdin.write(line);} } module.exports=FutureStdio;`;
const connection=`class FutureConnection {constructor(proc){this.connection={proc};}
routeIncomingMessage(message){if(message.method==='account/updated'){this.clearAuthTokenCache();return message.params?.authMode;}return message;}
clearAuthTokenCache(){} getPendingRequestCount(){return 0;} restart(){return Promise.resolve();} } module.exports=FutureConnection;`;
function setup(t){
  const root=fs.mkdtempSync(path.join(os.tmpdir(),'codlet-source-contract-'));
  const registry=observeModules(root,Symbol.for('codlet.source.test.'+path.basename(root))),calls=[];
  const proc=new EventEmitter();proc.stdin={write:value=>calls.push(value)};
  const source={async interceptHttp(value){calls.push(value);return{status:200,headers:[],body:Buffer.from('intercepted')};},
    reserveRoute(){return{baseUrl:'http://127.0.0.1:34567/owned/',ready:Promise.resolve(),close(){}};}};
  const hook=installDesktopPlaintext({app:{isReady:()=>false}},{source,moduleRegistry:registry,deadlineUnixMs:Date.now()+550,ownsBackendProcess:value=>value===proc});
  t.after(()=>{hook.close();registry.close();assert.equal(path.dirname(path.resolve(root)),path.resolve(os.tmpdir()));fs.rmSync(root,{recursive:true});});
  function compile(name,code){const filename=path.join(root,name),module=new Module(filename);module.filename=filename;module.paths=Module._nodeModulePaths(root);module._compile(code,filename);return module.exports;}
  return{hook,registry,compile,calls,proc};
}
test('network URL normalization and JSONL templates satisfy the same delegation contracts',()=>{
  class Network {
    assertAllowed(){}
    fetch(input,options){this.assertAllowed(input);const url=input instanceof URL?input.href:input;return this.electron.net.fetch(url,options);}
    request(options){return this.assertAllowed(options.url),this.electron.net.request(options);}
  }
  class Stdio {
    send(message){if(this.readyState!==1)throw Error('closed');const line=`${message}\n`;this.ioStatsTracker.trackWritten(Buffer.byteLength(line));this.proc.stdin.write(line);}
  }
  assert.equal(supportsRole(Network,'network'),true);assert.equal(supportsRole(Stdio,'stdio'),true);
});
test('unlisted filenames and renamed classes retain each proven source capability',async t=>{
  const f=setup(t),Network=f.compile('new-network.js',network),Fetch=f.compile('new-fetch.js',wrapper),Stdio=f.compile('new-transport.js',stdio);
  f.compile('new-connection.js',connection);
  const status=await f.hook.ready();assert.equal(status.available,true);assert.equal(status.taskConfigurationAvailable,true);
  assert.equal(status.mismatch,null);
  const instance=new Network();assert.equal(await(await instance.fetch('https://provider.example/plain')).text(),'native');
  assert.equal(await(await new Fetch(instance).performDesktopFetch('https://provider.example/responses')).text(),'intercepted');
  assert.equal(f.calls.length,1);
  new Stdio(f.proc).send(JSON.stringify({id:1,method:'thread/start',params:{config:{'model_providers.custom.base_url':'https://provider.example/v1'}}}));
  await new Promise(resolve=>setImmediate(resolve));
  assert.match(f.calls[1],/127\.0\.0\.1:34567\/owned/u);
});
test('a changed Stdio method disables only task routing despite matching method names',async t=>{
  const f=setup(t);f.compile('network.js',network);f.compile('fetch.js',wrapper);
  f.compile('transport.js',stdio.replace('this.proc.stdin.write(line)','this.queue.push(line) /* this.proc.stdin.write(line) */'));f.compile('connection.js',connection);
  const status=await f.hook.ready();assert.equal(status.available,true);assert.equal(status.taskConfigurationAvailable,false);
  assert.equal(status.taskConfigurationReason,'contract_unavailable');
});
test('a later patch retires only its affected hook and is preserved on cleanup',async t=>{
  const f=setup(t),Network=f.compile('network.js',network),Fetch=f.compile('fetch.js',wrapper);
  f.compile('transport.js',stdio);f.compile('connection.js',connection);assert.equal((await f.hook.ready()).available,true);
  const previous=Fetch.prototype.performDesktopFetch,external=function(...args){return previous.apply(this,args);};Fetch.prototype.performDesktopFetch=external;
  assert.equal(await(await new Fetch(new Network()).performDesktopFetch('https://provider.example/responses')).text(),'native');assert.equal(f.calls.length,0);
  const status=f.hook.inspect();assert.equal(status.available,false);assert.equal(status.reason,'binding_changed');assert.equal(status.taskConfigurationAvailable,true);
  f.hook.close();assert.equal(Fetch.prototype.performDesktopFetch,external);
});
test('ambiguous desktop wrappers retire only desktop interception and retain task routing',async t=>{
  const f=setup(t);f.compile('network.js',network);const First=f.compile('first.js',wrapper);
  f.compile('transport.js',stdio);f.compile('connection.js',connection);
  assert.equal((await f.hook.ready()).available,true);
  f.compile('second.js',wrapper.replaceAll('FutureFetch','OtherFetch'));
  const status=await f.hook.ready();assert.equal(status.available,false);assert.equal(status.reason,'ambiguous_contract');assert.equal(status.taskConfigurationAvailable,true);
  assert.ok(First.prototype.performDesktopFetch.toString().includes('applicationNetwork.fetch'));
});
