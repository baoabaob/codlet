import { createWorkspace } from '../../../../frontend/src/adapter/workspace.js';
import { createWorkspaceDiscovery } from '../../../../frontend/src/adapter/workspace-discovery.js';
import { deferredNavigation,locateHost } from '../../../../frontend/src/adapter/navigation.js';
const capability={name:'workspace.composer.audit',api:1,scope:'target'};
let workspace,base,discovery;
export function activate(context){base=deferredNavigation(context);discovery=createWorkspaceDiscovery(base.native);workspace=createWorkspace(context,{locate:locateHost,discovery,apiSymbol:'codlet.workspace.composer.audit',capability});}
export function deactivate(){workspace?.dispose();discovery?.dispose();base?.dispose();}
