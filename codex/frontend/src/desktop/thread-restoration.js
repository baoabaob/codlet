// A lease remembers only non-secret provider/model IDs, never native config or
// credentials. Only its registration can restore it; later user choices win.
import { validateReconfiguration } from './thread-reconfiguration.js';
const fail = code => Object.assign(new Error(code), { code });
const same = (a, b) => a.modelProvider === b.modelProvider && a.model === b.model;
const cancelled = signal => { if (signal?.aborted) throw fail('invocation_cancelled'); };

export function createThreadRestoration({ reconfiguration, readConfiguration, check, cleanupAvailable = true }) {
  const leases = new Map(), overrides = new Map(), operations = new Map(), inflight = new Map();
  let alive = true;
  const ready = signal => { check(); cancelled(signal); if (!alive) throw fail('adapter_deactivated'); };
  const inspect = owner => [...leases.values()].filter(lease => lease.owner === owner).map(lease => ({
    threadId: lease.threadId, status: lease.status, original: { ...lease.original }, expected: { ...lease.expected }
  }));
  async function snapshot(id, signal) {
    ready(signal);
    const value = await readConfiguration(id, signal);
    ready(signal);
    const result = { modelProvider: value.modelProvider, model: value.model };
    try { validateReconfiguration({ threadId: id, ...result }); }
    catch { throw fail('configuration_restore_unavailable'); }
    return result;
  }
  async function apply(owner, args, signal) {
    ready(signal); args = { ...args }; validateReconfiguration(args);
    const id = args.threadId;
    if (operations.has(id)) throw fail('desktop_thread_busy');
    const previous = leases.get(id);
    if (previous && previous.owner !== owner) throw fail('configuration_owned');
    const reserved = [...operations.keys()].filter(key => !leases.has(key)).length;
    if (!previous && leases.size + reserved >= 16) throw fail('configuration_restore_limit');
    operations.set(id, owner);
    let lease, attempted = false;
    try {
      const current = await snapshot(id, signal);
      if (previous && !same(current, previous.expected)) throw fail('configuration_restore_conflict');
      lease = { owner, threadId: id, original: previous?.original ?? current,
        expected: { modelProvider: args.modelProvider, model: args.model }, status: 'pending' };
      leases.set(id, lease);
      const result = await reconfiguration.apply(args, signal, { beforeRelease() { ready(signal); attempted = true; } });
      ready(signal); lease.status = 'applied'; return result;
    } catch (error) {
      if (lease) {
        if (attempted) lease.status = 'unconfirmed';
        else if (previous) leases.set(id, previous);
        else leases.delete(id);
      }
      throw error;
    } finally { operations.delete(id); }
  }
  async function restore(owner, signal) {
    ready(signal);
    const pending = [...(inflight.get(owner) ?? [])];
    if (pending.length) {
      let abort;
      try {
        await new Promise((resolve, reject) => {
          abort = () => reject(fail('configuration_restore_cancelled'));
          signal?.addEventListener('abort', abort, { once: true });
          if (signal?.aborted) abort();
          Promise.allSettled(pending).then(resolve);
        });
      } finally { signal?.removeEventListener('abort', abort); }
      ready(signal);
    }
    if ([...operations.values()].some(value => value === owner)) throw fail('configuration_restore_busy');
    const results = [];
    for (const lease of [...leases.values()].filter(value => value.owner === owner)) {
      const id = lease.threadId;
      if (operations.has(id)) throw fail('desktop_thread_busy');
      operations.set(id, owner);
      try {
        const current = await snapshot(id, signal);
        if (same(current, lease.original)) {
          leases.delete(id); results.push({ threadId: id, status: 'restored' }); continue;
        }
        if (current.modelProvider !== lease.expected.modelProvider) {
          // A user/other owner selected another provider. Do not overwrite it.
          leases.delete(id); results.push({ threadId: id, status: 'superseded' }); continue;
        }
        if (!same(current, lease.expected)) throw fail('configuration_restore_conflict');
        overrides.set(id, { lease, used: false, signal });
        const result = await reconfiguration.apply({ threadId: id, ...lease.original }, signal);
        ready(signal);
        leases.delete(id); results.push({ ...result, status: 'restored' });
      } catch (error) {
        lease.status = 'restoreRequired'; throw error;
      } finally { overrides.delete(id); operations.delete(id); }
    }
    return { threads: results };
  }
  function intercept(message, send) {
    if (message.request.method !== 'thread/resume') return false;
    const override = overrides.get(message.request.params?.threadId);
    if (!override) return false;
    ready(override.signal);
    if (override.used || leases.get(override.lease.threadId) !== override.lease) throw fail('configuration_restore_conflict');
    for (const field of ['modelProvider', 'model']) {
      const value = message.request.params[field];
      if (value != null && value !== override.lease.expected[field] && value !== override.lease.original[field]) throw fail('configuration_restore_conflict');
    }
    override.used = true;
    send({ ...message, request: { ...message.request, params: { ...message.request.params, ...override.lease.original } } });
    return true;
  }
  return {
    reconfigure(owner, args, signal) {
      const operation = apply(owner, args, signal);
      const jobs = inflight.get(owner) ?? new Set(); jobs.add(operation); inflight.set(owner, jobs);
      const finished = () => { jobs.delete(operation); if (!jobs.size) inflight.delete(owner); };
      operation.then(finished, finished);
      return operation;
    },
    restore, inspect, intercept,
    list: () => [...leases.values()].map(lease => ({ pluginId: lease.owner.pluginId, generation: lease.owner.generation,
      registrationId: lease.owner.id, threadId: lease.threadId, status: lease.status, original: { ...lease.original }, expected: { ...lease.expected } })),
    authorize(message, owner) {
      const lease = leases.get(message.request.params?.threadId);
      if (lease?.status === 'pending' && operations.has(lease.threadId) && lease.owner !== owner) throw fail('configuration_owned');
    },
    available: () => alive && cleanupAvailable && reconfiguration.available(),
    pending: () => leases.size,
    dispose() {
      alive = false; overrides.clear();
      const count = leases.size; leases.clear();
      return count ? { reloadRequired: true, reason: `${count} task provider restoration(s) are unconfirmed; inspect or restore the tasks before retiring their routes` } : undefined;
    }
  };
}
