import { discoverNative } from '../../../frontend/src/adapter/discovery.js';
import { createWorkspaceDiscovery } from '../../../frontend/src/adapter/workspace-discovery.js';

export async function prepare(threadIds) {
  const discovery = createWorkspaceDiscovery(discoverNative), owned = new Set(threadIds);
  try {
    const native = await discovery.navigation();
    return { open(threadId) {
      if (!owned.has(threadId)) throw Error('Canonical comparison requested a non-owned fixture');
      return native.openLocalThread(threadId);
    }, dispose() { discovery.dispose(); } };
  } catch (error) { discovery.dispose(); throw error; }
}
