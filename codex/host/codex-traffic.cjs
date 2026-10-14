'use strict';
// Official Adapter-owned protocol/launch knowledge. Core has no Codex names.
// Native owns launch attachment. The public SDK registers with the consuming
// Host context, so the Adapter cannot lend its own permissions to other plugins.
const zlib = require('node:zlib');
const failure = code => Object.assign(new Error(code), { code });
const VERIFIED_BACKENDS = Object.freeze({
  win32: Object.freeze([
    // Disposable Windows acceptance covers both signed distributions of the
    // same 0.162.0-alpha.2 PE image; admission pins each complete file separately.
    Object.freeze({ sha256: '3553cd6e7df5a093d8cb8301cd8088a57e0971aba71ddbe0e67f7f44a15cdf68', version: '0.162.0-alpha.2', evidence: 'same-pe-image-as-controlled-0.162.0-alpha.2-http-sse-ws-routing-fixture' }),
    Object.freeze({ sha256: 'd83cc3582592e307df008411f02f61a93fb93580b53dc173608a63202d97bbe4', version: '0.162.0-alpha.2', evidence: 'controlled-custom-builtin-chatgpt-http-sse-ws-two-thread-routing' }),
    // The installed and published 0.160.1 files differ only in Authenticode
    // data/checksum. Their complete remaining PE image matches the CI fixture.
    Object.freeze({ sha256: '3b8f6e33caa75f232558a3cf76ff9b87bb5ef6dbcf4996372f24e55c78b1b916', version: '0.160.1', evidence: 'same-pe-image-as-controlled-0.160.1-http-sse-ws-routing-fixture' }),
    Object.freeze({ sha256: '9e7c59c05cc1ce5677b1f94e835b2ac038ca3be14504e78d558eacdb0ea3f55d', version: '0.160.1', evidence: 'controlled-custom-builtin-chatgpt-http-sse-ws-two-thread-routing' }),
    Object.freeze({ sha256: '37762753b554982eef1c109303d1be652b6397f1479e844794353a85650199c6', version: '0.160.0', evidence: 'controlled-custom-builtin-chatgpt-http-sse-ws-two-thread-routing' }),
    Object.freeze({ sha256: '1722907aa64401bcc9b34467ef5c2af43f6aef9a5045ef04d11d19dfae4589fb', version: '0.159.0-alpha.12.1', evidence: 'controlled-functional-http-sse-ws-local-fixture' }),
    Object.freeze({ sha256: '8f0554ede25bbc5450921897c468b2e84635aa513c5017457997af0954581f49', version: '0.158.0-alpha.2.1', evidence: 'controlled-custom-provider-two-thread-http-ws-reconfiguration' }),
    Object.freeze({ sha256: 'a19f8f6c3c9dd5b71b6b1e3eb1ec55d75aafb2fdfb686d9e1f7a5f47db07d0d2', version: '0.155.0-alpha.16.3', evidence: 'controlled-custom-provider-two-thread-http-ws-reconfiguration' }),
    Object.freeze({ sha256: 'bc45017e8239dc150258f69309ced9df6bbcdf5b8e4f346decf780ac0999e226', version: '0.155.0-alpha.9.2', evidence: 'controlled-custom-provider-two-thread-http-ws' }),
    Object.freeze({ sha256: '97d4d67419d0ac2f71342f9a5e850f9468aa622618de8ea823223edb9a91926a', version: '0.155.0-alpha.16', evidence: 'controlled-custom-provider-two-thread-http-ws' }),
  ]),
  darwin: Object.freeze([
    Object.freeze({ sha256: 'c67698d0990aae05211d9c43ab343ad9517e406824dea77eca103a2806232b3a', version: '0.155.0-alpha.16.3', evidence: 'controlled-custom-provider-two-thread-http-ws' }),
  ]),
});
function probeCodexTraffic({ platform = process.platform, binarySha256 } = {}) {
  const backend = VERIFIED_BACKENDS[platform]?.find(profile => binarySha256?.toLowerCase() === profile.sha256);
  const fixtureVerified = !!backend;
  return Object.freeze({ available: false, fixtureVerified, restartRequired: true, officialOAuth: false, existingLoadedThreads: false, desktop: false, attachments: false,
    fixtureProtocols: fixtureVerified ? ['http', 'https', 'sse', 'ws', 'wss'] : [],
    reason: fixtureVerified ? 'native_process_ingress_not_attached' : 'backend_build_unverified' });
}
function threadIdFromHeaders(headers) {
  if (!Array.isArray(headers)) return null;
  const values = headers.filter(item => Array.isArray(item) && typeof item[0] === 'string' && item[0].toLowerCase() === 'x-client-request-id').map(item => item[1]);
  return values.length === 1 && typeof values[0] === 'string' && /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/iu.test(values[0]) ? values[0] : null;
}
function classifyCodexTraffic({ url, method, headers, verified = false, allowedOrigins = ['https://chatgpt.com', 'https://api.openai.com'] }) {
  let target; try { target = new URL(url); } catch { return Object.freeze({ kind: 'unknown', threadId: null, model: null }); }
  const protocol = target.protocol === 'wss:' ? 'https:' : target.protocol === 'ws:' ? 'http:' : target.protocol;
  const normalizedOrigin = `${protocol}//${target.host}`;
  const trusted = allowedOrigins.includes(normalizedOrigin) && !target.username && !target.password;
  let kind = 'unknown';
  if (trusted && /\/responses$/u.test(target.pathname) && ['POST', 'GET'].includes(method)) kind = 'model.responses';
  if (trusted && target.hostname === 'chatgpt.com' && target.pathname === '/backend-api/codex/models' && method === 'GET') kind = 'model.list';
  // The reviewed backend puts its thread id in this single header on Responses
  // HTTP requests and WS handshakes. Core redacts it without a matching
  // traffic.sensitiveHeaders grant, so absence or ambiguity yields null.
  return Object.freeze({ kind, threadId: verified && kind === 'model.responses' ? threadIdFromHeaders(headers) : null, model: null });
}
async function readCodexJsonBody(request, maximum = 8 * 1024 * 1024) {
  if (!Number.isSafeInteger(maximum) || maximum < 1 || maximum > 8 * 1024 * 1024) throw failure('invalid_body_limit');
  const chunks = []; let bytes = 0;
  for await (const chunk of request.body) { bytes += chunk.length; if (bytes > maximum) throw failure('codex_body_too_large'); chunks.push(Buffer.from(chunk)); }
  const encodings = request.headers.filter(([name]) => name.toLowerCase() === 'content-encoding').map(([, value]) => value.toLowerCase().trim());
  if (encodings.length > 1) throw failure('codex_encoding_unsupported');
  const encoding = encodings[0] ?? 'identity';
  const decoder = { gzip: zlib.gunzipSync, br: zlib.brotliDecompressSync, deflate: zlib.inflateSync, zstd: zlib.zstdDecompressSync }[encoding];
  if (encoding !== 'identity' && !decoder) throw failure('codex_encoding_unsupported');
  try { const raw = Buffer.concat(chunks); return JSON.parse(decoder ? decoder(raw, { maxOutputLength: maximum }) : raw); }
  catch { throw failure('codex_body_invalid'); }
}
function rewrittenCodexJsonBody(request, value) {
  const body = JSON.stringify(value);
  if (Buffer.byteLength(body) > 8 * 1024 * 1024) throw failure('codex_body_too_large');
  return { body, headers: request.headers.filter(([name]) => !['content-encoding', 'content-length', 'content-md5', 'content-digest', 'digest'].includes(name.toLowerCase())) };
}
function createCodexTraffic(context, compatibility = {}) {
  if (!context?.traffic?.registerInterceptor || !context.traffic.inspect || !context.signal) throw failure('core_traffic_unavailable');
  const verified = probeCodexTraffic(compatibility);
  async function probe() {
    let native;
    try { native = await context.traffic.inspect(); }
    catch (error) {
      if (!['traffic_unavailable', 'permission_denied', 'capability_unavailable', 'host_stopping', 'authorization_revoked'].includes(error.code)) throw failure('core_traffic_unavailable');
      return Object.freeze({ ...verified, listening: false, attached: false, reason: verified.fixtureVerified ? error.code : verified.reason });
    }
    const attached = native.attached === true && native.available === true
      && native.activatedSources?.some(source => source.id === 'owned-backend-provider' && source.coverage?.includes('owned-local-app-server-model-provider')) === true;
    return Object.freeze({ ...verified, available: verified.fixtureVerified && attached, listening: native.listening === true, attached,
      restartRequired: !attached, reason: !verified.fixtureVerified ? verified.reason : attached ? null : 'native_process_ingress_not_attached',
      coverage: 'registered-backend-origins', registered: native.registered, active: native.active });
  }
  async function registerInterceptor(options, handlers) {
    if (context.signal.aborted) throw failure('host_stopping');
    if (!verified.fixtureVerified) throw failure('backend_build_unverified');
    if (!options || typeof options !== 'object' || Object.keys(options).some(key => !['id', 'priority', 'timeoutMs', 'kinds', 'origins'].includes(key))) throw failure('invalid_argument');
    const kinds = options.kinds ?? ['model.responses', 'model.list'];
    if (!Array.isArray(kinds) || !kinds.length || kinds.length > 2 || new Set(kinds).size !== kinds.length || kinds.some(kind => !['model.responses', 'model.list'].includes(kind))) throw failure('invalid_argument');
    if (!handlers || typeof handlers !== 'object' || !Object.keys(handlers).length || Object.entries(handlers).some(([key, value]) => !['request', 'response', 'webSocket'].includes(key) || typeof value !== 'function')) throw failure('invalid_handler');
    const origins = options.origins ?? ['https://chatgpt.com', 'https://api.openai.com'];
    if (!Array.isArray(origins) || !origins.length || origins.length > 16 || origins.some(origin => {
      try { const url = new URL(origin); return url.origin !== origin || !['https:', 'http:'].includes(url.protocol) || url.username || url.password || url.protocol === 'http:' && !['127.0.0.1', 'localhost'].includes(url.hostname); }
      catch { return true; }
    })) throw failure('invalid_argument');
    const wrapped = {};
    const metadata = value => { const info = classifyCodexTraffic({ ...value, verified: true, allowedOrigins: origins }); return kinds.includes(info.kind) ? info : null; };
    const requestThreads = new Map();
    wrapped.request = (value, call) => {
      const codex = metadata(value);
      if (handlers.response && codex?.threadId && typeof value.id === 'string') {
        requestThreads.set(value.id, { threadId: codex.threadId, at: Date.now() });
        if (requestThreads.size > 1024) requestThreads.delete(requestThreads.keys().next().value);
      }
      return codex && handlers.request ? handlers.request(value, Object.freeze({ ...call, codex })) : undefined;
    };
    if (handlers.response) wrapped.response = (value, call) => {
      const codex = metadata(call.request), known = requestThreads.get(call.request?.id);
      if (typeof call.request?.id === 'string') requestThreads.delete(call.request.id);
      const threadId = known && Date.now() - known.at <= 10 * 60 * 1000 ? known.threadId : null;
      return codex ? handlers.response(value, Object.freeze({ ...call, codex: Object.freeze({ ...codex, threadId }) })) : undefined;
    };
    if (handlers.webSocket) wrapped.webSocket = (value, call) => {
      const codex = metadata({ ...value, method: 'GET' }); return codex ? handlers.webSocket(value, Object.freeze({ ...call, codex })) : undefined;
    };
    const { kinds: ignored, ...registration } = options;
    return context.traffic.registerInterceptor({ ...registration, origins }, wrapped);
  }
  return Object.freeze({ probe, registerInterceptor, classify: classifyCodexTraffic, readJsonBody: readCodexJsonBody, rewriteJsonBody: rewrittenCodexJsonBody });
}
module.exports = { createCodexTraffic, probeCodexTraffic, classifyCodexTraffic, threadIdFromHeaders, readCodexJsonBody, rewrittenCodexJsonBody };
