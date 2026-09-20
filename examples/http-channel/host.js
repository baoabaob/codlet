'use strict';

const capability = { name: 'example.traffic.channel', api: 1, scope: 'runtime' };
const fs = require('node:fs');
const path = require('node:path');
let channel, upstream, cwd;

function target(path, protocol) {
  if (!upstream) throw Object.assign(new Error('configure an upstream before using this channel'), { code: 'upstream_unconfigured' });
  const url = new URL(upstream.replace(/\/$/, '') + path);
  if (protocol === 'websocket') url.protocol = url.protocol === 'https:' ? 'wss:' : 'ws:';
  return url.href;
}

// Authentication is an explicit plugin decision, never inherited from Desktop.
const forwardedHeaders = headers => headers.filter(([name]) => !['authorization', 'cookie', 'proxy-authorization', 'referer', 'content-length', 'sec-websocket-key', 'sec-websocket-version', 'sec-websocket-extensions', 'sec-websocket-protocol'].includes(name.toLowerCase()));

function configure(params) {
  const url = new URL(params?.origin);
  if (!['http:', 'https:'].includes(url.protocol) || url.pathname !== '/' || url.search || url.hash || url.username || url.password) throw Object.assign(new Error('origin must be an absolute HTTP(S) origin'), { code: 'invalid_argument' });
  if (typeof params.cwd !== 'string' || !path.isAbsolute(params.cwd)) throw Object.assign(new Error('cwd must name the one workspace to attach'), { code: 'invalid_argument' });
  upstream = url.origin + '/'; cwd = params.cwd;
}

module.exports = {
  async activate(context) {
    try { configure(JSON.parse(fs.readFileSync(path.join(context.root, 'settings.json'), 'utf8'))); }
    catch (error) { if (error.code !== 'ENOENT') throw error; }
    channel = await context.traffic.openChannel({}, {
      async http(request, exchange) {
        const response = await exchange.forward({ url: target(request.path, 'http'), method: request.method, headers: forwardedHeaders(request.headers), body: ['GET', 'HEAD'].includes(request.method) ? null : request.body });
        return { status: response.status, headers: response.headers, body: response.body };
      },
      async webSocket(request, exchange) {
        await exchange.forward({ url: target(request.path, 'websocket'), protocols: request.protocols, headers: forwardedHeaders(request.headers) });
      },
    });
    context.rpc.provide(capability, 'configure', (params, invocation) => {
      if (invocation.caller.pluginId !== context.plugin.id) throw new Error('This example only accepts its own renderer');
      configure(params);
      return { channel: { endpoint: channel.endpoint, protocols: channel.protocols } };
    });
    context.rpc.provide(capability, 'status', (_params, invocation) => {
      if (invocation.caller.pluginId !== context.plugin.id) throw new Error('This example only accepts its own renderer');
      return { channel: { endpoint: channel.endpoint, protocols: channel.protocols }, configured: !!upstream, cwd: cwd ?? null, ...channel.status() };
    });
  },
  async deactivate() {
    await channel?.close();
    channel = undefined;
    upstream = undefined;
    cwd = undefined;
  },
};
