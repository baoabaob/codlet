import assert from 'node:assert/strict';
import { spawn } from 'node:child_process';
import { createInterface } from 'node:readline';
import { once } from 'node:events';
import { fileURLToPath } from 'node:url';
import path from 'node:path';
import { createRequire } from 'node:module';
const require = createRequire(import.meta.url);
const { createTrafficRuntime } = require('../../runtime/host-traffic.cjs');
const { connectPlaintextSource } = require('../../runtime/plaintext-source-client-bundle.cjs');
const base = fileURLToPath(new URL('../..', import.meta.url));
const error = code => Object.assign(new Error(code), { code });

export async function nativeTraffic(t, options = {}) {
  const executable = process.env.CODLET_TRAFFIC_FIXTURE ?? path.join(process.env.CARGO_TARGET_DIR ?? path.join(base,'target'), 'debug', 'codlet-traffic-fixture' + (process.platform === 'win32' ? '.exe' : ''));
  const child = spawn(executable, [], { windowsHide: true, stdio: ['pipe','pipe','pipe'], env: { ...process.env, NO_PROXY: '*', no_proxy: '*', ...options.environment } });
  const pending = new Map(); let next = 0, resolveReady, rejectReady, stderr = '', closed = false;
  const ready = new Promise((resolve,reject) => { resolveReady=resolve; rejectReady=reject; });
  const lines = createInterface({ input: child.stdout });
  child.stderr.on('data', data => { stderr = (stderr + data).slice(-4000); });
  child.once('error', e => rejectReady(e));
  child.once('exit', () => { rejectReady(error('fixture_exited')); for (const call of pending.values()) { clearTimeout(call.timer); call.reject(error('fixture_exited')); } pending.clear(); });
  lines.on('line', text => {
    const value = JSON.parse(text);
    if (value.ready) { resolveReady(value); return; }
    const call = pending.get(value.id); if (!call) return;
    pending.delete(value.id); clearTimeout(call.timer);
    if (value.error) call.reject(error(value.error.code)); else call.resolve(value.result);
  });
  const roots = new Set(), runtimes = new Map(); let source;
  async function close() {
    if (closed) return; closed = true;
    source?.close(); for (const root of roots) root.abort();
    for (const runtime of runtimes.values()) runtime.closeAll();
    if (child.pid && child.exitCode === null) {
      const ended = once(child,'exit');
      child.stdin.end(JSON.stringify({ method:'quit' })+'\n');
      const timer = setTimeout(() => child.kill(), 5000);
      await ended; clearTimeout(timer);
    }
    lines.close();
  }
  t?.after(close);
  child.stdin.write(JSON.stringify({origins:options.origins ?? [],sensitive:options.sensitive,noIntercept:options.noIntercept,engine:options.engine})+'\n');
  let timer;
  let boot;
  try { boot = await Promise.race([ready,new Promise((_,reject)=>{timer=setTimeout(()=>reject(error('fixture_start_timeout')),15000);})]); }
  catch (reason) { await close(); throw new Error(`${reason.code ?? reason.message}: ${stderr}`); }
  finally { clearTimeout(timer); }
  function call(method, params = {}, owner = 'test.native-a') {
    if (closed) return Promise.reject(error('fixture_closed'));
    const id = ++next;
    return new Promise((resolve,reject) => {
      const timer=setTimeout(()=>{pending.delete(id);reject(error('fixture_request_timeout'));},15000);
      pending.set(id,{resolve,reject,timer});child.stdin.write(JSON.stringify({id,method,params,owner})+'\n');
    });
  }
  function runtime(owner='test.native-a') {
    if (runtimes.has(owner)) return runtimes.get(owner);
    const root = new AbortController(); roots.add(root);
    const value = createTrafficRuntime({ rootSignal: root.signal, makeError: error, coreRequest: (method,params) => call(method,params,owner) });
    runtimes.set(owner,value); return value;
  }
  function client() { source ??= connectPlaintextSource(boot.source); return source; }
  return { call, runtime, client, close, pid:child.pid, descriptor:boot.source, gateway:boot.gateway, stderr:()=>stderr };
}

export async function bodyBytes(body) { const chunks=[];for await(const chunk of body??[])chunks.push(Buffer.from(chunk));return Buffer.concat(chunks); }
export async function listen(server,t) {
  const sockets = new Set(); server.on('connection',socket=>{sockets.add(socket);socket.once('close',()=>sockets.delete(socket));});
  await new Promise(resolve=>server.listen(0,'127.0.0.1',resolve));
  t.after(()=>{for(const socket of sockets)socket.destroy();server.close();});
  return `http://127.0.0.1:${server.address().port}`;
}
export async function read(url,options={}) {
  const response = await fetch(url, options);return {status:response.status,headers:response.headers,body:Buffer.from(await response.arrayBuffer())};
}
export async function idle(fixture) {
  let state;
  for(let i=0;i<100;i++){state=await fixture.call('resources');if(state.leases===0&&state.pending===0)return state;await new Promise(resolve=>setTimeout(resolve,10));}
  assert.equal(state.leases,0);assert.equal(state.pending,0);return state;
}
