// The reviewed Desktop manager owns unsubscribe, stream ownership and history
// hydration. Configuration hooks still select the provider on its real resume.
const fail = code => Object.assign(new Error(code), { code });
export function validateReconfiguration(args) {
  if (!args || Object.keys(args).some(k => !['threadId', 'modelProvider', 'model'].includes(k))
    || typeof args.threadId !== 'string' || !/^[A-Za-z0-9_-]{1,256}$/u.test(args.threadId)
    || typeof args.modelProvider !== 'string' || !/^[A-Za-z0-9_-]{1,128}$/u.test(args.modelProvider)
    || typeof args.model !== 'string' || !args.model.trim() || args.model.length > 256) throw fail('invalid_argument');
}
function waitFor(operation, signal) {
  if (!signal) return operation;
  let abort;
  return new Promise((resolve, reject) => {
    abort = () => reject(fail('outcome_unknown'));
    signal.addEventListener('abort', abort, { once: true });
    if (signal.aborted) abort();
    Promise.resolve(operation).then(resolve, reject);
  }).finally(() => signal.removeEventListener('abort', abort));
}
export function createThreadReconfiguration({ manager, client, check, supported, selection, loadedThread, activeTurnState }) {
  const pending = new Set();
  const available = () => supported === true && typeof manager.unsubscribeInactiveConversation === 'function'
    && typeof manager.resumeConversation === 'function' && typeof client.addRequestLifecycleListener === 'function';
  async function apply(args, signal, { beforeRelease = () => {} } = {}) {
    check();
    if (!available()) throw fail('desktop_configuration_unsupported');
    args = { ...args };
    validateReconfiguration(args);
    const id = args.threadId, before = loadedThread(id), state = activeTurnState(before);
    if (selection().threadId !== id) throw fail('desktop_thread_not_selected');
    if (pending.has(id) || !state.activeTurnKnown || state.activeTurnId || before.requests?.length
      || before.threadRuntimeStatus?.type === 'active' || manager.hasInFlightConversationResume?.(id)
      || [...client.requestPromises.values()].some(r => r.conversationId === id && ['turn/start', 'turn/steer', 'thread/resume'].includes(r.method))) throw fail('desktop_thread_busy');
    if (signal?.aborted) throw fail('invocation_cancelled');
    const roots = manager.getThreadWorkspaceState?.(id)?.applied?.runtimeWorkspaceRoots ?? [before.cwd];
    if (!Array.isArray(roots) || !roots.length || roots.some(r => typeof r !== 'string' || !r)) throw fail('desktop_configuration_drift');
    pending.add(id);
    let receipt;
    const release = client.addRequestLifecycleListener(event => {
      if (event.type === 'completed' && event.method === 'thread/resume' && event.result?.thread?.id === id)
        receipt = { modelProvider: event.result.modelProvider, model: event.result.model };
    });
    try {
      beforeRelease();
      await waitFor(manager.unsubscribeInactiveConversation(id), signal);
      check();
      if (signal?.aborted) throw fail('outcome_unknown');
      // The manager swallows unsubscribe failures: verify it released ownership.
      if (!receipt && manager.getConversation(id)?.resumeState === 'resumed' && manager.getStreamRole(id)?.role === 'owner') throw fail('configuration_release_failed');
      const result = receipt ? { status: 'ready' } : await waitFor(manager.resumeConversation({ conversationId: id, workspaceRoots: [...roots] }), signal);
      check();
      if (signal?.aborted) throw fail('outcome_unknown');
      if (result?.status !== 'ready' || !receipt) throw fail('configuration_resume_unconfirmed');
      if (receipt.modelProvider !== args.modelProvider || receipt.model !== args.model) throw fail('configuration_not_applied');
      return { threadId: id, status: 'applied', ...receipt };
    } finally { release(); pending.delete(id); }
  }
  return { apply, available, busy: id => pending.has(id) };
}
