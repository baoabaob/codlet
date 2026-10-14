import {componentSource,currentElementAncestry} from '../host-discovery.js';
import {OWNED,workspaceError} from './workspace-dom.js';

export function currentPermissionCache(document,input) {
  const root=document.getElementById('root');
  const triggers=[...input.input.querySelectorAll('[data-composer-navigation-target="permissions"]')].filter(node=>!node.closest(OWNED));
  if(triggers.length!==1)throw workspaceError('permissions_unsupported','A unique Native permission trigger is required');
  const trigger=triggers[0],base=currentElementAncestry(input.input,root),owner=base?.find(fiber=>fiber.stateNode===input.input);
  if(!owner)throw workspaceError('permissions_loading','Native input ownership is not committed');
  const queue=owner.child?[{fiber:owner.child,path:base,depth:1}]:[],seen=new Set();let chain;
  while(queue.length&&seen.size<2048){
    const {fiber,path,depth}=queue.pop();if(!fiber||seen.has(fiber))continue;seen.add(fiber);
    if(fiber.stateNode===trigger){chain=[fiber,...path];break;}
    if(fiber.sibling)queue.push({fiber:fiber.sibling,path,depth});
    if(fiber.child&&depth<128)queue.push({fiber:fiber.child,path:[fiber,...path],depth:depth+1});
  }
  const pickers=chain?.filter(fiber=>{
    const source=componentSource(fiber.type);
    return source.includes('permissionProfilesOverride')&&source.includes('setAgentMode')&&source.includes('setPermissionProfileId');
  });
  if(pickers?.length!==1)throw workspaceError('permissions_unsupported','Native permission implementation is not supported');
  const picker=pickers[0],props=picker.memoizedProps;
  if(props.conversationId!==input.scope.value.conversationId||props.hostId!=='local')throw workspaceError('permissions_not_selected','Native permission control targets a different conversation');
  const arrays=picker.updateQueue?.memoCache?.data,values=[],unique=new Set();
  if(!Array.isArray(arrays)||arrays.length>32)throw workspaceError('permissions_unsupported','Native permission cache shape is unsupported');
  for(const array of arrays){
    if(!Array.isArray(array)||array.length>512)throw workspaceError('permissions_unsupported','Native permission cache exceeds the discovery boundary');
    for(const value of array)if(value&&typeof value==='object'&&!unique.has(value)){unique.add(value);values.push(value);}
  }
  return {picker,trigger,props,values,configs:values.filter(value=>'resolvedConfig'in value&&'requirements'in value&&typeof value.isConfigDataPending==='boolean'),
    agents:values.filter(value=>'agentMode'in value&&'permissionProfileId'in value&&typeof value.isAutoReviewRequiredForSelectedModel==='boolean'),
    threads:values.filter(value=>'threadMode'in value&&'threadSandboxPolicy'in value&&'threadPermissionProfileId'in value),
    models:values.filter(value=>typeof value.model==='string'&&typeof value.isLoading==='boolean'),
    cwds:values.filter(value=>value.hostId==='local'&&Object.keys(value).length===2&&'cwd'in value),
    intl:values.find(value=>typeof value.formatMessage==='function'&&typeof value.locale==='string')};
}

// Read only already-bound Native state; never initialize a query to discover it.
export function currentWindowsRequirement(input) {
  const seen=new Set(),matches=new Set();let count=0;
  for(const node of input.scope.chain.values()){
    if(seen.has(node)||!(node.familyBindings instanceof Map))continue;seen.add(node);
    if(seen.size>256)throw workspaceError('permissions_unsupported','Native permission scopes exceed the discovery boundary');
    for(const [family,bindings] of node.familyBindings){
      if(family?.scope!==node.token||typeof family.read!=='function'||!(bindings instanceof Map)||!bindings.has('local'))continue;
      if(++count>512)throw workspaceError('permissions_unsupported','Native permission bindings exceed the discovery boundary');
      const value=family.read(node,input.scope.chain,'local');
      if(value&&Object.keys(value).length===4&&['hasError','isPending','isRequired'].every(key=>typeof value[key]==='boolean')&&
          ['setup','update',null].includes(value.requirement))matches.add(value);
    }
  }
  if(matches.size!==1)throw workspaceError('permissions_unsupported','A unique existing Native Windows requirement is required');
  const value=[...matches][0];
  if(value.isPending||value.hasError)throw workspaceError('permissions_loading','Native Windows permission requirement is pending');
  return value;
}
