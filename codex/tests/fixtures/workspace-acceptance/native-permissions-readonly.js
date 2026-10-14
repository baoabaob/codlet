// Finite preflight of the production permission reader on the current committed
// input. No update, setter, send, navigation, draft read or new connection.
import {loadedAsset,uniqueExport,componentSource,localConnection} from '../../../frontend/src/host-discovery.js';
import {nativeMainInput,nativeInputBinding} from '../../../frontend/src/adapter/workspace-dom.js';
import {loadNativePermissions} from '../../../frontend/src/desktop/native-permissions.js';
import {currentPermissionCache} from '../../../frontend/src/adapter/native-permission-cache.js';
export async function capturePermissionReadOnly(){
  try{
    const shared=await import(loadedAsset('shared'));
    const brand=name=>uniqueExport(shared,value=>value?.__scopeBrand===name&&typeof value.id==='symbol',name);
    const native={composerScope:brand('ComposerScope'),ThreadScope:brand('ThreadScope'),RouteScope:brand('RouteScope')};
    const input=nativeMainInput(document,native),binding=input&&nativeInputBinding(input,native);
    if(!binding)return{phase:'unsupported',diagnostic:{code:'permissions_not_selected',message:'No confirmed Native local conversation'}};
    const {manager}=localConnection(),reader=await loadNativePermissions({document,manager});
    const cache=currentPermissionCache(document,input),cwdValues=[...new Set(cache.cwds.map(value=>value.cwd))];
    const initial=await import(loadedAsset('initial')),cyberModel=uniqueExport(initial,value=>typeof value==='function'&&value.length===1&&componentSource(value).length<180&&['toLowerCase','cyber','daybreak'].every(marker=>componentSource(value).includes(marker)),'Native model confirmation classification');
    const fullItems=cache.values.filter(value=>typeof value.props?.disabled==='boolean'&&value.props.children?.props?.id==='composer.permissionsDropdown.fullAccess.optionLabel');
    return {threadId:binding.threadId,hostId:'local',...(await reader.read(binding.threadId)),evidence:{cwdRecords:cache.cwds.length,cwdDistinct:cwdValues.length,
      cwdMatchesConversation:cwdValues.every(value=>value===manager.getConversation(binding.threadId)?.cwd),cwdShapesValid:cwdValues.every(value=>value===null||typeof value==='string'),
      modelRecords:cache.models.length,modelDistinct:new Set(cache.models.map(value=>value.model)).size,modelPending:cache.models.some(value=>value.isLoading),
      modelConfirmationClasses:new Set(cache.models.map(value=>cyberModel(value.model))).size,modelConfirmationAllCyber:cache.models.length>0&&cache.models.every(value=>cyberModel(value.model)),
      nativeFullAccessItems:fullItems.length,nativeFullAccessEnabled:fullItems.length===1?!fullItems[0].props.disabled:null,configRecords:cache.configs.length}};
  }catch(error){return{phase:'unsupported',diagnostic:{code:error?.code??'permissions_unsupported',message:String(error?.message??error).slice(0,1024)}};}
}
