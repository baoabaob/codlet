import assert from 'node:assert/strict';
import test from 'node:test';
import {createRequire} from 'node:module';
import {createNativePermissionReader} from '../frontend/src/desktop/native-permissions.js';
import {currentPermissionCache,permissionCachePlan,permissionPickerBindings} from '../frontend/src/adapter/native-permission-cache.js';
const require=createRequire(new URL('../frontend/package.json',import.meta.url)),{JSDOM}=require('jsdom');

function fixture(t,agentState,bindings){
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
  const reader=createNativePermissionReader({document,manager:{getConversation:()=>conversation},native,agentState,bindings,
    reduce:config=>({availableAgentModes:['read-only','auto','granular','full-access','custom'],canShowCustom:true}),convert,
    toSettings:value=>value.activePermissionProfile?{permissions:value.activePermissionProfile.id}:{sandboxPolicy:value.sandboxPolicy},
    modeFromPolicy:value=>value.approvalPolicy==='never'?'full-access':'auto',profileMode:(value,fallback)=>value===':workspace'?fallback:value===':danger-full-access'?'full-access':value===':read-only'?'read-only':null,
    defaultMode:()=> 'auto',windowsMode:({defaultWorkspaceWriteMode,isWindowsSandboxRequired})=>isWindowsSandboxRequired?'read-only':defaultWorkspaceWriteMode,
    cyberModel:value=>value.includes('cyber')||value.includes('daybreak')});
  return{reader,values,config,agent,thread,model,windows,conversation,calls,fullItem,customItem,input,picker,button,editable,document,nativeInput:{input,scope}};
}

function compilerSource(offset=0){
  const a={inputs:[offset,offset+1],config:offset+2,sandbox:offset+3,mode:offset+4,profile:offset+5,override:offset+6,result:offset+7};
  const v={mode:[offset+8,offset+9],profile:offset+10,review:offset+11,input:offset+12};
  // These synthetic functions are never called. Their assignments exercise the
  // same compiler dataflow as Native, with independently movable cache roles.
  const AgentState=Function(`return function PermissionState(input){
    let memo=(0,compiler.c)(9999),{conversationId,cwdOverride,hostId}=input,first,second;
    first={conversationId,cwdOverride,hostId};memo[${a.inputs[0]}]=first;
    second={conversationId,hostId,cwdOverride};memo[${a.inputs[1]}]=second;
    let config=readConfig(first),{threadMode,threadSandboxPolicy,threadPermissionProfileId}=readThread(conversationId);
    let review=readModel(),override=readOverride();memo[${a.config}]=config.resolvedConfig;memo[${a.sandbox}]=threadSandboxPolicy;
    memo[${a.mode}]=threadMode;memo[${a.profile}]=threadPermissionProfileId;memo[${a.override}]=override;
    if(early&&!review)return{agentMode:threadMode,permissionProfileId:threadPermissionProfileId,isAutoReviewRequiredForSelectedModel:review,shouldSendPermissionOverrides:override,setAgentModePreference(){},setPermissionProfileId(){},getNonFullAccessFallbackMode(){}};
    let result;return changed?(result={agentMode:otherMode,permissionProfileId:otherProfile,isAutoReviewRequiredForSelectedModel:review,shouldSendPermissionOverrides:otherOverride},memo[${a.result}]=result):result=memo[${a.result}],result;
  }`)();
  const Picker=Function(`return function PermissionPicker(props){
    let memo=(0,compiler.c)(7777);const {permissionProfilesOverride,conversationId,hostId,cwdOverride,disableDefaultPermissions,disableCustomPermissions}=props;let args;
    args={conversationId,hostId,cwdOverride};memo[${v.input}]=args;
    const {agentMode,permissionProfileId,isAutoReviewRequiredForSelectedModel,shouldSendPermissionOverrides,setAgentMode,setPermissionProfileId}=readState(args);
    const {canSelectGuardianMode:guardian}=readGuardian();
    const mode=disableDefaultPermissions&&disableCustomPermissions&&agentMode!=='full-access'&&guardian?'guardian-approvals':agentMode;
    memo[${v.mode[0]}]=mode;memo[${v.mode[1]}]=mode;memo[${v.profile}]=permissionProfileId;memo[${v.review}]=isAutoReviewRequiredForSelectedModel;return null;
  }`)();
  const url='app://-/assets/permissions-mode-dropdown-synthetic.js',initial='app://-/assets/app-initial-synthetic.js';
  const module=`import {state as readState} from './app-initial-synthetic.js';${Picker.toString()}`;
  const bindings=permissionPickerBindings(module,url,new Map([[initial,{state:AgentState}]]),AgentState);
  return{AgentState,Picker,a,v,bindings,module,url,initial};
}
function uncachedFixture(t,offset=0){
  const source=compilerSource(offset),f=fixture(t,source.AgentState,source.bindings),sentinel=Symbol.for('react.memo_cache_sentinel');
  f.values.splice(f.values.indexOf(f.agent),1);f.thread.threadMode='custom';f.thread.threadSandboxPolicy={type:'readOnly'};
  const args={conversationId:'thread-a',hostId:'local',cwdOverride:undefined},agentFrame=Array(offset+8).fill(sentinel),viewFrame=Array(offset+12).fill(sentinel);
  for(const index of source.a.inputs)agentFrame[index]=args;
  agentFrame[source.a.config]=f.config.resolvedConfig;agentFrame[source.a.sandbox]=f.thread.threadSandboxPolicy;
  agentFrame[source.a.mode]=f.thread.threadMode;agentFrame[source.a.profile]=null;agentFrame[source.a.override]=false;
  for(const index of source.v.mode)viewFrame[index]='custom';viewFrame[source.v.profile]=null;viewFrame[source.v.review]=false;viewFrame[source.v.input]=args;
  f.picker.type=source.Picker;f.picker.updateQueue.memoCache.data=[f.values,viewFrame,agentFrame];
  return{...f,...source,args,agentFrame,viewFrame,sentinel};
}

test('a loaded-thread compiler branch can return permission state without retaining its result object',t=>{
  const f=uncachedFixture(t),cache=currentPermissionCache(f.document,f.nativeInput,{agentState:f.AgentState,bindings:f.bindings});
  assert.equal(cache.agentProvenance,'uncached-return');assert.deepEqual(cache.agents,[{agentMode:'custom',permissionProfileId:null,isAutoReviewRequiredForSelectedModel:false,shouldSendPermissionOverrides:false}]);
  f.fullItem.props.disabled=true;
  const snapshot=f.reader.read('thread-a');assert.equal(snapshot.phase,'ready');assert.deepEqual(snapshot.selection,{kind:'server-default'});
  assert.equal(snapshot.options.find(option=>option.selection.mode==='full-access').enabled,false);
  assert.throws(()=>f.reader.convert('thread-a',{kind:'agent-mode',mode:'full-access'}),{code:'permissions_unavailable'});
});

test('compiler cache roles follow lexical assignments after relocation without a cache-length profile',t=>{
  const f=uncachedFixture(t,311),plan=permissionCachePlan(f.Picker.toString(),f.AgentState.toString(),{callee:'readState'});
  assert.equal(plan.resultSlot,f.a.result);assert.deepEqual(plan.viewMode,f.v.mode);
  f.picker.updateQueue.memoCache.data.unshift([],[]);f.agentFrame.length=12000;
  assert.equal(f.reader.read('thread-a').phase,'ready');
  const changed=f.AgentState.toString().replace('if(early&&!review)','if(early||!review)');
  assert.equal(permissionCachePlan(f.Picker.toString(),changed,{callee:'readState'}),null,'an unproven model guard cannot authorize an early-return projection');
});

test('permission cache projections require the exact current Native input and config/sandbox objects',t=>{
  for(const mutate of [f=>{f.args.conversationId='foreign-thread';},f=>{f.agentFrame[f.a.config]={...f.config.resolvedConfig};},f=>{f.agentFrame[f.a.sandbox]={...f.thread.threadSandboxPolicy};},f=>{f.viewFrame[f.v.review]=true;},f=>{f.picker.updateQueue.memoCache.data.push([...f.agentFrame]);}]){
    const f=uncachedFixture(t);mutate(f);assert.equal(f.reader.read('thread-a').phase,'unsupported');
  }
  const f=uncachedFixture(t);f.input.__reactFiber$synthetic.child=null;
  assert.throws(()=>currentPermissionCache(f.document,f.nativeInput,{agentState:f.AgentState,bindings:f.bindings}),{code:'permissions_unsupported'});
});

test('same-shape permission consumers must import the actual loaded Native hook object',t=>{
  const f=uncachedFixture(t),foreign=function ForeignState(){};
  assert.equal(f.bindings.size,1);
  assert.equal(permissionPickerBindings(f.module,f.url,new Map([[f.initial,{state:foreign}]]),f.AgentState).size,0);
  assert.equal(permissionPickerBindings(f.module.replace('state as readState','foreign as readState'),f.url,new Map([[f.initial,{state:f.AgentState,foreign}]]),f.AgentState).size,0);
  assert.equal(permissionCachePlan(f.Picker.toString(),f.AgentState.toString(),{callee:'foreignState'}),null);
  f.bindings.clear();assert.equal(f.reader.read('thread-a').phase,'unsupported');
});

test('unresolved permission field identities and changed return flow are not equivalent bindings',()=>{
  const f=compilerSource(),picker=f.Picker.toString(),source=f.AgentState.toString(),plan=text=>permissionCachePlan(picker,text,{callee:'readState'});
  assert.ok(plan(source));
  for(const changed of [
    source.replaceAll('!review','!foreign.review').replaceAll('isAutoReviewRequiredForSelectedModel:review','isAutoReviewRequiredForSelectedModel:foreign.review'),
    source.replaceAll('!review','!false').replaceAll('isAutoReviewRequiredForSelectedModel:review','isAutoReviewRequiredForSelectedModel:false'),
    source.replace('agentMode:threadMode','agentMode:null'),
    source.replace('{threadMode,threadSandboxPolicy','{threadMode:threadMode=null,threadSandboxPolicy').replace('agentMode:threadMode','agentMode:null'),
    source.replace('permissionProfileId:threadPermissionProfileId','permissionProfileId:foreign.profile'),
    source.replace('shouldSendPermissionOverrides:override','shouldSendPermissionOverrides:foreign.override'),
    source.replace('result=memo[7],result','result=memo[6],result'),
    source.replace('result=memo[7],result','result=memo[7],foreign'),
  ])assert.equal(plan(changed),null);
  assert.equal(permissionCachePlan(picker.replace('readState(args)','readState(null)'),source,{callee:'readState'}),null);
  assert.equal(permissionCachePlan(picker.replace('readState(args)','foreign.readState(args)'),source,{callee:'readState'}),null);
  assert.equal(permissionCachePlan(picker.replace('const mode=','disableDefaultPermissions=true;const mode='),source,{callee:'readState'}),null);
});

test('picker projections prove the raw mode branch and its current input object',t=>{
  const f=uncachedFixture(t);
  const changed=f.Picker.toString().replace('disableDefaultPermissions&&disableCustomPermissions','disableDefaultPermissions||disableCustomPermissions');
  assert.equal(permissionCachePlan(changed,f.AgentState.toString(),{callee:'readState'}),null);
  f.viewFrame[f.v.input]={...f.args,conversationId:'old-thread'};assert.equal(f.reader.read('thread-a').phase,'unsupported');
  f.viewFrame[f.v.input]=f.args;f.picker.memoizedProps.disableDefaultPermissions=null;assert.equal(f.reader.read('thread-a').phase,'unsupported');
});

test('a stale cached branch cannot supply a different Native permission override decision',t=>{
  const f=uncachedFixture(t),cached={agentMode:'custom',permissionProfileId:null,isAutoReviewRequiredForSelectedModel:false,shouldSendPermissionOverrides:true};
  f.agentFrame[f.a.result]=cached;f.values.push(cached);
  assert.equal(f.reader.read('thread-a').phase,'unsupported');
  cached.shouldSendPermissionOverrides=false;assert.equal(f.reader.read('thread-a').phase,'ready');
  cached.agentMode='auto';assert.equal(f.reader.read('thread-a').phase,'ready','the current picker disproves the stale cached branch');
  f.viewFrame[f.v.mode[0]]=f.viewFrame[f.v.mode[1]]='auto';assert.deepEqual(f.reader.read('thread-a').selection,{kind:'server-default'});
  cached.shouldSendPermissionOverrides=true;assert.equal(f.reader.read('thread-a').selection.mode,'auto');
});

test('the proven cached return retains Native model-review restrictions',t=>{
  const f=uncachedFixture(t),cached={agentMode:'custom',permissionProfileId:null,isAutoReviewRequiredForSelectedModel:true,shouldSendPermissionOverrides:false};
  f.agentFrame[f.a.result]=cached;f.values.push(cached);f.viewFrame[f.v.review]=true;
  const cache=currentPermissionCache(f.document,f.nativeInput,{agentState:f.AgentState,bindings:f.bindings});
  assert.equal(cache.agentProvenance,'memoized-return');assert.equal(cache.agents[0],cached);
  const snapshot=f.reader.read('thread-a');assert.equal(snapshot.phase,'ready');assert.equal(snapshot.options.every(option=>!option.enabled),true);
  Object.assign(f.picker.memoizedProps,{disableDefaultPermissions:true,disableCustomPermissions:true});
  for(const index of f.v.mode)f.viewFrame[index]='guardian-approvals';
  assert.equal(f.reader.read('thread-a').phase,'ready');assert.equal(f.reader.read('thread-a').options.every(option=>!option.enabled),true);
});

test('Native boolean disable gates retain cached permission reads and their actual guardian display mapping',t=>{
  for(const [disableDefaultPermissions,disableCustomPermissions,display] of [[true,true,'guardian-approvals'],[true,false,'custom'],[false,true,'custom'],[true,undefined,'custom'],[undefined,true,'custom']]){
    const f=uncachedFixture(t),cached={agentMode:'custom',permissionProfileId:null,isAutoReviewRequiredForSelectedModel:false,shouldSendPermissionOverrides:false};
    Object.assign(f.picker.memoizedProps,{disableDefaultPermissions,disableCustomPermissions});
    f.agentFrame[f.a.result]=cached;for(const index of f.v.mode)f.viewFrame[index]=display;
    f.fullItem.props.disabled=true;f.customItem.props.disabled=true;
    const cache=currentPermissionCache(f.document,f.nativeInput,{agentState:f.AgentState,bindings:f.bindings});
    assert.equal(cache.agentProvenance,'memoized-return');assert.equal(cache.agents[0],cached);
    const snapshot=f.reader.read('thread-a');assert.equal(snapshot.phase,'ready');assert.deepEqual(snapshot.selection,{kind:'server-default'});
    assert.equal(snapshot.options.find(option=>option.selection.mode==='full-access').enabled,false);
    if(disableDefaultPermissions)assert.equal(snapshot.options.find(option=>option.selection.mode==='auto').enabled,false);
  }
});

test('guardian display mapping cannot hide distinct possible raw permission states or override decisions',t=>{
  const f=uncachedFixture(t);Object.assign(f.picker.memoizedProps,{disableDefaultPermissions:true,disableCustomPermissions:true});
  for(const index of f.v.mode)f.viewFrame[index]='guardian-approvals';
  f.agentFrame[f.a.result]={agentMode:'custom',permissionProfileId:null,isAutoReviewRequiredForSelectedModel:false,shouldSendPermissionOverrides:true};
  assert.equal(f.reader.read('thread-a').phase,'unsupported','the display mapping does not resolve a conflicting override');
  f.agentFrame[f.a.result].shouldSendPermissionOverrides=false;f.agentFrame[f.a.result].agentMode='auto';
  assert.equal(f.reader.read('thread-a').phase,'unsupported','different raw modes may map to the same guardian display');
  f.agentFrame[f.a.result].agentMode='full-access';assert.equal(f.reader.read('thread-a').phase,'ready','full access cannot take the guardian display branch, so the current early result is unique');
});

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
