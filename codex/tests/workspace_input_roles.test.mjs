import test from 'node:test';
import assert from 'node:assert/strict';
import {createRequire} from 'node:module';
import {inspectNativeInput} from '../frontend/src/adapter/workspace-native-input.js';
import {nativeMainInput} from '../frontend/src/adapter/workspace-dom.js';
const require=createRequire(new URL('../frontend/package.json',import.meta.url)),{JSDOM}=require('jsdom');

function fixture(t){
  const dom=new JSDOM('<div id="root"></div>'),document=dom.window.document,root=document.getElementById('root'),current={};
  t.after(()=>dom.window.close());
  const composerScope={},RouteScope={},native={composerScope,RouteScope,draftKey:value=>value.clientThreadId};
  root.__reactContainer$roles={stateNode:{current}};
  const models=[];
  function input(threadId,pathname='/local/'+threadId){
    const element=document.createElement('div');element.dataset.codexComposerRoot='';root.append(element);
    const value={kind:'local',placement:'main',conversationId:threadId,clientThreadId:'local:'+threadId};
    const facade={scope:composerScope,node:{},value,getOwnValue:token=>token===RouteScope?{pathname,search:''}:null};
    function Composer(){return 'onDocumentChange onDocumentDispose composerController';}
    const model={type:Composer,memoizedState:{memoizedState:{current:facade}},memoizedProps:{onSubmitLocal(){assert.fail('submit');},submitDisabled:false},return:current};
    const owner={stateNode:element,return:model};model.child=owner;element.__reactFiber$roles=owner;
    if(models.length)models.at(-1).sibling=model;else current.child=model;models.push(model);
    const editors=[];
    function editor(key){
      const editable=document.createElement('div');editable.contentEditable='true';editable.setAttribute('contenteditable','true');element.append(editable);
      const controller={view:{dom:editable,isDestroyed:false},getPersistedText(){assert.fail('read draft');},restoreDraft(){assert.fail('write draft');}};
      function EditorProvider(){return 'getInitialContent getInitialInput onDocumentChange onDocumentDispose pending-input-ready';}
      const provider={type:EditorProvider,key,memoizedState:{memoizedState:{current:{controller}}},return:owner};
      provider.child={tag:10,memoizedProps:{value:controller},return:provider};
      if(editors.length)editors.at(-1).provider.sibling=provider;else owner.child=provider;
      const result={editable,controller,provider};editors.push(result);return result;
    }
    return {element,editor,value};
  }
  return {document,root,native,input};
}

test('independent request editors are excluded by the Native draft namespace, regardless of DOM order',t=>{
  const f=fixture(t),input=f.input('main'),request=input.editor('request:pending-question'),main=input.editor(input.value.clientThreadId);
  assert.equal(inspectNativeInput(f.native,input.element,f.root).controller,main.controller);
  input.element.prepend(main.editable);
  assert.equal(inspectNativeInput(f.native,input.element,f.root).controller,main.controller);
  request.provider.key=input.value.clientThreadId;
  assert.throws(()=>inspectNativeInput(f.native,input.element,f.root),/ambiguous/,'two actual draft owners remain ambiguous');
  request.provider.key='request:pending-question';
  assert.throws(()=>inspectNativeInput({...f.native,draftKey:undefined},input.element,f.root),/ambiguous/,'unknown ownership cannot select the first editor');
});

test('retained Native inputs must match the live navigation route before main-input uniqueness',t=>{
  const f=fixture(t),previous=f.input('previous'),active=f.input('active');
  const oldEditor=previous.editor(previous.value.clientThreadId);active.editor(active.value.clientThreadId);
  let pathname='/local/active';f.native.currentRoute=()=>({pathname,search:''});
  oldEditor.controller.view.isDestroyed=true;
  assert.equal(nativeMainInput(f.document,f.native).input,active.element);
  oldEditor.controller.view.isDestroyed=false;
  pathname='/local/previous';
  assert.equal(nativeMainInput(f.document,f.native).input,previous.element);
  const duplicate=f.input('duplicate','/local/previous');duplicate.editor(duplicate.value.clientThreadId);
  assert.throws(()=>nativeMainInput(f.document,f.native),/ambiguous/);
});
