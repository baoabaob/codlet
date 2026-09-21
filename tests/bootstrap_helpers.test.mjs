import assert from 'node:assert/strict';
import {readFileSync} from 'node:fs';
import {MessageChannel} from 'node:worker_threads';
import test from 'node:test';
import {uiFixture,uiSource,tick} from './support/ui-fixture.mjs';

const bootstrap=readFileSync(new URL('../bundled/runtime/bootstrap.js',import.meta.url),'utf8');
const helpers=readFileSync(new URL('../bundled/runtime/helpers.js',import.meta.url),'utf8');
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
    f.window.eval(`(${helpers})((MessageChannel)=>(${uiSource}))`);
    return f.window.eval(`(()=>{const helpers=globalThis.__codletRendererHelpersV1;delete globalThis.__codletRendererHelpersV1;return (${bootstrap})({world:'isolated',lazyUI:true,retireOnEmpty:true},helpers.ui,helpers.i18n,helpers.services,helpers.dispose);})()`);
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
