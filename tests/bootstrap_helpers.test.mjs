import assert from 'node:assert/strict';
import {readFileSync} from 'node:fs';
import {MessageChannel} from 'node:worker_threads';
import test from 'node:test';
import {uiFixture,uiSource,tick} from './support/ui-fixture.mjs';

const bootstrap=readFileSync(new URL('../bundled/runtime/bootstrap.js',import.meta.url),'utf8');
const helpers=readFileSync(new URL('../bundled/runtime/helpers.js',import.meta.url),'utf8');
const facade=readFileSync(new URL('../bundled/runtime/facade.js',import.meta.url),'utf8');
const page=readFileSync(new URL('../bundled/runtime/page.js',import.meta.url),'utf8');
test('retiring the real UI SDK closes its scheduler ports and preserves the native client channel',async t=>{
  const f=uiFixture(),channels=[];
  class MeasuredChannel extends MessageChannel{
    constructor(){super();const record={channel:this,open:2};channels.push(record);for(const port of [this.port1,this.port2]){const close=port.close.bind(port);let closed=false;port.close=()=>{if(!closed){closed=true;record.open--;}close();};}}
  }
  f.window.MessageChannel=MeasuredChannel;
  const native=new MeasuredChannel();let received;
  native.port1.onmessage=event=>{received=event.data;};
  t.after(()=>{for(const {channel} of channels)for(const port of [channel.port1,channel.port2]){port.onmessage=null;port.close();}f.dispose();});
  const stage=()=>{
    f.window.eval(`(${helpers})((MessageChannel)=>(${uiSource}),null,null,(${page}),(${bootstrap}))`);
    return f.window.eval(`(${facade})({world:'isolated',lazyUI:true,retireOnEmpty:true})`);
  };
  assert.equal(stage().ok,true);await tick();assert.equal(channels.reduce((n,x)=>n+x.open,0),2,'unused helpers must not start a scheduler');
  assert.equal((await f.window.eval(`__codletRendererV1.activate({id:'ui-owner',generation:1},{activate(ctx){globalThis.ownedUi=ctx.ui.create();ownedUi.mount(ownedUi.container(),ownedUi.React.createElement(ownedUi.components.Button,{color:'primary'},'Actual SDK'));},deactivate(){ownedUi.dispose();delete globalThis.ownedUi;}})`)).ok,true);
  await tick();assert.ok(f.control('Actual SDK'));assert.ok(channels.reduce((n,x)=>n+x.open,0)>2,'exercise the real SDK MessageChannel branch, absent in default jsdom');
  assert.equal((await f.window.__codletRendererV1.deactivate('ui-owner',1)).ok,true);await tick();
  assert.equal(f.control('Actual SDK'),undefined);assert.equal(f.window.MessageChannel,MeasuredChannel,'page constructor was never patched');
  assert.equal(channels.reduce((n,x)=>n+x.open,0),2,'only the native client channel remains open');
  for(const entry of channels.slice(1))assert.equal(entry.channel.port1.onmessage,null,'closed channels must release callback closures');
  native.port2.postMessage('native still works');await tick();assert.equal(received,'native still works');
});

test('all main-world generations must retire before replacement bootstrap and helper factories take ownership',async t=>{
 const f=uiFixture(),channels=[];
 class MeasuredChannel extends MessageChannel{constructor(){super();const entry={channel:this,open:2};channels.push(entry);for(const port of [this.port1,this.port2]){const close=port.close.bind(port);let closed=false;port.close=()=>{if(!closed){entry.open--;closed=true}close()}}}}
 f.window.MessageChannel=MeasuredChannel;const native=new MeasuredChannel();
 t.after(()=>{for(const {channel} of channels)for(const port of [channel.port1,channel.port2]){port.onmessage=null;port.close()}f.dispose()});
 const stage=marker=>{
  const changed=bootstrap.replace('const world =',`globalThis.bootstrapMarker=${JSON.stringify(marker)}; const world =`);
  f.window.eval(`(${helpers})((MessageChannel)=>{globalThis.helpersMarker=${JSON.stringify(marker)};return (${uiSource})},null,null,(${page}),(${changed}),()=>Object.freeze({marker:${JSON.stringify(marker)}}))`);
  return f.window.eval(`(${facade})({world:'main',lazyUI:true})`);
 };
 const activate=(id,generation)=>f.window.eval(`__codletRendererV1.activate({id:${JSON.stringify(id)},generation:${generation}},{activate(ctx){const ui=ctx.ui.create();const event=()=>{globalThis.events=(globalThis.events??0)+1};globalThis.addEventListener('owned-test',event);ctx.onDeactivate(()=>{globalThis.removeEventListener('owned-test',event);ui.dispose()});ui.mount(ui.container(),ui.React.createElement(ui.components.Button,{color:'primary'},ctx.codex.marker));globalThis.factoryMarker=ctx.codex.marker},deactivate(){}})`);
 assert.equal(stage('old').ok,true);assert.equal((await activate('first',1)).ok,true);assert.equal((await activate('second',1)).ok,true);await tick();
 const old=f.window.__codletRendererV1;assert.equal(f.window.factoryMarker,'old');assert.equal(f.window.helpersMarker,'old');
 assert.equal(stage('candidate').reused,true);assert.equal(f.window.__codletRendererV1,old);assert.equal(f.window.helpersMarker,'old','candidate helpers are never initialized while old owners remain');
 assert.equal((await old.deactivate('second',1)).ok,true);assert.equal(f.window.__codletRendererV1,old);f.window.dispatchEvent(new f.window.Event('owned-test'));assert.equal(f.window.events,1);
 assert.equal((await old.deactivate('first',1)).ok,true);await tick();assert.equal(f.window.__codletRendererV1,undefined);assert.equal(channels.reduce((sum,entry)=>sum+entry.open,0),2,'old factory scheduler ports retired');
 f.window.dispatchEvent(new f.window.Event('owned-test'));assert.equal(f.window.events,1,'old listeners retired');assert.equal((await old.activate({id:'stale',generation:2},{})).ok,false);
 assert.equal(stage('next').reused,false);assert.equal((await activate('first',2)).ok,true);await tick();assert.equal(f.window.bootstrapMarker,'next');assert.equal(f.window.helpersMarker,'next');assert.equal(f.window.factoryMarker,'next');assert.ok(f.control('next'));
 f.window.dispatchEvent(new f.window.Event('owned-test'));assert.equal(f.window.events,2);await f.window.__codletRendererV1.deactivate('first',2);await tick();assert.equal(channels.reduce((sum,entry)=>sum+entry.open,0),2);
});
