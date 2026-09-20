'use strict';

// Embedded before host.cjs by Core. Keeping the transport in its own source file
// also lets the socket behavior run under Node's ordinary test runner.
const httpTraffic = require('node:http');
const httpsTraffic = require('node:https');
const { randomBytes: trafficRandomBytes, randomUUID: trafficRandomUUID } = require('node:crypto');
const { WebSocket: TrafficWebSocket, WebSocketServer: TrafficWebSocketServer } = require('ws');

const TRAFFIC_MAX_BYTES = 64 * 1024 * 1024;
const TRAFFIC_MAX_HEADERS = 128;
const TRAFFIC_MAX_HEADER_BYTES = 32 * 1024;
const TRAFFIC_MAX_CONCURRENT = 4;
const TRAFFIC_MAX_CHANNELS = 4;
const TRAFFIC_MAX_TIMEOUT = 15000;
const TRAFFIC_MAX_WS_MESSAGE = 8 * 1024 * 1024;
const TRAFFIC_MAX_WS_QUEUE = 16 * 1024 * 1024;
const TRAFFIC_MAX_WS_QUEUE_FRAMES = 256;
const TRAFFIC_HOP_HEADERS = new Set([
  'connection', 'keep-alive', 'proxy-authenticate', 'proxy-authorization',
  'proxy-connection', 'te', 'trailer', 'transfer-encoding', 'upgrade',
]);

function createTrafficRuntime({ coreRequest, rootSignal, makeError }) {
  if (typeof coreRequest !== 'function' || typeof makeError !== 'function') throw new TypeError('traffic runtime dependencies are required');
  const channels = new Map();
  let retired = false, opening = 0;

  const fail = (code, message, data) => makeError(code, message, data);
  const integer = (value, fallback, maximum, name) => {
    value ??= fallback;
    if (!Number.isSafeInteger(value) || value < 1 || value > maximum) throw fail('invalid_argument', `${name} must be an integer in 1..${maximum}`);
    return value;
  };
  const ownObject = value => value !== null && typeof value === 'object' && !Array.isArray(value);

  function headerPairs(value, name) {
    if (value == null) return [];
    if (!Array.isArray(value) || value.length > TRAFFIC_MAX_HEADERS) throw fail('invalid_argument', `${name} must be an array of header pairs`);
    let bytes = 0;
    return value.map(pair => {
      if (!Array.isArray(pair) || pair.length !== 2 || typeof pair[0] !== 'string' || typeof pair[1] !== 'string'
        || !pair[0] || /[^!#$%&'*+.^_`|~0-9A-Za-z-]/u.test(pair[0]) || /[\r\n]/u.test(pair[1])) {
        throw fail('invalid_argument', `${name} contains an invalid header pair`);
      }
      bytes += Buffer.byteLength(pair[0]) + Buffer.byteLength(pair[1]);
      if (bytes > TRAFFIC_MAX_HEADER_BYTES) throw fail('invalid_argument', `${name} exceed ${TRAFFIC_MAX_HEADER_BYTES} bytes`);
      return [pair[0], pair[1]];
    });
  }

  function connectionTokens(pairs) {
    const tokens = new Set();
    for (const [name, value] of pairs) if (name.toLowerCase() === 'connection') {
      for (const token of value.split(',')) if (token.trim()) tokens.add(token.trim().toLowerCase());
    }
    return tokens;
  }

  function stripHeaders(pairs, { outbound = false } = {}) {
    const nominated = connectionTokens(pairs);
    return pairs.filter(([name]) => {
      const lower = name.toLowerCase();
      if (TRAFFIC_HOP_HEADERS.has(lower) || nominated.has(lower) || lower === 'host') return false;
      // Node owns framing after any body transformation.
      if (outbound && lower === 'content-length') return false;
      return true;
    });
  }

  function rawHeaderPairs(rawHeaders) {
    const pairs = [];
    for (let index = 0; index + 1 < rawHeaders.length; index += 2) pairs.push([String(rawHeaders[index]), String(rawHeaders[index + 1])]);
    return stripHeaders(pairs);
  }

  function onceBody(source, maximum, signal, label, destroy, onFinish) {
    let used = false, finished = false, sourceFailure;
    const cleanup = () => {
      if (finished) return;
      finished = true;
      signal.removeEventListener('abort', aborted);
      source.off?.('error', sourceErrored);
      onFinish?.();
    };
    const sourceErrored = reason => {
      sourceFailure = fail('stream_failed', `${label} body stream failed: ${reason?.message ?? reason}`);
      cleanup();
    };
    const cancel = () => { destroy?.(); cleanup(); };
    const aborted = () => cancel();
    source.once?.('error', sourceErrored);
    if (signal.aborted) aborted(); else signal.addEventListener('abort', aborted, { once: true });
    return Object.freeze({
      cancel() {
        if (finished) return false;
        used = true;
        cancel();
        return true;
      },
      [Symbol.asyncIterator]() {
        if (used) throw fail('body_already_consumed', `${label} body is a one-shot stream`);
        used = true;
        let bytes = 0;
        const iterator = source[Symbol.asyncIterator]();
        return {
          async next() {
            if (signal.aborted) throw signal.reason ?? fail('request_cancelled', `${label} body was cancelled`);
            if (sourceFailure) throw sourceFailure;
            let item;
            try { item = await iterator.next(); }
            catch (reason) { cleanup(); throw fail('stream_failed', `${label} body stream failed: ${reason?.message ?? reason}`); }
            if (item.done) { cleanup(); return item; }
            const chunk = Buffer.isBuffer(item.value) ? item.value : Buffer.from(item.value);
            bytes += chunk.byteLength;
            if (bytes > maximum) {
              destroy?.(); cleanup();
              throw fail('body_too_large', `${label} body exceeds ${maximum} bytes`);
            }
            return { done: false, value: new Uint8Array(chunk.buffer, chunk.byteOffset, chunk.byteLength) };
          },
          async return() {
            try { return typeof iterator.return === 'function' ? await iterator.return() : { done: true }; }
            finally { destroy?.(); cleanup(); }
          },
        };
      },
    });
  }

  function responseBody(value) {
    if (value == null) return null;
    if (typeof value === 'string' || value instanceof Uint8Array || Buffer.isBuffer(value)) return [value];
    if (typeof value?.[Symbol.asyncIterator] !== 'function' && typeof value?.[Symbol.iterator] !== 'function') {
      throw fail('invalid_response', 'response body must be text, bytes, or an iterable of byte chunks');
    }
    return value;
  }

  function normalizeResponse(value) {
    if (!ownObject(value)) throw fail('invalid_response', 'HTTP handler must return a response object');
    if (Object.keys(value).some(key => !['status', 'headers', 'body'].includes(key))) throw fail('invalid_response', 'HTTP response contains an unsupported field');
    if (!Number.isInteger(value.status) || value.status < 200 || value.status > 599) throw fail('invalid_response', 'HTTP response status must be 200..599');
    return { status: value.status, headers: stripHeaders(headerPairs(value.headers, 'response headers'), { outbound: true }), body: responseBody(value.body) };
  }

  function normalizeFrame(value, original) {
    if (value == null) return null;
    if (typeof value === 'string') return { data: value, binary: false };
    if (value instanceof Uint8Array || Buffer.isBuffer(value)) return { data: value, binary: true };
    if (!ownObject(value) || Object.keys(value).some(key => !['data', 'binary'].includes(key)) || typeof value.binary !== 'boolean') {
      throw fail('invalid_websocket_frame', 'WebSocket transform must return text, bytes, a frame, or null');
    }
    if (value.binary) {
      if (!(value.data instanceof Uint8Array) && !Buffer.isBuffer(value.data)) throw fail('invalid_websocket_frame', 'binary WebSocket frames require bytes');
    } else if (typeof value.data !== 'string') throw fail('invalid_websocket_frame', 'text WebSocket frames require a string');
    return { data: value.data, binary: value.binary ?? original.binary };
  }

  function websocketProtocols(value) {
    if (value == null) return [];
    if (!Array.isArray(value) || value.length > 32 || new Set(value).size !== value.length
      || value.some(protocol => typeof protocol !== 'string' || !/^[!#$%&'*+.^_`|~0-9A-Za-z-]{1,128}$/u.test(protocol))) {
      throw fail('invalid_argument', 'WebSocket protocols must be at most 32 distinct protocol tokens');
    }
    return [...value];
  }

  function headerObject(pairs) {
    const headers = Object.create(null);
    for (const [name, value] of pairs) {
      const lower = name.toLowerCase();
      if (headers[lower] === undefined) headers[lower] = value;
      else if (Array.isArray(headers[lower])) headers[lower].push(value);
      else headers[lower] = [headers[lower], value];
    }
    return headers;
  }

  function writeChunk(stream, chunk, signal) {
    if (signal.aborted) return Promise.reject(signal.reason ?? fail('request_cancelled', 'HTTP exchange was cancelled'));
    const bytes = typeof chunk === 'string' ? Buffer.from(chunk) : Buffer.from(chunk);
    if (stream.write(bytes)) return Promise.resolve(bytes.byteLength);
    return new Promise((resolve, reject) => {
      const done = failure => {
        stream.off('drain', drained); stream.off('error', errored); signal.removeEventListener('abort', aborted);
        failure ? reject(failure) : resolve(bytes.byteLength);
      };
      const drained = () => done();
      const errored = reason => done(reason);
      const aborted = () => done(signal.reason ?? fail('request_cancelled', 'HTTP exchange was cancelled'));
      stream.once('drain', drained); stream.once('error', errored); signal.addEventListener('abort', aborted, { once: true });
    });
  }

  function raceAbort(operation, signal, message) {
    return new Promise((resolve, reject) => {
      let settled = false;
      const done = (succeeded, value) => {
        if (settled) return;
        settled = true;
        signal.removeEventListener('abort', aborted);
        succeeded ? resolve(value) : reject(value);
      };
      const aborted = () => done(false, signal.reason ?? fail('request_cancelled', message));
      if (signal.aborted) { aborted(); return; }
      signal.addEventListener('abort', aborted, { once: true });
      Promise.resolve().then(() => typeof operation === 'function' ? operation() : operation).then(
        value => done(true, value),
        reason => done(false, reason),
      );
    });
  }

  async function pipeBody(body, stream, signal, maximum, label) {
    if (body == null) return;
    let bytes = 0;
    const iterator = typeof body[Symbol.asyncIterator] === 'function' ? body[Symbol.asyncIterator]() : body[Symbol.iterator]();
    let completed = false;
    try {
      while (true) {
        const item = await raceAbort(() => iterator.next(), signal, `${label} body was cancelled`);
        if (item.done) { completed = true; return; }
        const chunk = item.value;
        const length = typeof chunk === 'string' ? Buffer.byteLength(chunk) : Buffer.byteLength(Buffer.from(chunk));
        bytes += length;
        if (bytes > maximum) throw fail('body_too_large', `${label} body exceeds ${maximum} bytes`);
        await writeChunk(stream, chunk, signal);
      }
    } finally {
      if (!completed && typeof iterator.return === 'function') {
        try { Promise.resolve(iterator.return()).catch(() => {}); } catch {}
      }
    }
  }

  function linkAbort(controller, signal, reason) {
    if (!signal) return () => {};
    const abort = () => { if (!controller.signal.aborted) controller.abort(signal.reason ?? reason); };
    if (signal.aborted) abort(); else signal.addEventListener('abort', abort, { once: true });
    return () => signal.removeEventListener('abort', abort);
  }

  async function forwardHttp(input, signal, requestLimit, responseLimit, responseFinished) {
    if (!ownObject(input) || Object.keys(input).some(key => !['url', 'method', 'headers', 'body'].includes(key))) throw fail('invalid_argument', 'forward expects url, method, headers and body only');
    if (typeof input.url !== 'string' || !input.url) throw fail('invalid_argument', 'forward url is required');
    const authorized = await coreRequest('host.network.authorizeForward', { url: input.url }, signal);
    if (signal.aborted) throw signal.reason ?? fail('request_cancelled', 'HTTP exchange was cancelled');
    const target = new URL(authorized?.url);
    const transport = target.protocol === 'http:' ? httpTraffic : target.protocol === 'https:' ? httpsTraffic : null;
    if (!transport) throw fail('protocol_error', 'Core authorized an unsupported transport');
    const method = input.method ?? 'GET';
    if (typeof method !== 'string' || !/^[!#$%&'*+.^_`|~0-9A-Za-z-]{1,32}$/u.test(method)) throw fail('invalid_argument', 'forward method is invalid');
    if (method.toUpperCase() === 'CONNECT') throw fail('invalid_argument', 'forward does not support CONNECT tunnels');
    const body = responseBody(input.body);
    if (body != null && ['GET', 'HEAD'].includes(method.toUpperCase())) throw fail('invalid_argument', `${method.toUpperCase()} forward requests cannot have a body`);
    const headers = stripHeaders(headerPairs(input.headers, 'forward headers'), { outbound: true });
    return new Promise((resolve, reject) => {
      let settled = false;
      const finish = (failure, value) => {
        if (settled) return;
        settled = true; signal.removeEventListener('abort', abort);
        failure ? reject(failure) : resolve(value);
      };
      const upstream = transport.request(target, { method, headers: ['Host', target.host, ...headers.flatMap(pair => pair)], agent: false }, response => {
        const body = onceBody(response, responseLimit, signal, 'upstream response', () => response.destroy(), responseFinished);
        finish(null, Object.freeze({ status: response.statusCode ?? 502, headers: rawHeaderPairs(response.rawHeaders), body }));
      });
      const abort = () => { upstream.destroy(signal.reason ?? fail('request_cancelled', 'HTTP exchange was cancelled')); finish(signal.reason ?? fail('request_cancelled', 'HTTP exchange was cancelled')); };
      signal.addEventListener('abort', abort, { once: true });
      upstream.once('error', reason => finish(fail('upstream_failed', `upstream request failed: ${reason?.message ?? reason}`)));
      Promise.resolve().then(async () => {
        if (body != null) await pipeBody(body, upstream, signal, requestLimit, 'upstream request');
        upstream.end();
      }).catch(reason => { upstream.destroy(reason); finish(reason); });
    });
  }

  function waitWebSocketOpen(socket, signal) {
    return new Promise((resolve, reject) => {
      const done = failure => {
        socket.off('open', opened); socket.off('error', errored); socket.off('unexpected-response', unexpected); signal.removeEventListener('abort', aborted);
        failure ? reject(failure) : resolve();
      };
      const opened = () => { socket._socket?.pause(); done(); };
      const errored = reason => done(fail('upstream_websocket_failed', `upstream WebSocket failed: ${reason?.message ?? reason}`));
      const unexpected = (_request, response) => {
        const status = response.statusCode ?? 502;
        response.resume();
        done(fail('upstream_websocket_rejected', `upstream WebSocket returned HTTP ${status}`, { status }));
      };
      const aborted = () => { socket.terminate(); done(signal.reason ?? fail('request_cancelled', 'WebSocket exchange was cancelled')); };
      socket.once('open', opened); socket.once('error', errored); socket.once('unexpected-response', unexpected); signal.addEventListener('abort', aborted, { once: true });
    });
  }

  function bridgeWebSockets(downstream, upstream, options, signal, initialServerFrames) {
    let settled = false;
    const finishers = [];
    const closed = new Promise(resolve => finishers.push(resolve));
    const finish = reason => {
      if (settled) return;
      settled = true;
      signal.removeEventListener('abort', aborted);
      if (reason) {
        if (downstream.readyState < TrafficWebSocket.CLOSING) downstream.close(1011, 'bridge failed');
        if (upstream.readyState < TrafficWebSocket.CLOSING) upstream.close(1011, 'bridge failed');
      }
      // ws otherwise keeps a peer that never completes its close handshake for
      // roughly 30 seconds, after this exchange has already left active ownership.
      for (const socket of [downstream, upstream]) if (socket.readyState !== TrafficWebSocket.CLOSED) {
        const timer = setTimeout(() => {
          if (socket.readyState !== TrafficWebSocket.CLOSED) socket.terminate();
        }, 1000);
        timer.unref?.();
        socket.once('close', () => clearTimeout(timer));
      }
      for (const resolve of finishers) resolve({ code: reason ? 'bridge_failed' : 'closed' });
    };
    const aborted = () => {
      if (downstream.readyState !== TrafficWebSocket.CLOSED) downstream.terminate();
      if (upstream.readyState !== TrafficWebSocket.CLOSED) upstream.terminate();
      finish(signal.reason ?? fail('request_cancelled', 'WebSocket exchange was cancelled'));
    };
    signal.addEventListener('abort', aborted, { once: true });

    function propagateClose(target, code, reason) {
      if (target.readyState >= TrafficWebSocket.CLOSING) return;
      if (code === 1006) target.terminate();
      else if (code === 1005) target.close();
      else target.close(code, reason);
    }
    function pump(source, target, transform, direction) {
      let chain = Promise.resolve(), queued = 0, queuedFrames = 0;
      const enqueue = (data, binary) => {
        if (settled) return;
        const length = Buffer.byteLength(data);
        queued += length; queuedFrames += 1;
        if (queued > options.maxQueueBytes || queuedFrames > options.maxQueueFrames) {
          source.close(1013, 'bridge queue exceeded'); target.close(1013, 'bridge queue exceeded');
          finish(fail('websocket_queue_full', `${direction} WebSocket queue exceeds its byte or frame bound`));
          return;
        }
        source._socket?.pause();
        chain = chain.then(async () => {
          if (settled || signal.aborted) return;
          const original = Object.freeze({ data: binary ? new Uint8Array(data.buffer, data.byteOffset, data.byteLength) : data.toString('utf8'), binary: !!binary });
          const transformed = normalizeFrame(transform ? await transform(original, Object.freeze({ signal, direction })) : original, original);
          if (transformed != null) {
            const transformedBytes = Buffer.byteLength(typeof transformed.data === 'string' ? Buffer.from(transformed.data) : Buffer.from(transformed.data));
            if (transformedBytes > options.maxMessageBytes) throw fail('websocket_message_too_large', `${direction} transformed frame exceeds ${options.maxMessageBytes} bytes`);
            await new Promise((resolve, reject) => {
              if (target.readyState !== TrafficWebSocket.OPEN) return reject(fail('websocket_closed', `${direction} target closed before send`));
              target.send(transformed.data, { binary: transformed.binary }, reason => reason ? reject(reason) : resolve());
            });
          }
        }).catch(reason => finish(reason)).finally(() => {
          queued -= length; queuedFrames -= 1;
          if (!settled && queuedFrames === 0) source._socket?.resume();
        });
      };
      source.on('message', enqueue);
      source.on('error', reason => finish(fail('websocket_failed', `${direction} WebSocket failed: ${reason?.message ?? reason}`)));
      source.on('close', (code, reason) => {
        if (!settled) propagateClose(target, code, reason);
        finish();
      });
      return { enqueue, resume: () => { if (queuedFrames === 0) source._socket?.resume(); } };
    }
    const clientPump = pump(downstream, upstream, options.clientToServer, 'clientToServer');
    const serverPump = pump(upstream, downstream, options.serverToClient, 'serverToClient');
    for (const frame of initialServerFrames) serverPump.enqueue(frame.data, frame.binary);
    clientPump.resume(); serverPump.resume();
    return closed;
  }

  async function forwardWebSocket(input, request, incoming, socket, head, webSocketServer, signal, limits) {
    if (!ownObject(input) || Object.keys(input).some(key => !['url', 'protocols', 'headers', 'clientToServer', 'serverToClient'].includes(key))) {
      throw fail('invalid_argument', 'WebSocket forward contains an unsupported field');
    }
    if (typeof input.url !== 'string' || !input.url) throw fail('invalid_argument', 'WebSocket forward url is required');
    for (const transform of [input.clientToServer, input.serverToClient]) if (transform != null && typeof transform !== 'function') throw fail('invalid_argument', 'WebSocket transforms must be functions');
    const protocols = websocketProtocols(input.protocols);
    const authorized = await coreRequest('host.network.authorizeForward', { url: input.url }, signal);
    if (signal.aborted) throw signal.reason ?? fail('request_cancelled', 'WebSocket exchange was cancelled before dispatch');
    const target = new URL(authorized?.url);
    if (!['ws:', 'wss:'].includes(target.protocol)) throw fail('protocol_error', 'Core authorized a non-WebSocket URL for WebSocket forwarding');
    const headers = stripHeaders(headerPairs(input.headers, 'WebSocket forward headers'), { outbound: true })
      .filter(([name]) => !name.toLowerCase().startsWith('sec-websocket-'));
    const upstream = new TrafficWebSocket(target, protocols, {
      headers: headerObject(headers), followRedirects: false, handshakeTimeout: limits.handlerTimeout,
      maxPayload: limits.maxMessageBytes, perMessageDeflate: false,
    });
    const initialServerFrames = [];
    let initialBytes = 0, initialOverflow = false;
    const captureInitial = (data, binary) => {
      initialBytes += Buffer.byteLength(data);
      if (initialServerFrames.length >= limits.maxQueueFrames || initialBytes > limits.maxQueueBytes) {
        initialOverflow = true;
        upstream.close(1013, 'bridge queue exceeded');
        return;
      }
      initialServerFrames.push({ data: Buffer.from(data), binary });
    };
    upstream.on('message', captureInitial);
    await waitWebSocketOpen(upstream, signal);
    if (initialOverflow) {
      upstream.terminate();
      throw fail('websocket_queue_full', 'upstream WebSocket sent too many frames before the bridge was ready');
    }
    if (upstream.protocol && !request.protocols.includes(upstream.protocol)) {
      upstream.close(1002, 'subprotocol unavailable');
      throw fail('websocket_protocol_mismatch', 'upstream selected a protocol the downstream did not offer');
    }
    incoming.__codletProtocol = upstream.protocol || false;
    let downstream;
    try {
      downstream = await new Promise((resolve, reject) => {
        try { webSocketServer.handleUpgrade(incoming, socket, head, resolve); }
        catch (reason) { reject(fail('websocket_upgrade_failed', reason?.message ?? String(reason))); }
      });
    } catch (reason) {
      upstream.terminate();
      throw reason;
    }
    upstream.off('message', captureInitial);
    const closed = bridgeWebSockets(downstream, upstream, {
      maxQueueBytes: limits.maxQueueBytes, maxQueueFrames: limits.maxQueueFrames, maxMessageBytes: limits.maxMessageBytes,
      clientToServer: input.clientToServer,
      serverToClient: input.serverToClient,
    }, signal, initialServerFrames);
    return Object.freeze({ protocol: upstream.protocol || null, closed });
  }

  async function openChannel(options = {}, handlers) {
    if (retired || rootSignal.aborted) throw fail('host_stopping', 'Host traffic runtime has retired');
    if (!ownObject(options) || Object.keys(options).some(key => !['maxConcurrent', 'maxRequestBytes', 'maxResponseBytes', 'maxForwardAttempts', 'handlerTimeoutMs', 'maxWebSocketMessageBytes', 'maxWebSocketQueueBytes', 'maxWebSocketQueueFrames'].includes(key))) throw fail('invalid_argument', 'unsupported traffic channel option');
    if (!ownObject(handlers) || Object.keys(handlers).some(key => !['http', 'webSocket'].includes(key))) throw fail('invalid_handler', 'traffic channel handlers must be an object');
    const httpHandler = handlers.http, webSocketHandler = handlers.webSocket;
    if ((httpHandler != null && typeof httpHandler !== 'function') || (webSocketHandler != null && typeof webSocketHandler !== 'function') || (!httpHandler && !webSocketHandler)) throw fail('invalid_handler', 'traffic channel needs an HTTP or WebSocket handler');
    const maximumConcurrent = integer(options.maxConcurrent, 4, TRAFFIC_MAX_CONCURRENT, 'maxConcurrent');
    const requestLimit = integer(options.maxRequestBytes, 8 * 1024 * 1024, TRAFFIC_MAX_BYTES, 'maxRequestBytes');
    const responseLimit = integer(options.maxResponseBytes, 32 * 1024 * 1024, TRAFFIC_MAX_BYTES, 'maxResponseBytes');
    const maxForwardAttempts = integer(options.maxForwardAttempts, 1, 8, 'maxForwardAttempts');
    const handlerTimeout = integer(options.handlerTimeoutMs, 15000, TRAFFIC_MAX_TIMEOUT, 'handlerTimeoutMs');
    const maxMessageBytes = integer(options.maxWebSocketMessageBytes, 1024 * 1024, TRAFFIC_MAX_WS_MESSAGE, 'maxWebSocketMessageBytes');
    const maxQueueBytes = integer(options.maxWebSocketQueueBytes, 2 * 1024 * 1024, TRAFFIC_MAX_WS_QUEUE, 'maxWebSocketQueueBytes');
    const maxQueueFrames = integer(options.maxWebSocketQueueFrames, 32, TRAFFIC_MAX_WS_QUEUE_FRAMES, 'maxWebSocketQueueFrames');
    if (channels.size + opening >= TRAFFIC_MAX_CHANNELS) throw fail('channel_limit', `a Host generation may own at most ${TRAFFIC_MAX_CHANNELS} traffic channels`);
    opening += 1;
    try {
    await coreRequest('host.network.authorizeChannel', {}, rootSignal);
    if (retired || rootSignal.aborted) throw fail('host_stopping', 'Host traffic runtime retired before listener creation');

    const token = trafficRandomBytes(32).toString('base64url');
    const prefix = `/${token}`;
    const sockets = new Set(), active = new Set();
    let concurrent = 0, forwardAttempts = 0, closed = false, closePromise;

    const server = httpTraffic.createServer({ maxHeaderSize: TRAFFIC_MAX_HEADER_BYTES }, async (incoming, outgoing) => {
      let requestUrl;
      try { requestUrl = new URL(incoming.url ?? '/', 'http://127.0.0.1'); }
      catch { outgoing.writeHead(400, { 'content-type': 'text/plain; charset=utf-8' }); outgoing.end('invalid request target'); return; }
      if (!(requestUrl.pathname === prefix || requestUrl.pathname.startsWith(`${prefix}/`))) {
        outgoing.writeHead(404, { 'content-type': 'text/plain; charset=utf-8' }); outgoing.end('not found'); return;
      }
      if (!httpHandler) {
        outgoing.writeHead(405, { 'content-type': 'text/plain; charset=utf-8' }); outgoing.end('HTTP handler unavailable'); return;
      }
      if (closed || retired || rootSignal.aborted) {
        outgoing.writeHead(503, { 'content-type': 'text/plain; charset=utf-8' }); outgoing.end('channel unavailable'); return;
      }
      if (concurrent >= maximumConcurrent) {
        outgoing.writeHead(503, { 'content-type': 'text/plain; charset=utf-8', 'retry-after': '1' }); outgoing.end('channel busy'); return;
      }
      concurrent += 1;
      const controller = new AbortController(); active.add(controller);
      const unlinkRoot = linkAbort(controller, rootSignal, fail('host_stopping', 'Host traffic runtime retired'));
      const cancelled = () => { if (!controller.signal.aborted) controller.abort(fail('request_cancelled', 'downstream client cancelled the request')); };
      incoming.once('aborted', cancelled); outgoing.once('close', () => { if (!outgoing.writableFinished) cancelled(); });
      let wroteHead = false;
      try {
        await coreRequest('host.network.authorizeChannel', {}, controller.signal);
        const suffix = requestUrl.pathname.slice(prefix.length) || '/';
        const requestBody = onceBody(incoming, requestLimit, controller.signal, 'incoming request', () => incoming.resume());
        const request = Object.freeze({
          id: trafficRandomUUID(), method: String(incoming.method ?? 'GET'), path: suffix + requestUrl.search,
          headers: Object.freeze(rawHeaderPairs(incoming.rawHeaders).map(pair => Object.freeze(pair))), body: requestBody,
        });
        let attempts = 0, responsePending = false;
        const exchange = Object.freeze({
          signal: controller.signal,
          get forwardAttempts() { return attempts; },
          maxForwardAttempts,
          async forward(input) {
            if (responsePending) throw fail('forward_response_pending', 'consume or cancel the previous upstream response body before another forward');
            if (attempts >= maxForwardAttempts) throw fail('forward_attempt_limit', `HTTP exchange exhausted its ${maxForwardAttempts} forward attempt(s)`);
            attempts += 1; forwardAttempts += 1; responsePending = true;
            try {
              return await forwardHttp(input, controller.signal, requestLimit, responseLimit, () => { responsePending = false; });
            } catch (reason) {
              responsePending = false;
              throw reason;
            }
          },
        });
        let timer;
        const timeout = new Promise((_, reject) => { timer = setTimeout(() => reject(fail('handler_timeout', `HTTP channel handler exceeded ${handlerTimeout} ms`)), handlerTimeout); });
        let response;
        try {
          response = normalizeResponse(await raceAbort(
            Promise.race([Promise.resolve().then(() => httpHandler(request, exchange)), timeout]),
            controller.signal,
            'HTTP handler was cancelled',
          ));
        }
        finally { clearTimeout(timer); }
        if (controller.signal.aborted) throw controller.signal.reason ?? fail('request_cancelled', 'HTTP exchange was cancelled');
        outgoing.writeHead(response.status, response.headers.flatMap(pair => pair));
        wroteHead = true;
        if (incoming.method === 'HEAD') outgoing.end();
        else { await pipeBody(response.body, outgoing, controller.signal, responseLimit, 'downstream response'); outgoing.end(); }
      } catch (reason) {
        const code = typeof reason?.code === 'string' ? reason.code : 'handler_failed';
        if (!wroteHead && !outgoing.headersSent && !outgoing.destroyed) {
          const status = code === 'body_too_large' ? 413 : code === 'handler_timeout' ? 504 : code === 'permission_denied' || code === 'policy_denied' || code === 'authorization_revoked' ? 403 : 502;
          outgoing.writeHead(status, { 'content-type': 'text/plain; charset=utf-8' }); outgoing.end(code);
        } else if (!outgoing.destroyed) outgoing.destroy();
      } finally {
        incoming.off('aborted', cancelled); unlinkRoot(); active.delete(controller); concurrent -= 1;
        if (!controller.signal.aborted) controller.abort(fail('request_complete', 'HTTP exchange completed'));
      }
    });
    server.requestTimeout = 30000;
    server.headersTimeout = 10000;
    server.keepAliveTimeout = 5000;
    server.maxConnections = maximumConcurrent + 8;
    server.on('connection', socket => { sockets.add(socket); socket.once('close', () => sockets.delete(socket)); });
    server.on('connect', (_request, socket) => { socket.end('HTTP/1.1 405 Method Not Allowed\r\nConnection: close\r\n\r\n'); });
    const webSocketServer = new TrafficWebSocketServer({
      noServer: true, maxPayload: maxMessageBytes, perMessageDeflate: false,
      handleProtocols(_protocols, request) { return request.__codletProtocol; },
    });
    server.on('upgrade', async (incoming, socket, head) => {
      const reject = (status, reason) => { if (!socket.destroyed) socket.end(`HTTP/1.1 ${status}\r\nConnection: close\r\nContent-Length: ${Buffer.byteLength(reason)}\r\n\r\n${reason}`); };
      let requestUrl;
      try { requestUrl = new URL(incoming.url ?? '/', 'http://127.0.0.1'); }
      catch { reject('400 Bad Request', 'invalid request target'); return; }
      if (!(requestUrl.pathname === prefix || requestUrl.pathname.startsWith(`${prefix}/`))) return reject('404 Not Found', 'not found');
      if (!webSocketHandler) return reject('426 Upgrade Required', 'WebSocket handler unavailable');
      if (closed || retired || rootSignal.aborted) return reject('503 Service Unavailable', 'channel unavailable');
      if (concurrent >= maximumConcurrent) return reject('503 Service Unavailable', 'channel busy');
      concurrent += 1; socket.pause();
      const controller = new AbortController(); active.add(controller);
      const unlinkRoot = linkAbort(controller, rootSignal, fail('host_stopping', 'Host traffic runtime retired'));
      let forwarded = false, bridge;
      try {
        await coreRequest('host.network.authorizeChannel', {}, controller.signal);
        const offered = websocketProtocols(String(incoming.headers['sec-websocket-protocol'] ?? '').split(',').map(value => value.trim()).filter(Boolean));
        const request = Object.freeze({
          id: trafficRandomUUID(), path: (requestUrl.pathname.slice(prefix.length) || '/') + requestUrl.search,
          headers: Object.freeze(rawHeaderPairs(incoming.rawHeaders).map(pair => Object.freeze(pair))),
          protocols: Object.freeze(offered),
        });
        const exchange = Object.freeze({
          signal: controller.signal,
          async forward(input) {
            if (forwarded) throw fail('forward_already_dispatched', 'a WebSocket exchange can dispatch upstream at most once');
            forwarded = true;
            bridge = await forwardWebSocket(input, request, incoming, socket, head, webSocketServer, controller.signal, { handlerTimeout, maxMessageBytes, maxQueueBytes, maxQueueFrames });
            return bridge;
          },
        });
        let timer;
        const timeout = new Promise((_, rejectTimeout) => { timer = setTimeout(() => rejectTimeout(fail('handler_timeout', `WebSocket channel handler exceeded ${handlerTimeout} ms`)), handlerTimeout); });
        try {
          await raceAbort(
            Promise.race([Promise.resolve().then(() => webSocketHandler(request, exchange)), timeout]),
            controller.signal,
            'WebSocket handler was cancelled',
          );
        }
        finally { clearTimeout(timer); }
        if (!bridge) throw fail('websocket_not_forwarded', 'WebSocket handler returned without forwarding the exchange');
        socket.resume();
        await bridge.closed;
      } catch (reason) {
        if (!forwarded || !bridge) {
          const upstreamStatus = Number.isInteger(reason?.data?.status) && reason.data.status >= 400 && reason.data.status <= 599 ? reason.data.status : null;
          const status = upstreamStatus ? `${upstreamStatus} Upstream Rejected` : reason?.code === 'policy_denied' || reason?.code === 'permission_denied' ? '403 Forbidden' : '502 Bad Gateway';
          reject(status, String(reason?.code ?? 'websocket_failed'));
        }
        else if (!socket.destroyed) socket.destroy();
      } finally {
        unlinkRoot(); active.delete(controller); concurrent -= 1;
        if (!controller.signal.aborted) controller.abort(fail('request_complete', 'WebSocket exchange completed'));
      }
    });

    await new Promise((resolve, reject) => {
      const failed = reason => reject(fail('channel_listen_failed', `loopback listener failed: ${reason?.message ?? reason}`));
      server.once('error', failed);
      server.listen(0, '127.0.0.1', () => { server.off('error', failed); resolve(); });
    });
    const address = server.address();
    if (!address || typeof address === 'string') { server.close(); throw fail('channel_listen_failed', 'loopback listener did not return a TCP port'); }
    if (retired || rootSignal.aborted) {
      for (const socket of sockets) socket.destroy();
      await new Promise(resolve => server.close(resolve));
      throw fail('host_stopping', 'Host traffic runtime retired during listener creation');
    }

    async function closeWithReason(reason) {
      if (closePromise) return closePromise;
      closed = true;
      for (const controller of active) if (!controller.signal.aborted) controller.abort(reason);
      for (const socket of sockets) socket.destroy();
      closePromise = new Promise(resolve => server.close(() => resolve({ closed: true })));
      channels.delete(channel);
      return closePromise;
    }
    function close() { return closeWithReason(fail('channel_closed', 'traffic channel was closed')); }
    const channel = Object.freeze({
      id: trafficRandomUUID(), endpoint: `http://127.0.0.1:${address.port}${prefix}`,
      protocols: Object.freeze([...(httpHandler ? ['http'] : []), ...(webSocketHandler ? ['websocket'] : [])]),
      status: () => Object.freeze({ open: !closed, activeRequests: concurrent, forwardAttempts, transport: 'loopback', coverage: 'explicit-endpoint', protocols: channel.protocols }),
      close,
    });
    channels.set(channel, closeWithReason);
    return channel;
    } finally { opening -= 1; }
  }

  function closeAll(reason = fail('host_stopping', 'Host traffic runtime retired')) {
    if (retired) return;
    retired = true;
    for (const close of [...channels.values()]) close(reason).catch(() => {});
  }
  function openHttpChannel(options, handler) { return openChannel(options, { http: handler }); }
  rootSignal.addEventListener('abort', () => closeAll(rootSignal.reason), { once: true });
  return Object.freeze({ api: Object.freeze({ openChannel, openHttpChannel }), closeAll });
}

module.exports = { createTrafficRuntime };
