'use strict';
const fs = require('node:fs');
const path = require('node:path');
const { randomBytes } = require('node:crypto');
const net = require('node:net');
const fail = code => Object.assign(new Error(code), { code });
function consumeOwnedStartupInspector(process, electron) {
  // This one argument belongs to the Adapter's startup transaction. Leaving
  // it in Native's defaults can pause later worker/fork children after our
  // inspector has closed. Keep every unrelated native/user argument intact.
  const flag = '--inspect-brk=127.0.0.1:0';
  const app=electron.app;
  const index = process.execArgv.indexOf(flag);
  const owned=index!==-1||app.commandLine?.getSwitchValue('inspect-brk')==='127.0.0.1:0';
  if (index !== -1) process.execArgv.splice(index, 1);
  if (app.commandLine?.getSwitchValue('inspect-brk') === '127.0.0.1:0') app.commandLine.removeSwitch('inspect-brk');
  if(!owned)return;
  // Worker/utility defaults can retain the startup C++ argv even after the JS
  // array changes. Supply Native's filtered defaults only when it omitted them.
  const threads=require('node:worker_threads'),Worker=threads.Worker;
  let wrapper;
  wrapper=new Proxy(Worker,{construct(target,args,newTarget){
    const options=args[1];
    if((options===undefined||options&&typeof options==='object')&&options?.execArgv===undefined)args=[args[0],{...options,execArgv:[...process.execArgv]}];
    return Reflect.construct(target,args,newTarget===wrapper?target:newTarget);
  }});
  threads.Worker=wrapper;
  if(electron.utilityProcess?.fork){const fork=electron.utilityProcess.fork;electron.utilityProcess.fork=function(modulePath,args,options){
    if(options===undefined||options&&typeof options==='object'&&options.execArgv===undefined)options={...options,execArgv:[...process.execArgv]};
    return fork.call(this,modulePath,args,options);
  };}
}
function sameExecutable(expected, observed) {
  if (typeof observed !== 'string' || !path.isAbsolute(observed)) return false;
  try {
    const left = fs.statSync(expected, { bigint: true }), right = fs.statSync(observed, { bigint: true });
    // Windows realpath can preserve a verbatim prefix in just one process.
    // Compare actual file identity, never strip prefixes without validation.
    return left.isFile() && right.isFile() && left.ino !== 0n && left.dev === right.dev && left.ino === right.ino;
  } catch { return false; }
}

async function confirmInspectorClosed(url, deadline) {
  while (Date.now() < deadline) {
    const closed = await new Promise(resolve => {
      const peer = net.createConnection({ host: url.hostname, port: Number(url.port) });
      const finish = value => { peer.destroy(); resolve(value); };
      peer.once('connect', () => finish(false));
      peer.once('error', error => finish(error.code === 'ECONNREFUSED'));
      peer.setTimeout(Math.min(100, Math.max(1, deadline - Date.now())), () => finish(false));
    });
    if (closed) return;
    await new Promise(resolve => setTimeout(resolve, 25));
  }
  throw fail('main_bootstrap_detach_failed');
}
function diagnosticSnapshot(value) {
  if (!value || typeof value !== 'object') return null;
  const code = value => typeof value === 'string' && /^[a-z_]{1,80}$/u.test(value) ? value : null;
  return { installed: value.installed === true,
    source: value.source && { connected: value.source.connected === true, reason: code(value.source.reason) },
    desktop: value.desktop && { available: value.desktop.available === true, taskConfigurationAvailable: value.desktop.taskConfigurationAvailable === true,
      taskConfigurationReason: code(value.desktop.taskConfigurationReason),
      modules: Object.fromEntries(['bootstrap', 'main', 'src', 'stdio', 'connection'].map(name => [name, value.desktop.modules?.[name] === true])),
      mismatch: /^[A-Za-z0-9_.-]{1,100}$/u.test(value.desktop.mismatch?.name) && /^[a-f0-9]{64}$/u.test(value.desktop.mismatch?.observedSha256)
        ? { name: value.desktop.mismatch.name, observedSha256: value.desktop.mismatch.observedSha256 } : null,
      reason: code(value.desktop.reason) },
    backend: value.backend && { available: value.backend.available === true, reason: code(value.backend.reason) } };
}

// Native starts ONE owned client with --inspect-brk=127.0.0.1:0 and supplies
// the private debugger URL read from that exact child's stderr. No port scan,
// existing client lookup, saved debugger URL or renderer CDP is accepted.
async function attachElectronTrafficBeforeEntry({ inspectorUrl, expectedPid, executable, configuration, signal, mainSource, WebSocketClass = WebSocket, verifyClosed = confirmInspectorClosed }) {
  const url = new URL(inspectorUrl);
  if (url.protocol !== 'ws:' || url.hostname !== '127.0.0.1' || !url.port || url.username || url.password || url.search || url.hash || !/^\/[a-f0-9-]{36}$/u.test(url.pathname)
    || !Number.isSafeInteger(expectedPid) || expectedPid < 1 || !path.isAbsolute(executable)) throw fail('invalid_main_bootstrap');
  if (signal?.aborted) throw fail('main_bootstrap_cancelled');
  const deadlineUnixMs = Date.now() + 10000;
  const canonical = fs.realpathSync(executable), token = randomBytes(24).toString('hex');
  if (typeof mainSource !== 'string' || !mainSource) throw fail('launch_bundle_required');
  const source = mainSource;
  const socket = new WebSocketClass(url.href), pending = new Map(); let sequence = 0, paused, pauseResolve, pauseReject, stage = 'connect';
  const pauseReasons = [], timings = [];
  const pause = new Promise((resolve, reject) => { pauseResolve = resolve; pauseReject = reject; });
  pause.catch(() => {});
  const stop = () => {
    const error = fail('main_bootstrap_cancelled');
    for (const item of pending.values()) { clearTimeout(item.timer); item.reject(error); }
    pending.clear(); pauseReject(error); socket.close();
  };
  signal?.addEventListener('abort', stop, { once: true });
  socket.addEventListener('message', event => {
    let message; try { message = JSON.parse(event.data); } catch { stop(); return; }
    if (message.method === 'Debugger.paused') { paused = message.params; pauseReasons.push(typeof paused?.reason === 'string' ? paused.reason.slice(0, 80) : 'unknown'); if (pauseReasons.length > 16) pauseReasons.shift(); pauseResolve(paused); }
    const call = pending.get(message.id); if (!call) return;
    pending.delete(message.id); clearTimeout(call.timer);
    timings.push({ method: call.method, ms: Date.now() - call.started });
    if (timings.length > 24) timings.shift();
    message.error ? call.reject(fail('main_bootstrap_protocol_failed')) : call.resolve(message.result);
  });
  socket.addEventListener('close', stop, { once: true }); socket.addEventListener('error', stop, { once: true });
  const timer = setTimeout(stop, Math.max(1, deadlineUnixMs - Date.now()));
  function request(method, params = {}) {
    return new Promise((resolve, reject) => {
      if (signal?.aborted) { reject(fail('main_bootstrap_cancelled')); return; }
      const remaining = deadlineUnixMs - Date.now();
      if (remaining <= 0 || socket.readyState !== 1) { reject(fail('main_bootstrap_timeout')); return; }
      const id = ++sequence;
      pending.set(id, { resolve, reject, method, started: Date.now(), timer: setTimeout(() => { pending.delete(id); reject(Object.assign(fail('main_bootstrap_timeout'), { details: { stage, method } })); }, stage === 'ready' ? remaining : Math.min(5000, remaining)) });
      socket.send(JSON.stringify({ id, method, params }));
    });
  }
  let activation;
  try {
    await new Promise((resolve, reject) => { socket.addEventListener('open', resolve, { once: true }); socket.addEventListener('error', () => reject(fail('main_bootstrap_connect_failed')), { once: true }); socket.addEventListener('close', () => reject(fail('main_bootstrap_connect_failed')), { once: true }); });
    stage = 'pause'; await request('Debugger.enable'); await request('Runtime.runIfWaitingForDebugger');
    const frame = (await pause)?.callFrames?.[0]; if (!frame) throw fail('main_bootstrap_not_paused');
    // Bind before injecting the private source descriptor. A stale or wrong
    // debugger peer never receives its bearer token.
    stage = 'identity';
    const identity = await request('Debugger.evaluateOnCallFrame', { callFrameId: frame.callFrameId, expression: `({pid:process.pid,executable:require('node:fs').realpathSync(process.execPath),type:process.type,ready:require('electron').app.isReady(),electronVersion:process.versions.electron,chromeVersion:process.versions.chrome,nodeVersion:process.versions.node})`, returnByValue: true });
    const value = identity.result?.value;
    if (identity.exceptionDetails || value?.pid !== expectedPid || !sameExecutable(canonical, value?.executable) || value?.type !== 'browser' || value?.ready !== false) throw fail('main_bootstrap_identity_mismatch');
    const expression = `(() => { const electron=require('electron'); (${consumeOwnedStartupInspector.toString()})(process,electron); const module={exports:{}}; ((module,exports,require)=>{${source}\n})(module,module.exports,require); const owned=module.exports.installElectronTraffic(electron,${JSON.stringify({ ...configuration, deadlineUnixMs })}); const key=Symbol.for(${JSON.stringify(`codlet.private.main-traffic.${token}`)}); Object.defineProperty(globalThis,key,{value:{ready:()=>owned.ready(),inspect:()=>owned.inspect(),closeInspector:()=>{setImmediate(()=>require('node:inspector').close());return true}},configurable:true}); return {installed:true,pid:process.pid}; })()`;
    stage = 'install';
    const installed = await request('Debugger.evaluateOnCallFrame', { callFrameId: frame.callFrameId, expression, returnByValue: true });
    if (installed.exceptionDetails || installed.result?.value?.installed !== true || installed.result.value.pid !== expectedPid) throw fail('main_bootstrap_install_failed');
    stage = 'resume'; await request('Debugger.resume');
    stage = 'ready';
    let ready, lastOwned = null, polls = 0;
    try {
      const resultKey = JSON.stringify(`codlet.private.main-traffic-result.${token}`);
      await request('Runtime.evaluate', { expression: `(() => { const key=Symbol.for(${resultKey}); globalThis[key]={pending:true}; globalThis[Symbol.for(${JSON.stringify(`codlet.private.main-traffic.${token}`)})].ready().then(value=>{globalThis[key]={value}},error=>{globalThis[key]={error:/^[a-z_]{1,80}$/.test(error?.code)?error.code:'main_bootstrap_session_failed'}}); return true; })()`, returnByValue: true });
      while (true) {
        const receipt = await request('Runtime.evaluate', { expression: `globalThis[Symbol.for(${resultKey})]`, returnByValue: true });
        const result = receipt.result?.value;
        if (receipt.exceptionDetails || result?.error) throw fail(result?.error ?? 'main_bootstrap_session_failed');
        if (result?.value) { ready = { result: { value: result.value } }; break; }
        if (++polls % 16 === 0) {
          const status = await request('Runtime.evaluate', { expression: `globalThis[Symbol.for(${JSON.stringify(`codlet.private.main-traffic.${token}`)})].inspect()`, returnByValue: true }).catch(() => null);
          lastOwned = diagnosticSnapshot(status?.result?.value) ?? lastOwned;
        }
        await new Promise(resolve => setTimeout(resolve, 25));
      }
      await request('Runtime.evaluate', { expression: `delete globalThis[Symbol.for(${resultKey})]`, returnByValue: true });
    }
    catch (error) {
      const status = await request('Runtime.evaluate', { expression: `globalThis[Symbol.for(${JSON.stringify(`codlet.private.main-traffic.${token}`)})].inspect()`, returnByValue: true }).catch(() => null);
      error.details = { stage, ...(error.details ?? {}), runtime: { electron: value.electronVersion, chrome: value.chromeVersion, node: value.nodeVersion }, owned: lastOwned ?? diagnosticSnapshot(status?.result?.value), pauseReasons, timings: timings.slice(-12) }; throw error;
    }
    if (ready.exceptionDetails || typeof ready.result?.value?.installed !== 'boolean' || !Array.isArray(ready.result.value.activatedSources)
      || !Array.isArray(ready.result.value.unsupportedSources)) throw fail('main_bootstrap_source_unavailable');
    // Detach and close the Node inspector immediately after the handshake.
    stage = 'detach';
    const detached = await request('Runtime.evaluate', { expression: `globalThis[Symbol.for(${JSON.stringify(`codlet.private.main-traffic.${token}`)})].closeInspector()`, returnByValue: true });
    if (detached.exceptionDetails || detached.result?.value !== true) throw fail('main_bootstrap_detach_failed');
    activation = Object.freeze({ installed: ready.result.value.installed, exactChildVerified: true,
      activatedSources: ready.result.value.activatedSources, unsupportedSources: ready.result.value.unsupportedSources });
  } finally { clearTimeout(timer); signal?.removeEventListener('abort', stop); stop(); }
  await verifyClosed(url, Math.min(deadlineUnixMs, Date.now() + 1500));
  return activation;
}
module.exports = { attachElectronTrafficBeforeEntry, sameExecutable };
