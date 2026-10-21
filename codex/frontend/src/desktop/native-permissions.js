import {loadedAsset,uniqueModuleExport,componentSource} from '../host-discovery.js';
import {NATIVE_PERMISSION_FUNCTIONS,matchesNativePermissionSource} from './permission-contracts.js';
import {nativeMainInput,nativeInputBinding,workspaceError} from '../adapter/workspace-dom.js';
import {currentPermissionCache,currentWindowsRequirement} from '../adapter/native-permission-cache.js';
import {OWNED} from '../adapter/workspace-dom.js';

const equal=(a,b)=>JSON.stringify(a)===JSON.stringify(b);
const modes=['read-only','auto','granular','guardian-approvals','full-access','custom'];
const labels={'read-only':['composer.permissionsDropdown.readOnly','Read only'],auto:['composer.permissionsDropdown.default.approvalOptionLabel','Ask for approval'],granular:['composer.permissionsDropdown.granular','Granular permissions'],
  'guardian-approvals':['composer.permissionsDropdown.guardianApproval.optionLabel','Approve for me'],'full-access':['composer.permissionsDropdown.fullAccess.optionLabel','Full access'],custom:['composer.permissionsDropdown.custom.optionLabel','Custom (config.toml)']};

export async function loadNativePermissions({document,manager,load=url=>import(url),asset=loadedAsset}) {
  const urls=[asset('shared'),asset('initial')],modules=new Map(await Promise.all(urls.map(async url=>[url,await load(url)])));
  const brand=name=>uniqueModuleExport(modules,value=>value?.__scopeBrand===name&&typeof value.id==='symbol',name);
  const native={composerScope:brand('ComposerScope'),ThreadScope:brand('ThreadScope'),RouteScope:brand('RouteScope')};
  const functions=Object.fromEntries(Object.entries(NATIVE_PERMISSION_FUNCTIONS).map(([name,contract])=>[name,
    uniqueModuleExport(modules,value=>typeof value==='function'&&matchesNativePermissionSource(componentSource(value),value.length,contract),'Native '+contract.label)]));
  return createNativePermissionReader({document,manager,native,...functions});
}

export function createNativePermissionReader({document,manager,native,reduce,convert,toSettings,modeFromPolicy,profileMode,defaultMode,windowsMode,cyberModel}) {
  const listeners=new Set();let observer,watched;
  const track=(id,trigger)=>{
    if(!listeners.size||!document.defaultView.MutationObserver)return;
    const parent=trigger.parentElement;if(!parent)return;
    const previous=watched;watched={id,trigger,parent};if(previous?.parent===parent)return;
    observer?.disconnect();observer=new document.defaultView.MutationObserver(records=>{
      if(!watched||!records.some(record=>{
        const target=record.target.nodeType===1?record.target:record.target.parentElement;
        if(target?.closest(OWNED))return false;
        if(watched.trigger.contains(target))return true;
        return [...record.addedNodes,...record.removedNodes].some(node=>node===watched.trigger||node.contains?.(watched.trigger)||node.nodeType===1&&!node.matches(OWNED)&&node.querySelector?.('[data-composer-navigation-target="permissions"]'));
      }))return;
      for(const listener of listeners)listener(watched.id);
    });
    observer.observe(parent,{subtree:true,childList:true,attributes:true,attributeFilter:['disabled','aria-disabled']});
  };
  const inputs=id=>{
    const input=nativeMainInput(document,native),binding=input&&nativeInputBinding(input,native);
    if(!binding||binding.threadId!==id)throw workspaceError('permissions_not_selected','Native permission input is not confirmed for this conversation');
    const cache=currentPermissionCache(document,input);
    track(id,cache.trigger);
    if(!cache.configs.length||cache.agents.length!==1||cache.threads.length!==1)throw workspaceError('permissions_unsupported','Native permission cache is incomplete or ambiguous');
    const agent=cache.agents[0],thread=cache.threads[0],conversation=manager.getConversation(id),settings=conversation?.latestThreadSettings;
    if(!settings)throw workspaceError('permissions_loading','Native thread permissions are not loaded');
    const cwdValues=[...new Set(cache.cwds.map(value=>value.cwd))];
    if(cwdValues.length!==1||cwdValues[0]!==null&&typeof cwdValues[0]!=='string')throw workspaceError('permissions_unsupported','Native permission workspace is ambiguous');
    // Matches _Wi's actual converter inputs: committed thread writable roots,
    // otherwise its Native cwd query argument. No manager.cwd guess is used.
    const cwd=cwdValues[0],roots=thread.threadSandboxPolicy?.type==='workspaceWrite'?thread.threadSandboxPolicy.writableRoots:cwd===null?[]:[cwd];
    if(!Array.isArray(roots)||roots.some(root=>typeof root!=='string'))throw workspaceError('permissions_unsupported','Native runtime workspace roots are unavailable');
    const menu=menuChoices(cache),windows=currentWindowsRequirement(input);
    const projection=config=>({options:reduce({...config,defaultWorkspaceWriteMode:defaultMode(config),isAutoReviewRequiredForSelectedModel:agent.isAutoReviewRequiredForSelectedModel,
      hasAuthoritativeGuardianApprovalDefault:thread.threadMode==='guardian-approvals'||cache.props.disableDefaultPermissions&&cache.props.disableCustomPermissions,
      showFullAccessInComposer:menu.options.has(labels['full-access'][0])}),settings:modes.map(mode=>convert(mode,roots,config.resolvedConfig))});
    const projected=cache.configs.map(projection);
    if(projected.some(value=>!equal(value,projected[0])))throw workspaceError('permissions_loading','Native permission inputs are changing');
    if(cache.configs.some(config=>config.isConfigDataPending))throw workspaceError('permissions_loading','Native permission requirements are pending');
    return{...cache,config:cache.configs[0],agent,thread,conversation,settings,roots,menu,windows,reduced:projected[0].options};
  };
  function menuChoices(cache){
    const options=new Map(),profiles=new Map(),queue=[...cache.values],seen=new Set();let count=0;
    const insert=(map,key,value)=>{const previous=map.get(key);if(previous&&!equal(previous,value))throw workspaceError('permissions_loading','Native permission menu records disagree');map.set(key,value);};
    const textId=node=>{
      const pending=[node],visited=new Set();
      while(pending.length&&visited.size<64){const value=pending.pop();if(!value||typeof value!=='object'||visited.has(value))continue;visited.add(value);
        if(typeof value.props?.id==='string')return value.props.id;
        const children=value.props?.children;if(Array.isArray(children))pending.push(...children);else if(children&&typeof children==='object')pending.push(children);
      }
      return null;
    };
    while(queue.length&&count++<2048){const value=queue.pop();if(!value||typeof value!=='object'||seen.has(value))continue;seen.add(value);
      if(Array.isArray(value)){queue.push(...value);continue;}
      const props=value.props;if(!props)continue;
      if(typeof props.disabled==='boolean'&&(typeof props.onClick==='function'||typeof props.onSelect==='function')){
        const id=textId(props.children);
        if(id)insert(options,id,{enabled:!props.disabled});
        else if(typeof props.children==='string'&&value.key===props.children&&props.children.length>0&&props.children.length<=256)
          insert(profiles,props.children,{selection:{kind:'profile',profileId:props.children},label:props.children,enabled:!props.disabled,reason:props.disabled?'Unavailable under the current Native requirements':null,requiresConfirmation:false,confirmation:null});
      }
      if(Array.isArray(props.children))queue.push(...props.children);else if(props.children&&typeof props.children==='object')queue.push(props.children);
    }
    return{options,profiles};
  }
  function describe(id,{canonical=false}={}){
    const cache=inputs(id),menu=cache.menu,visible=menu.options,allowed=cache.reduced.availableAgentModes;
    const profile=cache.settings.activePermissionProfile?.id??cache.settings.permissions;
    const builtinMode=profileMode(cache.settings.permissions,'auto');
    const canonicalMode=modeFromPolicy({...cache.settings,sandboxPolicy:builtinMode?convert(builtinMode,[],null).sandboxPolicy:cache.settings.sandboxPolicy});
    const canonicalSelection=typeof profile==='string'&&!profile.startsWith(':')?
      {kind:'profile',profileId:profile}:canonicalMode?{kind:'agent-mode',mode:canonicalMode}:null;
    // Unmodified conversations report the existing Native submission baseline.
    // Only an explicit authenticated update enables the canonical send guard.
    let selection,source;
    if(canonical){selection=canonicalSelection;source=selection?'thread':'unknown';}
    else if(cache.agent.shouldSendPermissionOverrides===false){selection={kind:'server-default'};source='unknown';}
    else if(cache.agent.shouldSendPermissionOverrides===true){
      const effectiveProfile=cache.agent.permissionProfileId;
      selection=typeof effectiveProfile==='string'?{kind:'profile',profileId:effectiveProfile}:modes.includes(cache.agent.agentMode)?{kind:'agent-mode',mode:cache.agent.agentMode}:null;
      if(!selection)throw workspaceError('permissions_unsupported','Native submission permission baseline is unavailable');
      source='unknown';
    }else throw workspaceError('permissions_unsupported','Native permission submission override state is unavailable');
    const options=[],defaultProfile=cache.config.requirements?.defaultPermissions??cache.config.resolvedConfig?.default_permissions;
    const builtinDefault=profileMode(defaultProfile,defaultMode(cache.config));
    const defaultChoice=builtinDefault&&builtinDefault!=='full-access'?builtinDefault:windowsMode({defaultWorkspaceWriteMode:defaultMode(cache.config),isWindowsSandboxRequired:cache.windows.isRequired});
    const selectedModes=[];
    if(visible.has(labels.auto[0])&&(typeof defaultProfile!=='string'||defaultProfile.startsWith(':')))selectedModes.push(defaultChoice);
    for(const mode of ['guardian-approvals','full-access','custom'])if(visible.has(labels[mode][0]))selectedModes.push(mode);
    for(const mode of selectedModes){
      if(!modes.includes(mode))throw workspaceError('permissions_unsupported','Native returned an unknown permission mode');
      const [messageId,fallback]=['read-only','auto','granular'].includes(mode)?labels.auto:labels[mode],item=visible.get(messageId);
      // A hidden high-access/custom choice cannot be reintroduced by a custom
      // consumer. Native still determines policy; the actual menu gates access.
      if(['full-access','custom','guardian-approvals'].includes(mode)&&!item)continue;
      let enabled=allowed.includes(mode)&&item.enabled&&(!cache.agent.isAutoReviewRequiredForSelectedModel||mode==='guardian-approvals')&&
        !(cache.props.disableDefaultPermissions&&['read-only','auto','granular'].includes(mode));
      const label=cache.intl?.formatMessage?.({id:messageId,defaultMessage:fallback})??fallback;
      const modelClasses=[...new Set(cache.models.map(value=>value.isLoading?'pending':cyberModel(value.model)))];
      const confirmationProved=modelClasses.length===1&&typeof modelClasses[0]==='boolean';
      if(mode==='full-access'&&!confirmationProved)enabled=false;
      const message=(id,fallback,values)=>{const result=cache.intl?.formatMessage?.({id,defaultMessage:fallback},values)??fallback;return Array.isArray(result)?result.join(''):result;};
      const isCyberModel=confirmationProved&&modelClasses[0];
      const confirmation=mode==='full-access'?{kind:'native-full-access',
        title:message(isCyberModel?'composer.mode.agentMode.fullAccessConfirm.cyberModelWarningTitle':'composer.mode.agentMode.fullAccessConfirm.warningTitle',isCyberModel?'Enable Full Access for Cyber model?':'Turn on Full Access?'),
        body:message('composer.mode.agentMode.fullAccessConfirm.warningDescription.codeMode','Codex will be able to run commands, use the internet, and create and edit files anywhere on this computer without your permission. This includes but is not limited to:'),
        capabilities:[message('composer.mode.agentMode.fullAccessConfirm.files.description','Read, create, modify, upload, or delete files anywhere on this computer'),message('composer.mode.agentMode.fullAccessConfirm.terminal.description','Run commands, install software, and change system settings'),message('composer.mode.agentMode.fullAccessConfirm.internet.description','Access websites, send data, and use enabled plugins')],
        risk:cache.intl?message('composer.mode.agentMode.fullAccessConfirm.riskDescriptionByModel','This comes with risks like loss or exposure of sensitive data and prompt injection. {isCyberModel, select, true {We strongly recommend selecting "Approve for me" instead, and customizing the reviewer policy for your use case.} other {You can turn this off.}} <link>Learn more</link>',{isCyberModel,link:chunks=>chunks}):'This comes with risks like loss or exposure of sensitive data and prompt injection. '+(isCyberModel?'We strongly recommend selecting "Approve for me" instead, and customizing the reviewer policy for your use case.':'You can turn this off.'),
        modelWarning:isCyberModel?message('composer.mode.agentMode.fullAccessConfirm.cyberModelRiskDescription','Cyber models carry a higher risk of dangerous actions. Ensure proper safeguards are in place before granting full access.'):null,
        confirmLabel:message('composer.mode.agentMode.fullAccessConfirm.turnOnButton','Confirm'),cancelLabel:message('composer.mode.agentMode.fullAccessConfirm.goBack','Cancel')}:null;
      options.push({selection:{kind:'agent-mode',mode},label,enabled,reason:enabled?null:'Unavailable under the current Native requirements',requiresConfirmation:confirmation!==null,confirmation});
    }
    options.push(...menu.profiles.values());
    return{cache,snapshot:{phase:'ready',selection,source,options,diagnostic:null}};
  }
  return{sendPathVerified:true,
    subscribe(listener){listeners.add(listener);return()=>{listeners.delete(listener);if(!listeners.size){observer?.disconnect();observer=null;watched=null;}};},
    dispose(){listeners.clear();observer?.disconnect();observer=null;watched=null;},
    canonical(id){const settings=manager.getConversation(id)?.latestThreadSettings;if(!settings)throw workspaceError('permissions_unconfirmed','Native canonical settings are unavailable');return{approvalPolicy:settings.approvalPolicy,approvalsReviewer:settings.approvalsReviewer,...toSettings(settings),...(settings.runtimeWorkspaceRoots===undefined?{}:{runtimeWorkspaceRoots:settings.runtimeWorkspaceRoots})};},
    read(id,options){try{return describe(id,options).snapshot;}catch(error){if(['permissions_loading','permissions_unsupported'].includes(error.code))return{phase:error.code==='permissions_loading'?'loading':'unsupported',selection:null,source:'unknown',options:[],diagnostic:{code:error.code,message:error.message}};throw error;}},
    convert(id,selection){
      const {cache,snapshot}=describe(id);
      if(!snapshot.options.some(option=>option.enabled&&equal(option.selection,selection)))throw workspaceError('permissions_unavailable','Native does not allow this permission selection');
      if(selection.kind==='profile')return{permissions:selection.profileId};
      const policy=convert(selection.mode,cache.roots,cache.config.resolvedConfig);
      if(!policy)throw workspaceError('permissions_unsupported','Native permission conversion is unavailable');
      return{approvalPolicy:policy.approvalPolicy,approvalsReviewer:policy.approvalsReviewer,...toSettings(policy)};
    }};
}
