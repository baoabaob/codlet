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
    defaultMode(a){return a.isProjectless?a.requirements:'granular'+'auto';},
    windowsMode(a){return a.isWindowsSandboxRequired?'read-only':a.defaultWorkspaceWriteMode;},
    cyberModel:function model(a){let text=a.toLowerCase();return text.includes('cyber')||text.includes('daybreak');},
  };
  const initial={...scopes,...functions},shared={alias:scopes.ComposerScope};
  return{initial,shared,options:{document:{},manager:{},asset:role=>role,load:async role=>role==='initial'?initial:shared}};
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
