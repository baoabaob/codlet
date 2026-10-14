import assert from 'node:assert/strict';
import test from 'node:test';
import {createRequire} from 'node:module';
import {createNativePermissionReader} from '../frontend/src/desktop/native-permissions.js';
const require=createRequire(new URL('../frontend/package.json',import.meta.url)),{JSDOM}=require('jsdom');

function fixture(t){
  const dom=new JSDOM('<div id="root"><div data-codex-composer-root><div contenteditable="true"></div><button data-composer-navigation-target="permissions">Native</button></div></div>');t.after(()=>dom.window.close());
  const document=dom.window.document,root=document.getElementById('root'),input=root.firstElementChild,editable=input.firstElementChild,button=input.lastElementChild;
  const brand=name=>({__scopeBrand:name,id:Symbol(name)}),native={composerScope:brand('ComposerScope'),ThreadScope:brand('ThreadScope'),RouteScope:brand('RouteScope')};
  const chain=new Map(),scopeNode={value:{kind:'local',placement:'main',hostId:'local',conversationId:'thread-a',clientThreadId:'client-a'}};
  for(const token of [native.composerScope,native.ThreadScope,native.RouteScope])chain.set(token.id,token===native.composerScope?scopeNode:{token,value:token===native.ThreadScope?{clientThreadId:'client-a',hostId:'local'}:{conversationId:'thread-a',hostId:'local'}});
  scopeNode.token=native.composerScope;
  const scope={scope:native.composerScope,node:scopeNode,value:scopeNode.value,chain,getOwnValue:token=>chain.get(token.id).value};
  const windows={hasError:false,isPending:false,isRequired:false,requirement:null},appToken=brand('AppScope');
  const family={scope:appToken,read:()=>windows};chain.set(appToken.id,{token:appToken,familyBindings:new Map([[family,new Map([['local',{}]])]])});
  function Composer(onDocumentChange,onDocumentDispose,composerController){}
  function Picker(permissionProfilesOverride,setAgentMode,setPermissionProfileId){}
  const current={stateNode:{}},composer={type:Composer,memoizedState:{memoizedState:{current:scope}},return:current},inputFiber={stateNode:input,return:composer,memoizedProps:{onSubmitLocal(){},submitDisabled:false}};
  current.child=composer;composer.child=inputFiber;root.__reactContainer$synthetic={stateNode:{current}};input.__reactFiber$synthetic=inputFiber;
  const controller={view:{dom:editable,isDestroyed:false},getPersistedText(){throw Error('Draft must not be read');},restoreDraft(){}},provider={tag:10,memoizedProps:{value:controller},return:inputFiber},editFiber={stateNode:editable,return:provider};
  inputFiber.child=provider;provider.child=editFiber;editable.__reactFiber$synthetic=editFiber;
  const config={resolvedConfig:{},requirements:{},isConfigDataPending:false,isProjectless:false},agent={agentMode:'auto',permissionProfileId:null,isAutoReviewRequiredForSelectedModel:false,shouldSendPermissionOverrides:true},thread={threadMode:'auto',threadPermissionProfileId:null,threadSandboxPolicy:{type:'workspaceWrite',writableRoots:['native-root']}},model={model:'normal-model',isLoading:false};
  const item=(id,disabled=false)=>({props:{disabled,onClick(){},children:{props:{id}}}}),defaultItem=item('composer.permissionsDropdown.default.approvalOptionLabel'),fullItem=item('composer.permissionsDropdown.fullAccess.optionLabel'),customItem=item('composer.permissionsDropdown.custom.optionLabel');
  const values=[config,{...config},agent,thread,model,{hostId:'local',cwd:'native-cwd'},{hostId:'local',cwd:'native-cwd'},defaultItem,fullItem,customItem];
  const picker={type:Picker,return:inputFiber,memoizedProps:{conversationId:'thread-a',hostId:'local'},updateQueue:{memoCache:{data:[values]}}},trigger={stateNode:button,return:picker};provider.sibling=picker;picker.child=trigger;
  const conversation={cwd:'different-manager-cwd',latestThreadSettings:{approvalPolicy:'on-request',sandboxPolicy:{type:'workspaceWrite'}}};
  const calls=[],convert=(mode,roots,config)=>{calls.push({mode,roots,config});return{approvalPolicy:mode==='full-access'?'never':'on-request',sandboxPolicy:{type:mode==='full-access'?'dangerFullAccess':'workspaceWrite',writableRoots:roots},runtimeWorkspaceRoots:roots};};
  const reader=createNativePermissionReader({document,manager:{getConversation:()=>conversation},native,
    reduce:config=>({availableAgentModes:['read-only','auto','granular','full-access','custom'],canShowCustom:true}),convert,
    toSettings:value=>value.activePermissionProfile?{permissions:value.activePermissionProfile.id}:{sandboxPolicy:value.sandboxPolicy},
    modeFromPolicy:value=>value.approvalPolicy==='never'?'full-access':'auto',profileMode:(value,fallback)=>value===':workspace'?fallback:value===':danger-full-access'?'full-access':value===':read-only'?'read-only':null,
    defaultMode:()=> 'auto',windowsMode:({defaultWorkspaceWriteMode,isWindowsSandboxRequired})=>isWindowsSandboxRequired?'read-only':defaultWorkspaceWriteMode,
    cyberModel:value=>value.includes('cyber')||value.includes('daybreak')});
  return{reader,values,config,agent,thread,model,windows,conversation,calls,fullItem,customItem,input,picker,button,editable,document};
}

test('committed Native permission reads accept equivalent hook inputs and use Native thread roots rather than manager cwd',t=>{
  const f=fixture(t),snapshot=f.reader.read('thread-a');assert.equal(snapshot.phase,'ready');assert.deepEqual(snapshot.options.map(value=>value.selection.mode),['auto','full-access','custom']);
  const settings=f.reader.convert('thread-a',{kind:'agent-mode',mode:'auto'});assert.deepEqual(settings.sandboxPolicy.writableRoots,['native-root']);assert.equal(f.calls.some(value=>value.roots.includes('different-manager-cwd')),false);
  f.thread.threadSandboxPolicy={type:'readOnly'};f.reader.convert('thread-a',{kind:'agent-mode',mode:'auto'});assert.deepEqual(f.calls.at(-1).roots,['native-cwd']);
});

test('Native menu visibility, Windows requirements and model restrictions constrain public choices',t=>{
  const f=fixture(t);f.values.splice(f.values.indexOf(f.fullItem),1);assert.equal(f.reader.read('thread-a').options.some(value=>value.selection.mode==='full-access'),false);
  f.windows.isRequired=true;assert.equal(f.reader.read('thread-a').options[0].selection.mode,'read-only');
  f.agent.isAutoReviewRequiredForSelectedModel=true;assert.equal(f.reader.read('thread-a').options.every(value=>!value.enabled),true);
  assert.throws(()=>f.reader.convert('thread-a',{kind:'agent-mode',mode:'full-access'}),{code:'permissions_unavailable'});
});

test('Full access carries Native confirmation and retains the stronger model warning',t=>{
  const f=fixture(t);let full=f.reader.read('thread-a').options.find(value=>value.selection.mode==='full-access');assert.equal(full.requiresConfirmation,true);assert.equal(full.confirmation.kind,'native-full-access');assert.equal(full.confirmation.capabilities.length,3);assert.equal(full.confirmation.modelWarning,null);
  f.model.model='cyber-model';full=f.reader.read('thread-a').options.find(value=>value.selection.mode==='full-access');assert.match(full.confirmation.modelWarning,/higher risk/);assert.match(full.confirmation.risk,/strongly recommend/);
  f.model.isLoading=true;assert.equal(f.reader.read('thread-a').options.find(value=>value.selection.mode==='full-access').enabled,false);
});

test('equivalent cached Native model classifications retain Full access while conflicting classifications fail closed',t=>{
  const f=fixture(t);f.values.push({model:'another-normal-model',isLoading:false});
  let full=f.reader.read('thread-a').options.find(value=>value.selection.mode==='full-access');assert.equal(full.enabled,true);assert.equal(full.confirmation.modelWarning,null);
  f.model.model='cyber-model';full=f.reader.read('thread-a').options.find(value=>value.selection.mode==='full-access');assert.equal(full.enabled,false);
  f.values.at(-1).model='daybreak-model';full=f.reader.read('thread-a').options.find(value=>value.selection.mode==='full-access');assert.equal(full.enabled,true);assert.match(full.confirmation.modelWarning,/higher risk/);
});

test('conflicting Native cwd inputs and an unconfirmed thread never produce guessed permission settings',t=>{
  const f=fixture(t);f.values.push({hostId:'local',cwd:'foreign-cwd'});assert.equal(f.reader.read('thread-a').phase,'unsupported');assert.throws(()=>f.reader.convert('thread-a',{kind:'agent-mode',mode:'auto'}),{code:'permissions_unsupported'});
  assert.throws(()=>f.reader.read('thread-b'),{code:'permissions_not_selected'});
});

test('latest Native named profile is returned and sent through Native wire conversion without raw private data',t=>{
  const f=fixture(t);f.values.push({key:'native-profile',props:{children:'native-profile',disabled:false,onClick(){}}});f.conversation.latestThreadSettings={permissions:'native-profile',activePermissionProfile:{id:'native-profile'},approvalPolicy:'on-request'};
  const snapshot=f.reader.read('thread-a',{canonical:true});assert.deepEqual(snapshot.selection,{kind:'profile',profileId:'native-profile'});assert.deepEqual(f.reader.convert('thread-a',snapshot.selection),{permissions:'native-profile'});assert.equal(f.reader.canonical('thread-a').permissions,'native-profile');assert.equal(JSON.stringify(snapshot).includes('native-root'),false);assert.equal('resolvedConfig'in snapshot,false);
});

test('permission DOM commits emit bounded invalidations while draft and owned Core UI mutations are ignored',async t=>{
  const f=fixture(t),events=[],stop=f.reader.subscribe(id=>events.push(id));f.reader.read('thread-a');
  f.editable.textContent='synthetic unsent draft';const owned=f.document.createElement('span');owned.dataset.codletWorkspaceOwned='consumer';f.input.insertBefore(owned,f.button);owned.textContent='Core control';
  await new Promise(resolve=>setImmediate(resolve));assert.equal(events.length,0);
  f.button.disabled=true;await new Promise(resolve=>setImmediate(resolve));assert.deepEqual(events,['thread-a']);
  stop();f.button.disabled=false;await new Promise(resolve=>setImmediate(resolve));assert.equal(events.length,1);f.reader.dispose();
});

test('unmodified conversations preserve Native effective submission choices instead of silently adopting a different canonical policy',t=>{
  const f=fixture(t);let snapshot=f.reader.read('thread-a');assert.equal(snapshot.selection.mode,'auto');assert.equal(snapshot.source,'unknown','equal values do not prove an independent registered source');f.agent.agentMode='full-access';snapshot=f.reader.read('thread-a');assert.deepEqual(snapshot.selection,{kind:'agent-mode',mode:'full-access'});assert.equal(snapshot.source,'unknown');
  f.agent.shouldSendPermissionOverrides=false;snapshot=f.reader.read('thread-a');assert.deepEqual(snapshot.selection,{kind:'server-default'});assert.equal(snapshot.source,'unknown');
  snapshot=f.reader.read('thread-a',{canonical:true});assert.deepEqual(snapshot.selection,{kind:'agent-mode',mode:'auto'});assert.equal(snapshot.source,'thread');
  delete f.agent.shouldSendPermissionOverrides;assert.equal(f.reader.read('thread-a').phase,'unsupported');
});

test('conflicting cached Native menu records cannot replace a disabled option with an enabled duplicate',t=>{
  const f=fixture(t),duplicate={props:{...f.fullItem.props}};f.values.push(duplicate);assert.equal(f.reader.read('thread-a').phase,'ready');
  duplicate.props.disabled=true;assert.equal(f.reader.read('thread-a').phase,'loading');assert.throws(()=>f.reader.convert('thread-a',{kind:'agent-mode',mode:'full-access'}),{code:'permissions_loading'});
  f.values.splice(f.values.indexOf(duplicate),1);
  f.values.push({key:'named',props:{children:'named',disabled:true,onClick(){}}},{key:'named',props:{children:'named',disabled:false,onClick(){}}});assert.equal(f.reader.read('thread-a').phase,'loading');
});
