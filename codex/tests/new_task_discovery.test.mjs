import test from 'node:test';
import assert from 'node:assert/strict';
import {newTaskHook} from '../frontend/src/adapter/discovery.js';

function action(name){return new Function(`return function ${name}(){return {startInSidebar:true,focusComposerNonce:0,codexAppMode:'codex',freshDraft:true,prefillComposerMode:'local',prepareNavigation:true}}`)();}
function hook(body){return new Function(`return function useDraft(){let context=useContext(owner);${body}}`)();}

test('new-task hooks call the exact free action binding, including dollar identifiers',()=>{
  for(const name of ['$po','startDraft','开始']){
    const start=action(name),useDraft=hook(`return options=>${name}(context,options)`);
    assert.equal(newTaskHook({start,useDraft,alias:useDraft}),useDraft);
  }
});

test('new-task discovery rejects member calls, longer names, text and shadowed bindings',()=>{
  const start=action('$po');
  for(const body of ['return options=>other.$po(context,options)','return options=>other$po(context,options)','return "$po(context,options)"','const $po=other;return options=>$po(context,options)','return ($po)=>$po(context)','return function $po(){return $po(context)}'])
    assert.equal(newTaskHook({start,useDraft:hook(body)}),undefined,body);
  const useDraft=hook('return options=>$po(context,options)');
  assert.equal(newTaskHook({start,useDraft,other:hook('return options=>$po(context,options)')}),undefined);
  assert.equal(newTaskHook({start,otherAction:action('other'),useDraft}),undefined);
});
