const fail = (code, message) => Object.assign(new Error(message), { code });
const text = (value, max) => typeof value === 'string' ? value.slice(0, max) : null;

export function loadedThreadSummary(thread, working = null) {
  if (!thread) return null;
  if (typeof thread.id !== 'string' || !thread.id || thread.id.length > 256 || thread.hostId != null && thread.hostId !== 'local')
    throw fail('desktop_summary_drift', 'The cached local thread identity changed');
  const status = thread.threadRuntimeStatus;
  const pending = Array.isArray(thread.requests) && thread.requests.some(request => request.completed !== true && request.completedAtMs == null) ||
    Array.isArray(thread.externalRequests) && thread.externalRequests.some(request => request.completedAtMs == null);
  const flags = Array.isArray(status?.activeFlags) ? status.activeFlags : [];
  const attention = pending || flags.includes('waitingOnApproval') || flags.includes('waitingOnUserInput');
  // Native's runtime status is authoritative. The live tail is a constant-time
  // fallback on older profiles; never walk canonical history on a token delta.
  const running = status?.type != null ? status.type === 'active' : thread.turns?.at(-1)?.status === 'inProgress';
  return Object.freeze({ id: thread.id, title: text(thread.title ?? thread.displayTitle, 8192), cwd: text(thread.cwd, 8192), hostId: 'local',
    runtimeStatus: attention ? 'attention' : running ? 'running' : thread.resumeState === 'resumed' ? 'idle' : 'loading',
    working: typeof working === 'boolean' ? working : null });
}

export function createLoadedThreads(manager, emit, instance, working = {read:()=>null}) {
  const summaries = new Map(), pages = new Map();
  let initialized = false, pageSequence = 0;
  const supported = typeof manager.getCachedConversations === 'function';
  const same = (a, b) => a === b || a && b && a.id === b.id && a.title === b.title && a.cwd === b.cwd && a.runtimeStatus === b.runtimeStatus && a.working === b.working;
  const project = thread => {const summary=loadedThreadSummary(thread);return summary?loadedThreadSummary(thread,working.read(summary.id,thread)):null;};
  function refresh(threadId, notify = true) {
    if (!supported || typeof threadId !== 'string') return;
    const next = project(manager.getConversation(threadId)), previous = summaries.get(threadId) ?? null;
    if (same(previous, next)) return;
    if (next) summaries.set(threadId, next); else {summaries.delete(threadId);working.remove?.(threadId);}
    if (notify) emit({ type: 'thread.summary.changed', threadId, thread: next });
  }
  function initialize() {
    if (initialized) return;
    if (!supported) throw fail('desktop_summary_unavailable', 'This Desktop manager has no reviewed cached-thread enumeration');
    const threads = manager.getCachedConversations();
    if (!Array.isArray(threads)) throw fail('desktop_summary_drift', 'The cached-thread collection must be an array');
    for (const thread of threads) { const summary = project(thread); if (summary) summaries.set(summary.id, summary); }
    initialized = true;
  }
  function read(args = {}) {
    if (!args || typeof args !== 'object' || Array.isArray(args) || Object.keys(args).some(key => !['limit', 'cursor', 'threadId'].includes(key)))
      throw fail('invalid_argument', 'Invalid loaded-thread query');
    const limit = args.limit ?? 20;
    if (!Number.isSafeInteger(limit) || limit < 1 || limit > 100) throw fail('invalid_argument', 'limit must be 1..100');
    if (args.threadId != null) {
      if (typeof args.threadId !== 'string' || !args.threadId || args.threadId.length > 256 || args.cursor != null) throw fail('invalid_argument', 'Invalid loaded-thread identity');
      if (!supported) throw fail('desktop_summary_unavailable', 'Cached-thread summaries are unavailable');
      refresh(args.threadId, false);
      return { threads: summaries.has(args.threadId) ? [summaries.get(args.threadId)] : [], cursor: null };
    }
    initialize();
    const now = Date.now();
    for (const [key, page] of pages) if (page.expires < now) pages.delete(key);
    let page;
    if (args.cursor != null) {
      page = pages.get(args.cursor);
      if (!page) throw fail('invalid_argument', 'Loaded-thread cursor is expired or unknown');
      pages.delete(args.cursor);
    } else { for(const id of summaries.keys())refresh(id,false);page = { entries: [...summaries.values()], offset: 0, expires: now + 15000 }; }
    const threads = page.entries.slice(page.offset, page.offset + limit); page.offset += threads.length;
    let cursor = null;
    if (page.offset < page.entries.length) {
      if (pages.size >= 32) throw fail('resource_limit', 'Too many loaded-thread snapshots');
      cursor = `${instance}:loaded:${++pageSequence}`; pages.set(cursor, page);
    }
    return { threads, cursor };
  }
  return { read, refresh, dispose() { summaries.clear(); pages.clear(); working.dispose?.(); } };
}
