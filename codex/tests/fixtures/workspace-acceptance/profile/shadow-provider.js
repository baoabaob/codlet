import { createWorkspace } from '../../../../frontend/src/adapter/workspace.js';
import { createWorkspaceDiscovery } from '../../../../frontend/src/adapter/workspace-discovery.js';
import { deferredNavigation, locateHost } from '../../../../frontend/src/adapter/navigation.js';
const capability = { name: 'workspace.shadow.audit', api: 1, scope: 'target' };
let workspace, navigation, discovery;
export function activate(context) {
  navigation = deferredNavigation(context); discovery = createWorkspaceDiscovery(navigation.native);
  workspace = createWorkspace(context, { locate: locateHost, discovery, apiSymbol: 'codlet.workspace.shadow.audit', capability, transcriptIsolation: true });
}
export function deactivate() { workspace?.dispose(); navigation?.dispose(); discovery?.dispose(); }
