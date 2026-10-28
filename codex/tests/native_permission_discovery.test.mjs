import test from 'node:test';
import assert from 'node:assert/strict';
import {loadNativePermissions} from '../frontend/src/desktop/native-permissions.js';
import {NATIVE_PERMISSION_FUNCTIONS,matchesNativePermissionSource} from '../frontend/src/desktop/permission-contracts.js';

function fixture(){
  const scopes=Object.fromEntries(['ComposerScope','ThreadScope','RouteScope'].map(name=>[name,{__scopeBrand:name,id:Symbol(name)}]));
  const functions={
    reduce(){return ['availableAgentModes','canShowCustom','configNonFullAccessMode','hasAuthoritativeGuardianApprovalDefault','showGuardianOption'];},
    convert(a,b,c){return ['read-only','full-access','guardian-approvals','runtimeWorkspaceRoots','sandbox_workspace_write'];},
    toSettings(a){return ['activePermissionProfile','sandboxPolicy','permissions:'];},
    modeFromPolicy(a){return a.approvalPolicy??a.sandboxPolicy??'custom';},
    profileMode(a,b){return [':read-only',':workspace',':danger-full-access'];},
    defaultMode:function defaultMode(a){return a.isProjectless&&allowed('granular',a.requirements)?'granular':'auto';},
    windowsMode(a){return a.isWindowsSandboxRequired?'read-only':a.defaultWorkspaceWriteMode;},
    cyberModel:function model(a){let text=a.toLowerCase();return text.includes('cyber')||text.includes('daybreak');},
    agentState(a){return ['shouldSendPermissionOverrides','setAgentModePreference','setPermissionProfileId','threadSandboxPolicy','getNonFullAccessFallbackMode'];},
  };
  const initial={...scopes,...functions},shared={alias:scopes.ComposerScope},urls={initial:'app://-/assets/app-initial-test.js',shared:'app://-/assets/app-shared-test.js'};
  const picker=`import {agentState as useState} from './app-initial-test.js';function Picker(props){const memo=(0,compiler.c)(1);const {permissionProfilesOverride}=props;const {agentMode,permissionProfileId,setAgentMode,setPermissionProfileId,shouldSendPermissionOverrides}=useState(props);return null;}`;
  return{initial,shared,picker,options:{document:{},manager:{},asset:role=>urls[role],load:async url=>url===urls.initial?initial:shared,
    read:async url=>url===urls.initial?'const deps=["./permissions-mode-dropdown-test.js"];':picker}};
}
test('permissions resolve migrated scopes and functions while deduplicating their module aliases',async()=>{
  const f=fixture(),reader=await loadNativePermissions(f.options);reader.dispose();
  f.shared.convert=f.initial.convert;delete f.initial.convert;
  const next=await loadNativePermissions(f.options);next.dispose();
  f.shared.other={__scopeBrand:'ComposerScope',id:Symbol('foreign')};
  await assert.rejects(loadNativePermissions(f.options),{code:'desktop_contract_drift'});
});
test('the broader permission warning classifier is distinguished from the daybreak-red model classifier',()=>{
  const contract=NATIVE_PERMISSION_FUNCTIONS.cyberModel;
  function normal(model){let value=model.toLowerCase();return value.includes('cyber')||value.includes('daybreak');}
  function narrow(model){let value=model.toLowerCase();return value.includes('cyber')||value.includes('daybreak-red');}
  assert.equal(matchesNativePermissionSource(normal.toString(),1,contract),true);
  assert.equal(matchesNativePermissionSource(narrow.toString(),1,contract),false);
});

test('permission conversion accepts the optional profile argument and rejects other arity drift',async()=>{
  const f=fixture();
  f.initial.convert=function convert(mode,roots,config,profile){return ['read-only','full-access','guardian-approvals','runtimeWorkspaceRoots','sandbox_workspace_write'];};
  const reader=await loadNativePermissions(f.options);reader.dispose();
  for(const arity of [0,1,2,5])assert.equal(matchesNativePermissionSource(f.initial.convert.toString(),arity,NATIVE_PERMISSION_FUNCTIONS.convert),false);
});

test('permission discovery rejects a same-shape picker call bound to a different module export',async()=>{
  const f=fixture();f.initial.foreign=()=>({});
  f.options.read=async url=>url.includes('app-initial-')?'const deps=["./permissions-mode-dropdown-test.js"];':f.picker.replace('agentState as useState','foreign as useState');
  await assert.rejects(loadNativePermissions(f.options),{code:'permissions_unsupported'});
});

test('default workspace mode resolves its own policy inputs rather than a React consumer',async()=>{
  const f=fixture();
  f.initial.defaultMode=function renamed({isProjectless:projectless,requirements:rules}){return projectless&&allowed('granular',rules)?'granular':'auto';};
  f.initial.consumer=function component(props){const state=usePolicy(props);return {isProjectless:state.isProjectless,requirements:state.requirements,granular:true,auto:true,defaultMode:f.initial.defaultMode(state)};};
  const reader=await loadNativePermissions(f.options);reader.dispose();
  const source=f.initial.defaultMode.toString(),contract=NATIVE_PERMISSION_FUNCTIONS.defaultMode;
  assert.equal(matchesNativePermissionSource(source,1,contract),true);
  assert.equal(matchesNativePermissionSource(source.replace("?'granular':'auto'","?'auto':'granular'"),1,contract),false);
  assert.equal(matchesNativePermissionSource(source.replace("'granular',rules","'granular',foreign"),1,contract),false);
  f.initial.other=function other({isProjectless:p,requirements:r}){return p&&allowed('granular',r)?'granular':'auto';};
  await assert.rejects(loadNativePermissions(f.options),{code:'desktop_contract_drift'});
});
