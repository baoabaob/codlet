'use strict';
// Public channel objects and plugin callbacks only. Sockets/TLS live in Core.
const { createTrafficStreams } = require('./traffic-wire.cjs');
const fail = code => Object.assign(new Error(code), { code });
const object = value => value && typeof value === 'object' && !Array.isArray(value);
function createHostedChannels({ coreRequest, rootSignal, getPeer, reportState = () => {}, detach = fn => fn() }) {
  const channels = new Map(), exchanges = new Map();
  let retired = false;
  const check = () => { if (retired || rootSignal.aborted) throw fail('host_stopping'); };
  const changed = () => { try { Promise.resolve(reportState([...channels.values()].map(channel => channel.api.status()))).catch(() => {}); } catch {} };
  function retireExchange(id, code = 'closed') {
    const exchange = exchanges.get(id); if (!exchange) return;
    exchanges.delete(id); exchange.controller.abort(fail('stream_retired')); exchange.streams.dispose();
    exchange.resolveClosed({ code }); exchange.channel.active.delete(id); changed();
  }
  function event(message) {
    if (message.event === 'leaseClosed') retireExchange(message.lease);
    else if (message.event === 'channelExchangeClosed') {
      for (const [id, exchange] of exchanges) if (exchange.requestId === message.exchange) retireExchange(id, message.code);
    } else if (message.event === 'channelState') {
      const channel = channels.get(message.channel);
      if (channel) { channel.forwardAttempts = message.forwardAttempts; channel.activeRequests = message.activeRequests; changed(); }
    } else if (message.event === 'closed') {
      for (const id of [...exchanges.keys()]) retireExchange(id);
      for (const channel of channels.values()) channel.closed = true;
      channels.clear(); changed();
    } else if (message.event === 'channelClosed') {
      const channel = channels.get(message.channel);
      if (channel) { channel.closed = true; channels.delete(channel.id); for (const id of [...channel.active]) retireExchange(id); changed(); }
    }
  }
  function onceResponse(body, completed) {
    let finished = false;
    const finish = (release) => { if (!finished) { finished = true; completed(release); } };
    if (body == null) { finish(); return body; }
    return Object.freeze({
      cancel() { const result = body.cancel(); finish(body.cancelAndWait?.()); return result; },
      async cancelAndWait() { await body.cancelAndWait?.(); finish(); },
      [Symbol.asyncIterator]() {
        const iterator = body[Symbol.asyncIterator]();
        return { async next() { try { const value = await iterator.next(); if (value.done) finish(); return value; } catch (error) { finish(); throw error; } },
          async return() { try { return await iterator.return?.() ?? { done: true }; } finally { finish(); } } };
      },
    });
  }
  async function handle(method, params, peer) {
    const kind = params?.payload?.kind;
    if (method === 'invoke' && !String(kind).startsWith('channel.')) return { handled: false };
    let exchange = exchanges.get(params?.lease);
    if (method === 'invoke' && ['channel.http','channel.webSocket'].includes(kind)) {
      check(); const channel = channels.get(params.registration);
      if (!channel || channel.closed || exchange) throw fail('channel_closed');
      const controller = new AbortController();
      let resolveClosed; const closed = new Promise(resolve => { resolveClosed = resolve; });
      exchange = { channel, controller, resolveClosed, closed, peer, requestId: params.payload.value.id,
        streams: createTrafficStreams(peer, params.lease, controller.signal), transforms: {}, attempts: 0, pending: false, forwarded: false };
      exchanges.set(params.lease, exchange); channel.active.add(params.lease);
    }
    if (!exchange) return { handled: false };
    const signal = exchange.controller.signal;
    if (signal.aborted) throw fail('stream_retired');
    if (method !== 'invoke') return { handled: true, result: await exchange.streams.handle(method, params.payload) };
    if (kind === 'channel.frame') {
      const { direction, value } = params.payload;
      if (!['clientToServer','serverToClient'].includes(direction)) throw fail('invalid_frame');
      const frame = await exchange.streams.importFrame(value);
      const transformed = exchange.transforms[direction] ? await exchange.transforms[direction](frame, Object.freeze({ signal, direction })) : frame;
      if (signal.aborted) throw fail('stream_retired');
      return { handled: true, result: exchange.streams.exportFrame(transformed) };
    }
    const value = params.payload.value, webSocket = kind === 'channel.webSocket';
    const request = Object.freeze({ ...value, headers: Object.freeze((value.headers ?? []).map(pair => Object.freeze([...pair]))),
      ...(webSocket ? { protocols: Object.freeze(value.protocols ?? []) } : { body: exchange.streams.importBody(value.body) }) });
    const api = Object.freeze({ signal,
      cancel() { if (!signal.aborted) { exchange.controller.abort(fail('request_cancelled')); peer.request('channel.cancel', { lease: params.lease }).catch(() => {}); } },
      get forwardAttempts() { return exchange.attempts; }, maxForwardAttempts: params.payload.context.maxForwardAttempts,
      async forward(input) {
        check(); if (signal.aborted) throw fail('request_cancelled');
        if (!object(input)) throw fail('invalid_argument');
        if (exchange.pending) throw fail('forward_response_pending');
        if (exchange.releasing) { await exchange.releasing; exchange.releasing = null; }
        if (signal.aborted) throw fail('request_cancelled');
        if (webSocket && exchange.forwarded) throw fail('forward_already_dispatched');
        if (exchange.attempts >= params.payload.context.maxForwardAttempts) throw fail('forward_attempt_limit');
        const output = { ...input };
        if (webSocket) {
          output.protocols = input.protocols ?? [];
          for (const direction of ['clientToServer','serverToClient']) {
            if (input[direction] != null && typeof input[direction] !== 'function') throw fail('invalid_handler');
            exchange.transforms[direction] = input[direction]; delete output[direction];
          }
          output.transforms = { clientToServer: !!input.clientToServer, serverToClient: !!input.serverToClient };
        } else if (Object.hasOwn(input,'body')) output.body = exchange.streams.exportBody(input.body);
        exchange.attempts++; exchange.pending = true; exchange.forwarded ||= webSocket;
        try {
          const result = await peer.request('channel.forward', { lease: params.lease, webSocket, request: output }, { signal, timeoutMs: exchange.channel.timeout });
          if (webSocket) { exchange.pending = false; return Object.freeze({ protocol: result.protocol, closed: exchange.closed }); }
          return Object.freeze({ status: result.status, headers: Object.freeze(result.headers.map(pair => Object.freeze(pair))),
            body: onceResponse(exchange.streams.importBody(result.body), release => { exchange.releasing = release; exchange.pending = false; }) });
        } catch (error) { exchange.pending = false; throw error.code === 'request_timeout' ? fail('handler_timeout') : error; }
      },
    });
    const response = await exchange.channel.handlers[webSocket ? 'webSocket' : 'http'](request, api);
    if (signal.aborted) throw fail('stream_retired');
    if (webSocket) return { handled: true, result: null };
    if (!object(response)) throw fail('invalid_response');
    return { handled: true, result: { ...response, ...(Object.hasOwn(response,'body') ? { body: exchange.streams.exportBody(response.body) } : {}) } };
  }
  async function openChannel(options = {}, handlers) {
    check();
    if (!object(options) || !object(handlers) || Object.keys(handlers).some(name => !['http','webSocket'].includes(name) || typeof handlers[name] !== 'function') || !Object.keys(handlers).length) throw fail('invalid_handler');
    await getPeer();
    const value = await coreRequest('services.traffic.openChannel', { options, handlers: Object.keys(handlers) }, rootSignal);
    const channel = { id: value.id, handlers: { ...handlers }, timeout: options.handlerTimeoutMs ?? 15000,
      active: new Set(), activeRequests: 0, forwardAttempts: 0, closed: false, closing: null, api: null };
    const close = () => {
      if (channel.closing) return channel.closing;
      if (channel.closed) return Promise.resolve({ closed: true });
      channel.closed = true;
      for (const id of [...channel.active]) retireExchange(id);
      channels.delete(channel.id); changed();
      channel.closing = coreRequest('services.traffic.closeChannel', { channel: channel.id }, rootSignal);
      return channel.closing;
    };
    channel.api = Object.freeze({ id: value.id, endpoint: value.endpoint, protocols: Object.freeze(value.protocols), close,
      status: () => Object.freeze({ open: !channel.closed, activeRequests: channel.closed ? 0 : Math.max(channel.activeRequests,channel.active.size), forwardAttempts: channel.forwardAttempts,
        transport: 'loopback', coverage: 'explicit-endpoint', protocols: value.protocols }) });
    channels.set(channel.id,channel); changed();
    if (retired || rootSignal.aborted) { await close().catch(() => {}); throw fail('host_stopping'); }
    return channel.api;
  }
  function closeAll() { if (retired) return; retired = true; event({ event: 'closed' }); }
  return { openChannel: (options, handlers) => detach(() => openChannel(options,handlers)),
    matches: (method, params) => method === 'invoke' ? String(params?.payload?.kind).startsWith('channel.') : exchanges.has(params?.lease),
    handle, event, closeAll };
}
module.exports = { createHostedChannels };
