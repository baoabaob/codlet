import assert from 'node:assert/strict';
import fs from 'node:fs';
import {createRequire} from 'node:module';
import test from 'node:test';
import {sampleWorkspaceNavigation} from '../docs/examples/sample-workspace-navigation.mjs';
const {JSDOM}=createRequire(new URL('../frontend/package.json',import.meta.url))('jsdom');
test('usage banner example releases Native markers, observers and scheduled work on forced retirement',async()=>{
  const dom=new JSDOM('<!doctype html><aside class="relative isolate bg-surface"><h3>You’re out of Codex and Work usage</h3><button>Add credits</button></aside>',{runScripts:'outside-only'});
  const w=dom.window,callbacks=[],frames=new Map();let serial=0;
  w.requestAnimationFrame=callback=>{frames.set(++serial,callback);return serial;};w.cancelAnimationFrame=id=>frames.delete(id);
  w.module={exports:{}};
  w.eval(fs.readFileSync(new URL('../examples/hide-usage-banner/renderer.js',import.meta.url),'utf8'));
  const plugin=w.module.exports;
  try{
    plugin.activate({generation:1,onDeactivate:callback=>callbacks.push(callback)});
    assert.equal(w.document.querySelectorAll('[data-codlet-hide-usage-banner]').length,1);
    await Promise.resolve();const late=[...frames.values()];assert.equal(callbacks.length,1);
    callbacks[0]();for(const callback of late)callback();
    assert.equal(frames.size,0);assert.equal(w.document.querySelectorAll('[data-codlet-hide-usage-banner],style').length,0);
    plugin.deactivate();
  }finally{dom.window.close();}
});
test('navigation example releases its operation on executed failure and committed failure',async()=>{
  for(const stage of ['executed','committed']){
    let disposed=0;
    const failure=Error(stage),operation={executed:stage==='executed'?Promise.reject(failure):Promise.resolve({}),get committed(){return Promise.reject(failure);},dispose(){disposed++;}};
    await assert.rejects(sampleWorkspaceNavigation({getSnapshot:()=>({threadId:'thread'})},{open:()=>operation},'thread'),error=>error===failure);
    assert.equal(disposed,1);
  }
});
