import { discoverNative } from '../../../frontend/src/adapter/discovery.js';
import { createWorkspaceDiscovery, readWorkspaceAsset } from '../../../frontend/src/adapter/workspace-discovery.js';
import { locateHost } from '../../../frontend/src/adapter/navigation.js';
import { nativeMainInput, nativeInputBinding, findWorkspaceSurface } from '../../../frontend/src/adapter/workspace-dom.js';

export async function inspect(expected) {
  if (!document.querySelector('nav[data-app-navigation-rail="true"]')) return { status: 'not-applicable', reason: 'No main navigation rail' };
  const checks = [], sources = [], before = { focus: document.activeElement,
    roots: document.querySelectorAll('[data-codlet-workspace-owned]').length };
  const checksum = async source => [...new Uint8Array(await crypto.subtle.digest('SHA-256', new TextEncoder().encode(source)))]
    .map(value => value.toString(16).padStart(2, '0')).join('');
  const read = async (url, signal) => {
    const source = await readWorkspaceAsset(url, signal), filename = new URL(url).pathname.split('/').at(-1), sha256 = await checksum(source);
    if (expected.files[filename] !== sha256) throw Error('Native source identity changed since capture: ' + filename);
    if (!sources.some(value => value.file === filename)) sources.push({ file: filename, sha256 });
    return source;
  };
  const run = async (id, kind, work) => {
    const start = performance.now();
    try { const result = await work(); checks.push({ id, status: 'passed', evidence: 'live-readonly', kind,
      elapsedMs: performance.now() - start }); return result; }
    catch (error) { checks.push({ id, status: 'failed', evidence: 'live-readonly', kind, code: error.code ?? null,
      message: String(error.message), ...(error.details?.role && Array.isArray(error.details.candidates) ? { details: error.details } : {}),
      elapsedMs: performance.now() - start }); return null; }
  };
  let discovery;
  try {
    const base = await run('native-components', 'interface-present', () => discoverNative({ read: url => read(url, AbortSignal.timeout(10000)) }));
    if (!base) return { status: 'failed', checks, sources, fullLifecycle: 'not-verified' };
    const host = await run('mounted-router', 'readable', () => locateHost()), route = host?.navigator.location.pathname;
    discovery = createWorkspaceDiscovery(() => base, { read });
    const connection = await run('existing-connection', 'available', () => discovery.connection());
    const navigation = await run('navigation', 'available', () => discovery.navigation());
    if (navigation) {
      await run('input-ownership', 'available', () => {
        const input = nativeMainInput(document, navigation);
        if (!input) {
          checks.push({ id: 'local-input-binding', status: 'not-verified', evidence: 'live-readonly', reason: 'No Native main input is mounted' });
          return;
        }
        const binding = nativeInputBinding(input, navigation);
        checks.push({ id: 'local-input-binding', status: binding ? 'passed' : 'not-verified', evidence: 'live-readonly',
          kind: binding ? 'available' : 'not-local', local: !!binding, draftIdentityConfirmed: !!input.draft,
          composerKind: input.scope.value?.kind ?? null, composing: !!input.controller.view.composing,
          controllerHasDraftMethods: typeof input.controller.restoreDraft === 'function' && typeof input.controller.getPersistedText === 'function',
          routeMatchesInput: binding ? route === '/local/' + binding.threadId : null });
      });
      await run('workspace-surface', 'readable', () => {
        const input = nativeMainInput(document, navigation);
        const surface = findWorkspaceSurface(document, input?.input);
        if (!input || surface?.composer !== input.input || !surface.footer || !surface.content)
          throw Error('The owned Native input does not form a complete workspace surface');
      });
    }
    await run('transcript', 'interface-present', () => discovery.transcript());
    await run('composer', 'interface-present', () => discovery.composer());
    await run('direct-editor', 'interface-present', () => discovery.composerParts());
    const shortcuts = await run('shortcuts', 'interface-present', () => discovery.shortcuts());
    if (shortcuts) await run('shortcut-state', 'readable', () => {
      const state = shortcuts.keymap();
      if (!state || !Array.isArray(state.bindings)) throw Error('Native shortcut state is not ready');
      return { bindings: state.bindings.length };
    });
    await run('viewport', 'interface-present', () => discovery.viewport());
    return { status: checks.some(check => check.status === 'failed') ? 'failed' : 'passed',
      evidence: 'live-readonly', native: expected.identity, checks, sources,
      routeKind: route?.startsWith('/local/') ? 'local-thread' : route === '/' ? 'home' : 'other',
      connectionRetained: !!connection && connection.manager.requestClient === connection.client,
      focusUnchanged: before.focus === document.activeElement,
      ownedRootCountUnchanged: before.roots === document.querySelectorAll('[data-codlet-workspace-owned]').length,
      composerRebind: await discovery.composerCapabilities(), fullLifecycle: 'not-verified',
      routesChangedByProbe: 0, rootsMountedByProbe: 0, draftsReadByProbe: 0, messagesSent: 0 };
  } finally { discovery?.dispose(); }
}
