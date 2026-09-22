'use strict';
const net = require('node:net');
const { randomBytes } = require('node:crypto');
const MAX_FRAME = 64 * 1024, CHUNK = 32 * 1024, MAX_BODY = 64 * 1024 * 1024;
const failure = code => Object.assign(new Error(code), { code });

async function connectTrafficPeer(endpoint, { signal, handle, event = () => {}, detach = fn => fn() } = {}) {
  if (endpoint?.host !== '127.0.0.1' || !Number.isInteger(endpoint.port) || endpoint.port < 1 || endpoint.port > 65535 || typeof endpoint.token !== 'string' || endpoint.token.length > 128) throw failure('invalid_data_endpoint');
  if (signal?.aborted) throw failure('host_stopping');
  const socket = net.createConnection({ host: endpoint.host, port: endpoint.port }); socket.setNoDelay(true);
  const pending = new Map(), inbound = new Set();
  let sequence = 0, closed = false, buffer = Buffer.alloc(0), ready, failReady;
  const connected = new Promise((resolve, reject) => { ready = resolve; failReady = reject; });
  const handshake = setTimeout(() => close(failure('traffic_connect_timeout')), 5000);
  function close(reason = failure('peer_closed')) {
    if (closed) return;
    closed = true; clearTimeout(handshake); signal?.removeEventListener('abort', aborted); socket.destroy();
    failReady(reason);
    for (const item of pending.values()) { clearTimeout(item.timer); item.signal?.removeEventListener('abort', item.abort); item.reject(reason); }
    pending.clear(); inbound.clear(); buffer = Buffer.alloc(0);
    try { event({ event: 'closed' }); } catch {}
  }
  const aborted = () => close(failure('host_stopping'));
  signal?.addEventListener('abort', aborted, { once: true });
  function send(value) {
    if (closed) throw failure('peer_closed');
    const encoded = Buffer.from(JSON.stringify(value));
    if (encoded.length > MAX_FRAME) throw failure('frame_too_large');
    if (socket.writableLength + encoded.length + 4 > 512 * 1024) throw failure('traffic_backpressure');
    const packet = Buffer.allocUnsafe(encoded.length + 4); packet.writeUInt32BE(encoded.length); encoded.copy(packet, 4);
    socket.write(packet);
  }
  socket.once('connect', () => { try { send({ token: endpoint.token }); } catch (error) { close(error); } });
  socket.on('error', () => close(failure('peer_closed'))); socket.on('close', () => close());
  socket.on('data', chunk => detach(() => {
    try {
      // A TCP delivery may coalesce many frames. Consume it without concatenating
      // an unbounded receive buffer or borrowing a management RPC invocation.
      let offset = 0;
      while (offset < chunk.length) {
        const required = buffer.length < 4 ? 4 : buffer.readUInt32BE(0) + 4;
        if (required > MAX_FRAME + 4 || required === 4 && buffer.length === 4) throw failure('invalid_frame');
        const take = Math.min(required - buffer.length, chunk.length - offset);
        buffer = Buffer.concat([buffer, chunk.subarray(offset, offset + take)]); offset += take;
        if (buffer.length >= 4 && (!buffer.readUInt32BE(0) || buffer.readUInt32BE(0) > MAX_FRAME)) throw failure('invalid_frame');
        if (buffer.length < 4 || buffer.length < buffer.readUInt32BE(0) + 4) continue;
        const size = buffer.readUInt32BE(0); if (!size || size > MAX_FRAME) throw failure('invalid_frame');
        const message = JSON.parse(buffer.subarray(4).toString('utf8')); buffer = Buffer.alloc(0);
        if (message.event) {
          if (message.event === 'connected') { clearTimeout(handshake); ready(); }
          else event(message);
          continue;
        }
        if (typeof message.method === 'string') {
          if (inbound.size >= 256 || typeof handle !== 'function' || inbound.has(message.id)) throw failure('traffic_backpressure');
          inbound.add(message.id);
          let operation;
          try { operation = handle(message.method, message.params); } catch (error) { operation = Promise.reject(error); }
          Promise.resolve(operation).then(result => {
            if (!closed && inbound.has(message.id)) send({ id: message.id, result: result ?? null });
          }, error => {
            if (!closed && inbound.has(message.id)) send({ id: message.id, error: { code: /^[a-z_]{1,64}$/u.test(error?.code) ? error.code : 'traffic_callback_failed' } });
          }).catch(() => close(failure('invalid_frame'))).finally(() => inbound.delete(message.id));
          continue;
        }
        const item = pending.get(message.id); if (!item) continue;
        pending.delete(message.id); clearTimeout(item.timer); item.signal?.removeEventListener('abort', item.abort);
        if (message.error) item.reject(failure(/^[a-z_]{1,64}$/u.test(message.error.code) ? message.error.code : 'traffic_callback_failed'));
        else { try { item.prepareResult?.(message.result); item.resolve(message.result); } catch { item.reject(failure('invalid_frame')); } }
      }
    } catch { close(failure('invalid_frame')); }
  }));
  await connected;
  function request(method, params = {}, { timeoutMs = 30000, signal: requestSignal, prepareResult, cancelOpen = false } = {}) {
    if (closed || requestSignal?.aborted) return Promise.reject(failure('peer_closed'));
    if (pending.size >= Math.min(endpoint.maxPendingRequests ?? 64, 256)) return Promise.reject(failure('resource_limit'));
    if (!Number.isInteger(timeoutMs) || timeoutMs < 1 || timeoutMs > 30000) return Promise.reject(failure('invalid_timeout'));
    return new Promise((resolve, reject) => {
      const id = ++sequence;
      const abort = () => {
        const item = pending.get(id); if (!item) return;
        pending.delete(id); clearTimeout(item.timer); requestSignal?.removeEventListener('abort', abort);
        if (cancelOpen && method === 'open' && !closed) {
          try { send({ id: ++sequence, method: 'cancelOpen', params: { request: id } }); }
          catch { close(failure('peer_closed')); }
        }
        reject(failure('request_cancelled'));
      };
      const timer = setTimeout(abort, timeoutMs);
      pending.set(id, { resolve, reject, timer, signal: requestSignal, abort, prepareResult });
      requestSignal?.addEventListener('abort', abort, { once: true });
      try { send({ id, method, params }); } catch (error) { abort(); close(error); }
    });
  }
  return Object.freeze({ request, close, status: () => ({ open: !closed, pending: pending.size, incoming: inbound.size, queuedBytes: socket.writableLength }) });
}

function createTrafficStreams(peer, lease, signal) {
  const sources = new Map(); let disposed = false;
  const check = () => { if (disposed || signal.aborted) throw failure('stream_retired'); };
  function exportBody(body) {
    check();
    if (body == null) return null;
    if (typeof body === 'string' || body instanceof Uint8Array) {
      if (Buffer.byteLength(body) > MAX_BODY) throw failure('body_too_large');
      const bytes = Buffer.from(body);
      if (bytes.length <= 1024) return { inline: bytes.toString('base64') };
      body = [bytes];
    }
    if (!body?.[Symbol.iterator] && !body?.[Symbol.asyncIterator]) throw failure('invalid_body');
    if (sources.size >= 8) throw failure('resource_limit');
    const stream = randomBytes(16).toString('hex');
    sources.set(stream, { body, iterator: null, chunk: null, offset: 0, total: 0, reading: false, cancelled: false, cancelRead: null });
    return { stream };
  }
  function importBody(reference, maximum = MAX_BODY) {
    if (reference == null) return null;
    if (typeof reference !== 'object' || Array.isArray(reference) || Object.keys(reference).length !== 1) throw failure('invalid_body');
    let used = false, finished = false, cancelled = false;
    const controller = new AbortController();
    const rootAborted = () => controller.abort(failure('stream_retired'));
    signal.addEventListener('abort', rootAborted, { once: true });
    const finish = () => { finished = true; signal.removeEventListener('abort', rootAborted); };
    const cancel = () => {
      if (finished || cancelled) return false; used = true; cancelled = true; finish(); controller.abort(failure('request_cancelled'));
      if (reference.stream) peer.request('relay', { lease, operation: 'stream.cancel', payload: { stream: reference.stream } }, { signal }).catch(() => {});
      return true;
    };
    return Object.freeze({ cancel, [Symbol.asyncIterator]() {
      if (used) throw failure('body_already_consumed'); used = true;
      let total = 0, ended = false, reading = false;
      return {
        async next() {
          check(); if (cancelled) throw failure('request_cancelled'); if (ended) return { done: true }; if (reading) throw failure('body_read_pending'); reading = true;
          try {
            let bytes;
            if (reference.inline !== undefined) { if (typeof reference.inline !== 'string' || reference.inline.length > 1368) throw failure('invalid_body'); bytes = Buffer.from(reference.inline, 'base64'); ended = true; finish(); }
            else {
              if (typeof reference.stream !== 'string' || !/^[a-f0-9]{32}$/u.test(reference.stream)) throw failure('invalid_body');
              const value = await peer.request('relay', { lease, operation: 'stream.read', payload: { stream: reference.stream } }, { signal: controller.signal });
              check(); if (value.done === true) { ended = true; finish(); return { done: true }; }
              if (typeof value.bytes !== 'string' || !value.bytes.length || value.bytes.length > Math.ceil(CHUNK / 3) * 4) throw failure('invalid_body');
              bytes = Buffer.from(value.bytes, 'base64'); if (bytes.length > CHUNK || bytes.toString('base64') !== value.bytes) throw failure('invalid_body');
            }
            const encoded = reference.inline !== undefined ? reference.inline : undefined;
            if (encoded !== undefined && bytes.toString('base64') !== encoded) throw failure('invalid_body');
            total += bytes.length; if (total > maximum) throw failure('body_too_large');
            return { done: false, value: bytes };
          } catch (error) { finish(); throw error; } finally { reading = false; }
        },
        async return() { ended = true; finish(); controller.abort(); if (reference.stream && !signal.aborted) await peer.request('relay', { lease, operation: 'stream.cancel', payload: { stream: reference.stream } }, { signal }).catch(() => {}); return { done: true }; },
      };
    } });
  }
  async function handle(operation, payload) {
    check();
    const source = sources.get(payload?.stream); if (!source) throw failure('stream_retired');
    if (operation === 'stream.cancel') { sources.delete(payload.stream); source.cancelled = true; source.cancelRead?.(); source.body.cancel?.(); if (source.iterator?.return) Promise.resolve(source.iterator.return()).catch(() => {}); return { cancelled: true }; }
    if (operation !== 'stream.read' || source.reading) throw failure('body_read_pending');
    source.reading = true;
    try {
      source.iterator ??= source.body[Symbol.asyncIterator]?.() ?? source.body[Symbol.iterator]();
      for (let empty = 0; !source.chunk || source.offset >= source.chunk.length; empty++) {
        if (empty >= 128) throw failure('invalid_body');
        const value = await new Promise((resolve, reject) => { source.cancelRead = () => reject(failure('stream_retired')); Promise.resolve().then(() => source.iterator.next()).then(resolve, reject); });
        source.cancelRead = null; check(); if (source.cancelled) throw failure('stream_retired');
        if (value.done) { sources.delete(payload.stream); return { done: true }; }
        if (typeof value.value !== 'string' && !(value.value instanceof Uint8Array)) throw failure('invalid_body');
        source.total += Buffer.byteLength(value.value); if (source.total > MAX_BODY) throw failure('body_too_large');
        source.chunk = Buffer.from(value.value); source.offset = 0;
      }
      const chunk = source.chunk.subarray(source.offset, source.offset + CHUNK); source.offset += chunk.length;
      return { done: false, bytes: chunk.toString('base64') };
    } finally { source.reading = false; source.cancelRead = null; }
  }
  async function importFrame(frame) {
    if (typeof frame?.binary !== 'boolean') throw failure('invalid_frame');
    const body = importBody(frame.body, 8 * 1024 * 1024); if (!body) throw failure('invalid_frame');
    const chunks = []; for await (const chunk of body) chunks.push(Buffer.from(chunk));
    const bytes = Buffer.concat(chunks);
    return Object.freeze({ binary: frame.binary, data: frame.binary ? bytes : bytes.toString('utf8') });
  }
  function exportFrame(frame) {
    if (frame == null) return null;
    if (typeof frame === 'string') frame = { binary: false, data: frame };
    if (frame instanceof Uint8Array) frame = { binary: true, data: frame };
    if (typeof frame?.binary !== 'boolean' || (frame.binary ? !(frame.data instanceof Uint8Array) : typeof frame.data !== 'string') || Buffer.byteLength(frame.data) > 8 * 1024 * 1024) throw failure('invalid_frame');
    return { binary: frame.binary, body: exportBody(frame.data) };
  }
  function dispose() {
    if (disposed) return; disposed = true; signal.removeEventListener('abort', dispose);
    for (const source of sources.values()) { source.cancelled = true; source.cancelRead?.(); try { source.body.cancel?.(); if (source.iterator?.return) Promise.resolve(source.iterator.return()).catch(() => {}); } catch {} }
    sources.clear();
  }
  signal.addEventListener('abort', dispose, { once: true });
  return Object.freeze({ exportBody, importBody, exportFrame, importFrame, handle, dispose, status: () => ({ streams: sources.size, retired: disposed }) });
}

module.exports = { connectTrafficPeer, createTrafficStreams };
