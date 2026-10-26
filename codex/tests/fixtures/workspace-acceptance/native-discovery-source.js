import { discoverNative } from '../../../frontend/src/adapter/discovery.js';
import { createWorkspaceDiscovery } from '../../../frontend/src/adapter/workspace-discovery.js';
import { componentSource, currentElementAncestry } from '../../../frontend/src/host-discovery.js';
import { inspectNativeComposerScope } from '../../../frontend/src/adapter/workspace-native-composer.js';

// No roots, route changes, transactions, draft writes or adapter activation.
export async function inspect() {
  const phases = [], started = performance.now();
  const phase = async (name, work) => {
    const start = performance.now();
    try { const result = await work(); phases.push({ name, status: 'passed', ms: performance.now() - start }); return result; }
    catch (error) { phases.push({ name, status: 'failed', code: error.code ?? null, message: error.message, ms: performance.now() - start }); throw error; }
  };
  let discovery;
  try {
    const native = await phase('base', () => discoverNative());
    discovery = createWorkspaceDiscovery(() => native);
    const connection = await phase('connection', () => discovery.connection());
    const parts = await phase('composerParts', () => discovery.composerParts());
    const checks = performance.now();
    for (let count = 0; count < 1000; count++) parts.check();
    const check1000Ms = performance.now() - checks;
    const role = value => ({ callable: typeof value === 'function', sourceCharacters: componentSource(value).length });
    const inputs = [...document.querySelectorAll('[data-codex-composer-root]')];
    const editors = inputs.map(input => {
      const editable = input.querySelector('[contenteditable="true"]');
      let chain;
      for (let element = editable; element && input.contains(element); element = element.parentElement) {
        chain = currentElementAncestry(element); if (chain) break;
      }
      const implementations = chain?.filter(fiber => ['onDocumentChange', 'onDocumentDispose', 'composerController'].every(marker => componentSource(fiber.type).includes(marker))) ?? [];
      const model = chain && inspectNativeComposerScope(parts, chain);
      const controllers = new Set();
      for (const fiber of chain ?? []) {
        const value = fiber.tag === 10 && fiber.memoizedProps?.value;
        if (value?.view?.dom === editable) controllers.add(value);
        const dependencies = new Set();
        for (let dep = fiber.dependencies?.firstContext; dep && !dependencies.has(dep); dep = dep.next) {
          dependencies.add(dep);
          if (dep.memoizedValue?.view?.dom === editable) controllers.add(dep.memoizedValue);
        }
      }
      const controller = controllers.size === 1 ? [...controllers][0] : null;
      const scopeRefs = implementations.map(fiber => {
        const brands = [];
        const hooks = new Set();
        for (let hook = fiber.memoizedState; hook && !hooks.has(hook); hook = hook.next) {
          hooks.add(hook);
          const value = hook.memoizedState?.current;
          if (value?.node && value?.scope) brands.push({ brand: value.scope.__scopeBrand ?? null, composerScope: value.scope === parts.composerScope });
        }
        return { component: fiber.type?.name ?? null, brands };
      });
      return { editable: !!editable, committed: !!chain, implementation: implementations.length > 0, composerFacade: !!model, scopeRefs,
        modelKind: model?.value?.kind ?? null, modelHasConversation: typeof model?.value?.conversationId === 'string',
        controllers: controllers.size, nativeRestore: typeof controller?.restoreDraft === 'function',
        nativePersistedText: typeof controller?.getPersistedText === 'function', destroyed: controller?.view?.isDestroyed ?? null };
    });
    return { status: 'passed', phases, ms: performance.now() - started, visibility: document.visibilityState,
      roles: { Composer: role(parts.Composer), ComposerSurface: role(parts.ComposerSurface), Scope: role(parts.Scope),
        useScope: role(parts.useScope), createEditor: role(parts.createEditor) },
      scopeBrands: [parts.ThreadScope.__scopeBrand, parts.RouteScope.__scopeBrand, parts.composerScope.__scopeBrand],
      existingConnection: connection.manager.requestClient === connection.client, check1000Ms, editors,
      composerCapabilities: await discovery.composerCapabilities(), nativeLifecycleBridge: !!parts.composerLifecycle,
      ownedRoots: document.querySelectorAll('[data-codlet-workspace-owned]').length, draftWrites: 0, mountedRoots: 0, sentTurns: 0 };
  } catch (error) { return { status: 'failed', phases, code: error.code ?? null, message: error.message }; }
  finally { discovery?.dispose(); }
}
