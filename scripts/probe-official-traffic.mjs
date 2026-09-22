// Controlled compatibility probe. Never loads user credentials or starts Desktop.
import assert from 'node:assert/strict';
import { spawn } from 'node:child_process';
import { createHash } from 'node:crypto';
import fs from 'node:fs/promises';
import http from 'node:http';
import tls from 'node:tls';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { createRequire } from 'node:module';
const require = createRequire(import.meta.url);
const { WebSocketServer } = require('../frontend/node_modules/ws');
const cli = process.argv[2];
const useCore = process.argv.includes('--core');
const adapterIndex = process.argv.indexOf('--adapter');
const adapter = adapterIndex < 0 ? null : require(process.argv[adapterIndex + 1]);
const core = require('../runtime/host-traffic-bundle.cjs');
if (!cli || !path.isAbsolute(cli)) throw new Error('Pass an absolute official CLI path');
const base = fileURLToPath(new URL('../.codlet-artifacts/transparent-traffic/', import.meta.url));
await fs.mkdir(base, { recursive: true });
const run = await fs.mkdtemp(path.join(base, 'probe-'));
const cert = fileURLToPath(new URL('../tests/fixtures/process-traffic/cert.pem', import.meta.url));
const key = fileURLToPath(new URL('../tests/fixtures/process-traffic/key.pem', import.meta.url));
const completed = { type: 'response.completed', response: { id: 'resp_probe', status: 'completed', output: [], usage: { input_tokens: 1, output_tokens: 0, total_tokens: 1 } } };
const results = [];
for (const scenario of [
  { name: 'http-default', secure: false, feature: null },
  { name: 'http-enabled', secure: false, feature: true },
  { name: 'https-untrusted', secure: true, feature: null, trusted: false },
  { name: 'https-trusted', secure: true, feature: null, trusted: true },
  { name: 'wss-trusted', secure: true, feature: null, trusted: true, websocket: true },
  { name: 'builtin-api-key-fixture', secure: true, feature: null, trusted: true, builtin: 'api' },
  { name: 'builtin-chatgpt-fixture', secure: true, feature: null, trusted: true, builtin: 'chatgpt' },
]) {
  if (process.env.CODLET_PROBE_SCENARIO && process.env.CODLET_PROBE_SCENARIO !== scenario.name) continue;
  if (useCore && scenario.feature === true) continue; // Known policy mismatch, rejected by the Adapter.
  const directory = path.join(run, scenario.name);
  await fs.mkdir(directory);
  if (scenario.builtin === 'api') await fs.writeFile(path.join(directory, 'auth.json'), JSON.stringify({ auth_mode: 'apikey', OPENAI_API_KEY: 'sk-codlet-fixture-not-a-real-key' }));
  if (scenario.builtin === 'chatgpt') {
    const jwt = [JSON.stringify({ alg: 'RS256', typ: 'JWT' }), JSON.stringify({ sub: 'codlet-fixture', exp: 2100000000, email: 'fixture@example.invalid', 'https://api.openai.com/auth': { chatgpt_account_id: 'codlet-fixture-account', chatgpt_plan_type: 'plus' } }), 'fixture-signature'].map(value => Buffer.from(value).toString('base64url')).join('.');
    await fs.writeFile(path.join(directory, 'auth.json'), JSON.stringify({ auth_mode: 'chatgpt', OPENAI_API_KEY: null, tokens: { id_token: jwt, access_token: jwt, refresh_token: 'fixture-not-a-real-refresh-token', account_id: 'codlet-fixture-account' }, last_refresh: new Date().toISOString() }));
  }
  const sockets = new Set();
  const observed = { connect: 0, fixtureConnect: 0, http: 0, websocket: 0, modelList: 0, otherRequests: 0, bytes: 0, originalDestination: true, authenticationHeaderPresent: false, providerOverridden: !scenario.builtin, tlsErrors: 0 };
  const target = scenario.builtin === 'api' ? 'api.openai.com' : scenario.builtin === 'chatgpt' ? 'chatgpt.com' : 'codlet-probe.invalid';
  const respond = async (req, res) => {
    if (req.url.includes('/models')) { observed.modelList++; res.writeHead(200, { 'content-type': 'application/json' }); res.end('{"models":[]}'); return; }
    if (!new URL(req.url, 'http://fixture.invalid').pathname.endsWith('/responses')) { observed.otherRequests++; res.writeHead(404); res.end(); return; }
    observed.http++;
    observed.originalDestination &&= useCore || req.headers.host === target;
    for await (const chunk of req) observed.bytes += chunk.length;
    res.writeHead(200, { 'content-type': 'text/event-stream', connection: 'close' });
    res.end(`data: ${JSON.stringify(completed)}\n\n`);
  };
  const parser = http.createServer(respond);
  const ws = new WebSocketServer({ noServer: true });
  parser.on('upgrade', (req, socket, head) => {
    observed.websocket++;
    observed.originalDestination &&= useCore || req.headers.host === target;
    ws.handleUpgrade(req, socket, head, connection => connection.on('message', data => {
      observed.bytes += data.length;
      connection.send(JSON.stringify(completed));
    }));
  });
  const secure = tls.createServer({ cert: await fs.readFile(cert), key: await fs.readFile(key), ALPNProtocols: ['http/1.1'] }, socket => parser.emit('connection', socket));
  secure.on('tlsClientError', () => observed.tlsErrors++);
  const proxy = http.createServer(respond);
  proxy.on('connection', socket => { sockets.add(socket); socket.on('error', () => {}); socket.once('close', () => sockets.delete(socket)); });
  proxy.on('connect', (req, socket, head) => {
    observed.connect++;
    if (req.url !== `${target}:443`) { socket.end('HTTP/1.1 403 Forbidden\r\n\r\n'); return; }
    observed.fixtureConnect++;
    socket.write('HTTP/1.1 200 Connection Established\r\n\r\n');
    if (head.length) socket.unshift(head);
    secure.emit('connection', socket);
    socket.resume();
  });
  await new Promise(resolve => proxy.listen(0, '127.0.0.1', resolve));
  let proxyUrl = `http://127.0.0.1:${proxy.address().port}`;
  let managed, interceptors, ingress, prepared;
  const lifetime = new AbortController();
  if (useCore) {
    await new Promise(resolve => parser.listen(0, '127.0.0.1', resolve));
    const localWs = `ws://127.0.0.1:${parser.address().port}/v1/responses`;
    managed = core.createTrafficRuntime({ rootSignal: lifetime.signal, makeError: (code, message) => Object.assign(new Error(message), { code }),
      async coreRequest(method, value) {
        if (method === 'host.network.authorizeChannel') return {};
        if (method === 'host.network.authorizeForward' && value.url === localWs) return { url: localWs };
        if (method === 'services.network.resolve') return { proxyUrl: null }; // Explicit local fixture route.
        throw new Error('fixture_policy_denied');
      } });
    interceptors = core.createTrafficInterceptors({ rootSignal: lifetime.signal, networkProfile: 'fixture-direct', authorize: async () => true });
    const origins = [`http://${target}`, `https://${target}`];
    interceptors.register({ pluginId: 'fixture', generation: 1, signal: lifetime.signal }, { id: 'model', origins: [...origins, `http://127.0.0.1:${parser.address().port}`] }, {
      async request(request) {
        if (new URL(request.url).pathname.endsWith('/models')) { observed.modelList++; return { respond: { status: 200, headers: [['content-type', 'application/json']], body: '{"models":[]}' } }; }
        if (!new URL(request.url).pathname.endsWith('/responses')) { observed.otherRequests++; return { respond: { status: 404 } }; }
        observed.http++; observed.originalDestination &&= new URL(request.url).hostname === target;
        observed.authenticationHeaderPresent ||= request.headers.some(([name]) => name.toLowerCase() === 'authorization');
        for await (const chunk of request.body) observed.bytes += chunk.length;
        return { respond: { status: 200, headers: [['content-type', 'text/event-stream']], body: `data: ${JSON.stringify(completed)}\n\n` } };
      },
      webSocket(request) {
        observed.originalDestination &&= new URL(request.url).hostname === target;
        observed.authenticationHeaderPresent ||= request.headers.some(([name]) => name.toLowerCase() === 'authorization');
        return { request: { url: localWs }, clientToServer: frame => frame, serverToClient: frame => frame };
      },
    });
    ingress = await managed.openProcessIngress({}, interceptors.handlers, { origins, certificateFor: async () => { observed.fixtureConnect++; return { cert: await fs.readFile(cert), key: await fs.readFile(key) }; } });
    proxyUrl = ingress.proxyUrl;
  }
  // Only this child receives these variables; no global proxy or trust changes.
  const env = Object.fromEntries(Object.entries(process.env).filter(([name]) => /^(PATH|SYSTEMROOT|WINDIR|COMSPEC|PATHEXT|TEMP|TMP)$/i.test(name)));
  Object.assign(env, { CODEX_HOME: directory, HOME: directory, USERPROFILE: directory, NO_PROXY: '', no_proxy: '' });
  if (!useCore || !scenario.trusted) Object.assign(env, { HTTP_PROXY: proxyUrl, HTTPS_PROXY: proxyUrl, ALL_PROXY: proxyUrl, http_proxy: proxyUrl, https_proxy: proxyUrl, all_proxy: proxyUrl });
  if (scenario.trusted) env.CODEX_CA_CERTIFICATE = fileURLToPath(new URL('../tests/fixtures/process-traffic/ca.pem', import.meta.url));
  if (useCore && scenario.trusted) {
    const configuration = { core, executable: cli, platform: process.platform, environment: env, directory, proxyUrl, additionalCaPem: await fs.readFile(new URL('../tests/fixtures/process-traffic/ca.pem', import.meta.url), 'utf8') };
    prepared = adapter ? await adapter.prepareCodexBackendTraffic(configuration) : await core.prepareProcessTrafficEnvironment({ ...configuration, trustOutputs: ['CODEX_CA_CERTIFICATE'] });
    Object.assign(env, prepared.environment);
  }
  const settings = [
    'model="gpt-5.4"', 'cli_auth_credentials_store="file"',
    ...(scenario.builtin ? [] : ['model_provider="fixture"', `model_providers.fixture={name="fixture",base_url="${scenario.secure ? 'https' : 'http'}://codlet-probe.invalid/v1",wire_api="responses",requires_openai_auth=false,supports_websockets=${!!scenario.websocket},request_max_retries=0,stream_max_retries=0,stream_idle_timeout_ms=2500}`]),
    'check_for_update_on_startup=false', 'analytics.enabled=false',
    ...(scenario.feature === null ? [] : [`features.respect_system_proxy=${scenario.feature}`]),
  ];
  const child = spawn(cli, ['exec', '--skip-git-repo-check', '--ephemeral', '--ignore-user-config', '--ignore-rules', '--sandbox', 'read-only', '--json', ...settings.flatMap(value => ['-c', value]), 'Reply with no tool calls.'], { cwd: directory, env, windowsHide: true, stdio: ['ignore', 'pipe', 'pipe'] });
  let outputBytes = 0, timedOut = false, errorEvents = 0, diagnostic = '';
  child.stdout.on('data', chunk => { outputBytes += chunk.length; if (chunk.includes('"type":"error"')) errorEvents++; if (process.env.CODLET_PROBE_DEBUG) diagnostic = (diagnostic + chunk).slice(-6000); });
  child.stderr.on('data', chunk => { if (process.env.CODLET_PROBE_DEBUG) diagnostic = (diagnostic + chunk).slice(-6000); });
  const timer = setTimeout(() => { timedOut = true; child.kill(); }, scenario.name === 'https-untrusted' ? 5000 : 15000);
  const exit = await new Promise((resolve, reject) => { child.once('exit', resolve); child.once('error', reject); });
  clearTimeout(timer);
  lifetime.abort();
  if (ingress) await ingress.close();
  await prepared?.close();
  for (const socket of sockets) socket.destroy();
  for (const connection of ws.clients) connection.terminate();
  await new Promise(resolve => proxy.close(resolve));
  ws.close();
  parser.close();
  results.push({ scenario: scenario.name, ...observed, exit, timedOut, errorEvents, outputBytes });
  console.log(JSON.stringify(results.at(-1)));
  // Opt-in fixture-only debugging; this child has no real credentials or user input.
  if (process.env.CODLET_PROBE_DEBUG) console.log(diagnostic);
}
const report = { schema: 1, date: new Date().toISOString(), mode: useCore ? 'core-ingress' : 'independent-proxy', adapter: !!adapter, binarySha256: createHash('sha256').update(await fs.readFile(cli)).digest('hex'), coverage: 'official-binary-controlled-fixtures-no-real-oauth', results };
await fs.writeFile(path.join(run, 'report.json'), JSON.stringify(report, null, 2) + '\n');
assert(results.filter(result => ['http-default', 'https-trusted', 'wss-trusted', 'builtin-api-key-fixture', 'builtin-chatgpt-fixture'].includes(result.scenario)).every(result => result.exit === 0 && !result.timedOut && result.originalDestination), 'A positive probe failed; coverage is unknown');
assert(results.filter(result => result.scenario === 'wss-trusted').every(result => result.websocket > 0 && result.http === 0), 'WSS fell back to HTTP; not a WSS pass');
assert(results.filter(result => result.scenario === 'https-untrusted').every(result => result.fixtureConnect > 0 && result.http === 0 && result.websocket === 0), 'Untrusted certificate unexpectedly reached application traffic');
