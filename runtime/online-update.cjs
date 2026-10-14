'use strict';
// The ledger belongs to the retained Core transport. A generation may disappear;
// receipts and accepted operations must not disappear with it.
const {createHash} = require('node:crypto');
const fail = code => Object.assign(new Error(code), {code});
const label = value => typeof value === 'string' && /^[A-Za-z0-9_.-]{1,128}$/.test(value);

function snapshotJson(value, maxBytes = 256 * 1024) {
  const visited = new Set();
  function visit(item, depth) {
    if (depth > 64) throw fail('core_update_snapshot_invalid');
    if (item === null || typeof item === 'string' || typeof item === 'boolean') return;
    if (typeof item === 'number' && Number.isFinite(item)) return;
    if (typeof item !== 'object' || visited.has(item)) throw fail('core_update_snapshot_invalid');
    const prototype = Object.getPrototypeOf(item);
    if (prototype !== Object.prototype && prototype !== null && !Array.isArray(item)) throw fail('core_update_snapshot_invalid');
    visited.add(item);
    for (const key of Reflect.ownKeys(item)) {
      if (typeof key !== 'string' || ['__proto__', 'constructor', 'prototype'].includes(key)) throw fail('core_update_snapshot_invalid');
      const descriptor = Object.getOwnPropertyDescriptor(item, key);
      if (!('value' in descriptor)) throw fail('core_update_snapshot_invalid');
      if (Array.isArray(item) && key === 'length') continue;
      visit(descriptor.value, depth + 1);
    }
    visited.delete(item);
  }
  visit(value, 0);
  const json = JSON.stringify(value);
  if (Buffer.byteLength(json) > maxBytes) throw fail('core_update_snapshot_too_large');
  return JSON.parse(json);
}

function createWriteLedger({getEpoch, capacity = 256}) {
  const records = new Map();
  const waiters = new Set();
  let accepting = true, closed = false;
  const inspect = () => ({accepting: accepting && !closed, pending: [...records.values()].filter(item => item.receipt.pending).length,uncertain:[...records.values()].filter(item=>item.receipt.outcome==='unknown').length,waiting:waiters.size});
  function receipt(item) { return {...item.receipt}; }
  function settle(item, result) {
    // A timeout/cancellation is explicit uncertainty. A late reply cannot turn
    // the original receipt into an applied response from another owner epoch.
    if (!item.receipt.pending) return;
    item.receipt = {operationId: item.id, epoch: item.epoch, pending: false, ...result};
    item.resolve(receipt(item));
  }
  function reserve(input, handler, generated = false) {
    if (!label(input.operationId) || !Number.isSafeInteger(input.expectedEpoch)) throw fail('core_write_invalid');
    const params = snapshotJson(input.params ?? null);
    const fingerprint = createHash('sha256').update(JSON.stringify([input.expectedEpoch, input.method, params])).digest('hex');
    const prior = records.get(input.operationId);
    if (prior) {
      if (prior.fingerprint !== fingerprint) throw fail('core_write_id_conflict');
      return prior;
    }
    if (closed || !accepting) throw fail('core_write_admission_paused');
    if (input.expectedEpoch !== getEpoch()) throw fail('core_write_stale_epoch');
    if (records.size >= capacity) {
      const retired = [...records.values()].find(item => item.generated && !item.executing && !item.receipt.pending && item.receipt.outcome!=='unknown');
      if (retired) records.delete(retired.id);
      else throw fail('core_write_receipt_capacity');
    }
    const controller = new AbortController();
    let resolve;
    const done = new Promise(finish => resolve = finish);
    const item = {id: input.operationId, epoch: input.expectedEpoch, fingerprint, controller, resolve, done, executing: true, generated,
      receipt: {operationId: input.operationId, epoch: input.expectedEpoch, pending: true, outcome: 'accepted'}};
    records.set(item.id, item);
    Promise.resolve().then(() => handler(params, {signal: controller.signal, operationId: item.id, epoch: item.epoch})).then(
      value => {
        item.executing = false;
        try { settle(item, {outcome: 'applied', value: snapshotJson(value ?? null)}); }
        catch { settle(item, {outcome: 'unknown', error: 'core_write_result_invalid'}); }
      }, error => {item.executing = false; settle(item, {outcome: error?.outcome === 'not_applied' ? 'not_applied' : 'unknown', error: /^[a-z_]{1,80}$/.test(error?.code) ? error.code : 'core_write_failed'});});
    return item;
  }
  return Object.freeze({
    inspect,
    accept(input, handler) { return receipt(reserve(input, handler)); },
    async execute(input, handler) { return reserve(input, handler).done; },
    async executeGenerated(input, handler) { return reserve(input, handler, true).done; },
    result(id) { return records.has(id) ? receipt(records.get(id)) : {operationId: id, pending: false, outcome: 'unknown', unknown: true}; },
    receipts() { return [...records.values()].map(receipt); },
    whenAccepting(signal) {
      if (closed || signal?.aborted) return Promise.reject(fail('core_write_owner_closed'));
      if (accepting) return Promise.resolve();
      return new Promise((resolve, reject) => {
        const item = {resolve: () => {signal?.removeEventListener('abort', abort); resolve();}, reject};
        const abort = () => {waiters.delete(item); reject(fail('core_write_cancelled'));};
        signal?.addEventListener('abort', abort, {once:true}); waiters.add(item);
      });
    },
    cancel(id) {
      const item = records.get(id);
      if (!item) return {operationId: id, pending: false, outcome: 'unknown', unknown: true};
      if (item.receipt.pending) { item.controller.abort(); settle(item, {outcome: 'unknown', error: 'core_write_cancelled'}); }
      return receipt(item);
    },
    pause() { accepting = false; },
    resume() { if (!closed) {accepting = true; for(const item of waiters)item.resolve();waiters.clear();} },
    async drain(timeoutMs = 8000) {
      const pending = [...records.values()].filter(item => item.receipt.pending || item.executing || item.receipt.outcome==='unknown');
      if (!pending.length) return [];
      let timer;
      try {
        await Promise.race([Promise.all(pending.map(item => item.done)), new Promise(resolve => timer = setTimeout(resolve, timeoutMs))]);
      } finally { clearTimeout(timer); }
      // Keep executing operations attached to their original generation. An
      // uncertain drain aborts takeover; no accepted write is reissued.
      return pending.filter(item => item.receipt.pending || item.executing || item.receipt.outcome === 'unknown').map(item => receipt(item));
    },
    close() {
      closed = true; accepting = false;
      for (const item of waiters) item.reject(fail('core_write_owner_closed')); waiters.clear();
      for (const item of records.values()) if (item.receipt.pending) {item.controller.abort(); settle(item, {outcome: 'unknown', error: 'core_write_owner_closed'});}
    },
  });
}
module.exports = {createWriteLedger, snapshotJson};
