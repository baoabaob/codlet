// Exact-child handshake shared by the production-owned acceptance runner.
// The caller has already paused and identified this private Desktop child.
import path from 'node:path';
import { createRequire } from 'node:module';

const require = createRequire(import.meta.url);
const safeError = error => typeof error?.code === 'string' && /^[a-z_]{1,80}$/u.test(error.code) ? error.code : 'main_handshake_failed';
const fail = code => Object.assign(new Error(code), { code });

function validTraffic(value) {
  const source = value?.source, endpoint = source?.endpoint;
  if (!source || source.version !== 1 || source.kind !== 'plaintext' || endpoint?.host !== '127.0.0.1'
    || !Number.isSafeInteger(endpoint.port) || endpoint.port < 1 || endpoint.port > 65535
    || typeof endpoint.token !== 'string' || !/^[A-Za-z0-9_-]{43}$/u.test(endpoint.token)
    || typeof source.routeBaseUrl !== 'string' || !Array.isArray(source.protocols) || !Array.isArray(source.operations)
    || value.environmentPatch?.set == null || !Array.isArray(value.environmentPatch?.removeCaseInsensitive)) throw fail('traffic_descriptor_invalid');
  const route = new URL(source.routeBaseUrl);
  if (route.protocol !== 'http:' || route.hostname !== '127.0.0.1' || !route.port || route.username || route.password || route.search || route.hash) throw fail('traffic_descriptor_invalid');
}

function compactSources(values) {
  if (!Array.isArray(values)) return [];
  return values.slice(0, 16).map(value => ({
    id: typeof value?.id === 'string' && /^[A-Za-z0-9_.-]{1,64}$/u.test(value.id) ? value.id : 'unknown',
    protocols: Array.isArray(value?.protocols) ? value.protocols.filter(item => ['http', 'sse', 'webSocket'].includes(item)).slice(0, 8) : [],
    operations: Array.isArray(value?.operations) ? value.operations.filter(item => ['route.register', 'route.update', 'route.close', 'http.intercept'].includes(item)).slice(0, 8) : [],
    coverage: Array.isArray(value?.coverage) ? value.coverage.filter(item => typeof item === 'string' && /^[A-Za-z0-9_.-]{1,96}$/u.test(item)).slice(0, 16) : [],
  }));
}

export async function verifyOwnedMainHandshake({ inspectorUrl, expectedPid, executable, traffic, signal }) {
  const supportedRuntime = process.platform === 'win32' && process.versions.node.split('.')[0] === '24'
    || process.platform === 'darwin' && process.arch === 'arm64' && process.version === 'v22.23.2';
  if (!supportedRuntime || !Number.isSafeInteger(expectedPid) || expectedPid < 1 || !path.isAbsolute(executable ?? '') || !signal)
    throw fail('owned_process_identity_required');
  try {
    const url = new URL(inspectorUrl);
    if (url.protocol !== 'ws:' || url.hostname !== '127.0.0.1' || !url.port || url.username || url.password || url.search || url.hash || !/^\/[a-f0-9-]{36}$/u.test(url.pathname)) throw fail('inspector_descriptor_invalid');
    validTraffic(traffic);
    const { attachClientLaunch } = require('../bundled/codex-desktop-adapter/host.cjs');
    const value = await attachClientLaunch({ inspectorUrl, expectedPid, executable, traffic, signal });
    const report = {
      installed: value?.installed === true,
      exactChildVerified: value?.exactChildVerified === true,
      activatedSources: compactSources(value?.activatedSources),
      unsupportedSources: Array.isArray(value?.unsupportedSources) ? value.unsupportedSources.slice(0, 16).map(item => ({
        id: typeof item?.id === 'string' && /^[A-Za-z0-9_.-]{1,64}$/u.test(item.id) ? item.id : 'unknown',
        reason: typeof item?.reason === 'string' && /^[a-z_]{1,80}$/u.test(item.reason) ? item.reason : 'unsupported',
      })) : [],
    };
    if (!report.installed || !report.exactChildVerified || !report.activatedSources.length) throw fail('main_source_not_activated');
    return report;
  } catch (error) {
    const wrapped = fail(safeError(error));
    const stages = new Set(['connect', 'pause', 'identity', 'install', 'resume', 'ready', 'detach']);
    const methods = new Set(['Debugger.enable', 'Runtime.runIfWaitingForDebugger', 'Debugger.evaluateOnCallFrame', 'Debugger.resume', 'Runtime.evaluate']);
    const input = error?.details ?? {};
    const details = {
      ...(stages.has(error?.details?.stage) ? { stage: error.details.stage } : {}),
      ...(methods.has(error?.details?.method) ? { method: error.details.method } : {}),
    };
    const versions = input.runtime;
    if (versions && typeof versions === 'object') details.runtime = Object.fromEntries(['electron', 'chrome', 'node'].flatMap(key => {
      const value = versions[key]; return typeof value === 'string' && /^\d{1,3}(?:\.\d{1,4}){1,3}(?:[-+][A-Za-z0-9.-]{1,24})?$/u.test(value) ? [[key, value]] : [];
    }));
    const owned = input.owned;
    if (owned && typeof owned === 'object') details.owned = {
      ...(typeof owned.installed === 'boolean' ? { installed: owned.installed } : {}),
      ...(owned.source && typeof owned.source === 'object' ? { source: { connected: owned.source.connected === true,
        ...(typeof owned.source.reason === 'string' && /^[a-z_]{1,80}$/u.test(owned.source.reason) ? { reason: owned.source.reason } : {}) } } : {}),
      ...(owned.desktop && typeof owned.desktop === 'object' ? { desktop: { available: owned.desktop.available === true,
        taskConfigurationAvailable: owned.desktop.taskConfigurationAvailable === true,
        modules: Object.fromEntries(['bootstrap', 'main', 'src', 'stdio', 'connection'].map(key => [key, owned.desktop.modules?.[key] === true])),
        ...(typeof owned.desktop.reason === 'string' && /^[a-z_]{1,80}$/u.test(owned.desktop.reason) ? { reason: owned.desktop.reason } : {}) } } : {}),
      ...(owned.backend && typeof owned.backend === 'object' ? { backend: { available: owned.backend.available === true,
        ...(typeof owned.backend.reason === 'string' && /^[a-z_]{1,80}$/u.test(owned.backend.reason) ? { reason: owned.backend.reason } : {}) } } : {}),
    };
    if (Array.isArray(input.pauseReasons)) details.pauseReasonCount = Math.min(input.pauseReasons.length, 32);
    if (Array.isArray(input.timings)) details.timings = input.timings.slice(-12).flatMap(value => methods.has(value?.method)
      && Number.isSafeInteger(value.ms) && value.ms >= 0 ? [{ method: value.method, ms: Math.min(value.ms, 60000) }] : []);
    if (Object.keys(details).length) wrapped.details = details;
    throw wrapped;
  }
}
