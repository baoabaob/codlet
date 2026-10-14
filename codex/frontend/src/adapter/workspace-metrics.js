// Private, opt-in test points. Normal activation passes no options and creates
// no clock reads, samples, observers, timers or report/storage work.
export function createWorkspaceMetrics(options) {
  if (options == null || options.enabled !== true) return null;
  const { runId, capacity = 1024, now = () => performance.now() } = options;
  if (typeof runId !== 'string' || !/^[\w.-]{1,96}$/.test(runId) ||
      !Number.isSafeInteger(capacity) || capacity < 1 || capacity > 4096 || typeof now !== 'function')
    throw new TypeError('Invalid workspace test points');
  const samples = new Array(capacity), counts = new Map();
  let written = 0, operation = 0, view = 0;
  const alias = value => Number.isSafeInteger(value) && value >= 0 ? value : null;
  function add(phase, detail = {}) {
    if (!/^[a-z][a-z0-9.]{1,64}$/.test(phase)) throw new TypeError('Invalid workspace measurement phase');
    // Fixed fields only: never copy identities, paths, drafts or caller objects.
    const sample = Object.freeze({ runId, layer: 'adapter', phase, timestamp: now(),
      operationId: alias(detail.operationId), viewId: alias(detail.viewId),
      threadAlias: alias(detail.threadAlias), duration: Number.isFinite(detail.duration) ? detail.duration : null });
    samples[written++ % capacity] = sample;
    const key = counts.has(phase) || counts.size < 128 ? phase : 'other';
    counts.set(key, (counts.get(key) ?? 0) + 1);
  }
  return Object.freeze({
    add,
    nextOperation: () => ++operation,
    nextView: () => ++view,
    start: () => now(),
    end(phase, start, detail) { add(phase, { ...detail, duration: now() - start }); },
    report() {
      const count = Math.min(written, capacity), first = Math.max(0, written - capacity);
      return Object.freeze({ runId, layer: 'adapter', capacity, written,
        counts: Object.freeze(Object.fromEntries(counts)),
        samples: Object.freeze(Array.from({ length: count }, (_, i) => samples[(first + i) % capacity])) });
    },
  });
}
