import assert from 'node:assert/strict';
import test from 'node:test';
import {createRequire} from 'node:module';
import {permissionPickerEvidence} from './fixtures/workspace-acceptance/native-permission-ownership-readonly.js';
const require=createRequire(new URL('../frontend/package.json',import.meta.url)),{JSDOM}=require('jsdom');

function fixture(t){
  const dom=new JSDOM('<div id="root"><footer data-thread-scroll-footer><div data-codex-composer-root><div id="wrapper"><button data-composer-navigation-target="permissions"><span>Icon</span></button></div></div></footer></div>');t.after(()=>dom.window.close());
  const document=dom.window.document,root=document.getElementById('root'),input=document.querySelector('[data-codex-composer-root]'),wrapper=document.getElementById('wrapper'),trigger=document.querySelector('button');
  function LegacyPicker(){return 'conversationId permissionProfilesOverride setAgentMode setPermissionProfileId';}
  const current={},owner={stateNode:input,return:current},picker={type:LegacyPicker,memoizedProps:{conversationId:'fixture-five',hostId:'local'},return:owner},host={stateNode:wrapper,return:picker},button={stateNode:trigger,return:host};
  current.child=owner;owner.child=picker;picker.child=host;host.child=button;
  root.__reactContainer$probe={stateNode:{current}};input.__reactFiber$probe=owner;
  trigger.__reactFiber$probe={stateNode:trigger,return:host}; // Detached attachment.
  return{root,current,owner,input:{input,scope:{value:{conversationId:'fixture-five'}}},binding:{threadId:'fixture-five'},wrapper,trigger,host,picker};
}

test('permission evidence proves a current nearby host when the Native trigger attachment is detached',t=>{
  const f=fixture(t);f.wrapper.__reactFiber$probe=f.host;
  const result=permissionPickerEvidence(f.trigger,f.input,f.binding,f.root);
  assert.equal(result.proof,'ancestor');assert.equal(result.implementation,'legacy');assert.equal(result.conversationMatchesStrictBinding,true);assert.equal(result.hostLocal,true);
  assert.equal(JSON.stringify(result).includes('fixture-five'),false);
});

test('permission evidence searches only the committed input branch when nearby DOM attachments are absent',t=>{
  const f=fixture(t),result=permissionPickerEvidence(f.trigger,f.input,f.binding,f.root);
  assert.equal(result.proof,'input-branch');assert.equal(result.committed,true);assert.equal(result.conversationMatchesInput,true);assert.ok(result.visited<=2048);
  assert.equal(result.diagnostics.triggerBranchHosts,1);assert.equal(result.diagnostics.triggerBranchCurrentChains,1);assert.ok(result.diagnostics.sourceRoles.legacy>0);
});

test('permission evidence carries proven child paths without requiring Native descendant return pointers',t=>{
  const f=fixture(t);f.picker.return=null;f.host.return=null;f.host.child.return=null;
  const result=permissionPickerEvidence(f.trigger,f.input,f.binding,f.root);
  assert.equal(result.proof,'input-branch');assert.equal(result.committed,true);assert.equal(result.conversationMatchesStrictBinding,true);
  assert.equal(result.diagnostics.triggerBranchCurrentChains,1);assert.equal(JSON.stringify(result).includes('fixture-five'),false);
});

test('permission branch depth is relative to the proven input rather than consuming its whole ancestor budget',t=>{
  const f=fixture(t);let child=f.owner;
  for(let i=0;i<254;i++){const parent={child};child.return=parent;child=parent;}
  child.return=f.current;f.current.child=child;
  const result=permissionPickerEvidence(f.trigger,f.input,f.binding,f.root);
  assert.equal(result.diagnostics.inputChainDepth,256);assert.equal(result.proof,'input-branch');assert.equal(result.conversationMatchesStrictBinding,true);
  assert.ok(result.diagnostics.maxRelativeDepth<=128);assert.equal(result.diagnostics.truncatedDepth,0);
});

test('an unproven permission implementation reports unknown identity instead of a false binding mismatch',t=>{
  const f=fixture(t);f.picker.type=()=> 'unrecognized';
  const result=permissionPickerEvidence(f.trigger,f.input,f.binding,f.root);
  assert.equal(result.implementation,'unknown');assert.equal(result.conversationPresent,null);assert.equal(result.conversationMatchesInput,null);assert.equal(result.conversationMatchesStrictBinding,null);
});
