// Test-only current input/picker identity evidence. No text, documents, actual
// permission values, setters, backend requests, navigation or UI operations.
import { loadedAsset, uniqueExport, componentSource, currentElementAncestry, localConnection } from '../../../frontend/src/host-discovery.js';
import { nativeMainInput, nativeInputBinding, OWNED } from '../../../frontend/src/adapter/workspace-dom.js';

function pickerFiber(chain) {
  return chain?.find(fiber=>{
    const source=componentSource(fiber.type);
    return source.includes('conversationId')&&(source.includes('workPreferences.composer.useWorkSettings')||
      source.includes('selectedPermissionSelection')&&source.includes('updateThreadPermissions')||
      source.includes('permissionProfilesOverride')&&source.includes('setAgentMode')&&source.includes('setPermissionProfileId'));
  });
}
function committedPicker(trigger,input,root) {
  let committed=false,visited=0;
  const diagnostics={triggerAttachments:0,attachedHostMatches:0,nearbyCurrentChains:0,triggerBranchHosts:0,triggerBranchCurrentChains:0,
    inputChainDepth:0,maxRelativeDepth:0,truncatedDepth:0,nodeLimitReached:false,
    sourceRoles:{conversation:0,legacy:0,account:0,selection:0,permissionNavigation:0},attachedRoots:[]};
  const countRoles=chain=>{for(const fiber of chain??[]){
    const source=componentSource(fiber.type);
    if(source.includes('conversationId'))diagnostics.sourceRoles.conversation++;
    if(source.includes('setAgentMode')&&source.includes('setPermissionProfileId'))diagnostics.sourceRoles.legacy++;
    if(source.includes('workPreferences.composer.useWorkSettings'))diagnostics.sourceRoles.account++;
    if(source.includes('selectedPermissionSelection')&&source.includes('updateThreadPermissions'))diagnostics.sourceRoles.selection++;
    if(source.includes('data-composer-navigation-target'))diagnostics.sourceRoles.permissionNavigation++;
  }};
  // Counts distinguish stale DOM pointers, a foreign existing Native root and
  // an unknown component predicate. No root, fiber, source or identity escapes.
  for(const key of Object.keys(trigger).filter(key=>key.startsWith('__reactFiber$'))){
    diagnostics.triggerAttachments++;const attached=trigger[key];
    if(attached?.stateNode===trigger)diagnostics.attachedHostMatches++;
    for(const start of [attached,attached?.alternate]){
      const seen=new Set();let fiber=start;
      while(fiber&&!seen.has(fiber)){
        seen.add(fiber);
        if(fiber.tag===3){
          const container=fiber.stateNode?.containerInfo,current=fiber.stateNode?.current;
          diagnostics.attachedRoots.push({currentPresent:!!current,currentMatchesThisFiber:current===fiber,containerIsMainRoot:container===root,
            containerConnected:container?.isConnected===true,containerOwnsTrigger:!!container?.contains?.(trigger),containerOwned:!!container?.closest?.(OWNED)});
          break;
        }
        fiber=fiber.return;
      }
    }
  }
  const inspect=(element,container,proof)=>{
    const chain=currentElementAncestry(element,container);if(chain?.length){committed=true;diagnostics.nearbyCurrentChains++;countRoles(chain);}
    const fiber=pickerFiber(chain);return fiber?{fiber,proof,committed:true,visited,diagnostics}:null;
  };
  let found=inspect(trigger,root,'trigger');if(found)return found;
  // A cloned trigger may retain a detached DOM attachment. Prove a nearby
  // committed host instead; never treat an unverified return chain as current.
  for(let element=trigger.parentElement;element&&root.contains(element)&&element!==input?.input;element=element.parentElement){
    found=inspect(element,root,'ancestor');if(found)return found;
  }
  for(const element of trigger.querySelectorAll('span,svg,path')){
    found=inspect(element,root,'descendant');if(found)return found;
  }
  // Search only the already-proven current input's component branch, not other
  // conversations or the app tree. A matching host must also prove its own chain.
  const inputChain=input&&currentElementAncestry(input.input,root),owner=inputChain?.find(fiber=>fiber.stateNode===input.input);
  diagnostics.inputChainDepth=inputChain?.length??0;
  const queue=owner?.child?[{fiber:owner.child,path:inputChain,depth:1}]:[],seen=new Set();
  while(queue.length){
    const {fiber,path,depth}=queue.pop();if(!fiber||seen.has(fiber))continue;seen.add(fiber);visited++;
    diagnostics.maxRelativeDepth=Math.max(diagnostics.maxRelativeDepth,depth);
    if(fiber.stateNode===trigger){
      diagnostics.triggerBranchHosts++;
      // The input owner's current ancestry is already proven. Every edge here
      // came from that owner's actual child/sibling lists. Carry that path;
      // Native's retained return pointers are not needed to reconstruct it.
      const chain=[fiber,...path],picker=pickerFiber(chain);
      committed=true;diagnostics.triggerBranchCurrentChains++;countRoles(chain);
      if(picker)return{fiber:picker,proof:'input-branch',committed:true,visited,diagnostics};
    }
    if(fiber.sibling)queue.push({fiber:fiber.sibling,path,depth});
    if(fiber.child)queue.push({fiber:fiber.child,path:[fiber,...path],depth:depth+1});
  }
  diagnostics.nodeLimitReached=queue.length>0;
  // Some Native control regions have their own React container. Its current
  // root must be inside this Native input and outside consumer-owned surfaces.
  for(let element=trigger.parentElement;input?.input.contains(element);element=element.parentElement){
    if(!element.closest(OWNED)&&Object.keys(element).some(key=>key.startsWith('__reactContainer$'))){
      found=inspect(trigger,element,'native-container');if(found)return found;
    }
  }
  return{fiber:null,proof:'unconfirmed',committed,visited,diagnostics};
}

// This test helper returns only projected evidence, including when Native DOM
// attachments are stale. Unconfirmed identity comparisons are null, not false.
export function permissionPickerEvidence(trigger,input,binding,root) {
  const {fiber,proof,committed,visited,diagnostics}=committedPicker(trigger,input,root),source=componentSource(fiber?.type),props=fiber?.memoizedProps;
  const arrays=fiber?.updateQueue?.memoCache?.data;
  const cacheEvidence={arrayCount:Array.isArray(arrays)?arrays.length:0,slotCount:0,configRecords:0,agentRecords:0,threadRecords:0};
  const seen=new Set();
  for(const array of Array.isArray(arrays)?arrays:[])for(const value of Array.isArray(array)?array:[]){
    cacheEvidence.slotCount++;
    if(!value||typeof value!=='object'||seen.has(value))continue;seen.add(value);
    if('resolvedConfig'in value&&'requirements'in value&&typeof value.isConfigDataPending==='boolean')cacheEvidence.configRecords++;
    if('agentMode'in value&&'permissionProfileId'in value&&typeof value.isAutoReviewRequiredForSelectedModel==='boolean')cacheEvidence.agentRecords++;
    if('threadMode'in value&&'threadSandboxPolicy'in value&&'threadPermissionProfileId'in value)cacheEvidence.threadRecords++;
  }
  return{committed,proof,visited,diagnostics,cacheEvidence,implementationFound:!!fiber,
    implementation:!fiber?'unknown':source.includes('workPreferences.composer.useWorkSettings')?'account':source.includes('selectedPermissionSelection')?'selection':'legacy',
    conversationPresent:props?typeof props.conversationId==='string':null,
    conversationMatchesInput:props?props.conversationId===(input?.scope.value.conversationId??null):null,
    conversationMatchesStrictBinding:props&&binding?props.conversationId===binding.threadId:null,
    hostLocal:props?props.hostId==='local':null,insideCurrentInput:!!input?.input.contains(trigger),
    insideCurrentFooter:!!input&&!!trigger.closest('[data-thread-scroll-footer]')?.contains(input.input)};
}

export async function inspectNativePermissionOwnership(document) {
  const shared=await import(loadedAsset('shared'));
  const brand=name=>uniqueExport(shared,value=>value?.__scopeBrand===name&&typeof value.id==='symbol',name);
  const native={composerScope:brand('ComposerScope'),ThreadScope:brand('ThreadScope'),RouteScope:brand('RouteScope')};
  const input=nativeMainInput(document,native),binding=input&&nativeInputBinding(input,native),root=document.getElementById('root');
  const triggers=[...root.querySelectorAll('[data-composer-navigation-target="permissions"]')].filter(node=>!node.closest(OWNED+', [data-app-shell-active-page="false"]'));
  const pickers=triggers.map(trigger=>permissionPickerEvidence(trigger,input,binding,root));
  let loadedThread=null;
  if(binding){
    const current=localConnection().manager.getConversation(binding.threadId),settings=current?.latestThreadSettings;
    loadedThread={present:!!current,resumed:current?.resumeState==='resumed',
      cachedSettingsPresent:settings!=null,approvalPolicyPresent:settings?.approvalPolicy!=null,
      approvalsReviewerPresent:settings?.approvalsReviewer!=null,sandboxPolicyPresent:settings?.sandboxPolicy!=null,
      permissionsPresent:settings?.permissions!=null,activePermissionProfilePresent:settings?.activePermissionProfile!=null};
  }
  return Object.freeze({inputPresent:!!input,kind:input?.scope.value.kind??null,strictBinding:!!binding,triggerCount:triggers.length,pickers:Object.freeze(pickers),loadedThread});
}
