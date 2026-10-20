import fs from 'node:fs';
import path from 'node:path';
import { digest } from './native-source-snapshot.mjs';
import { resolveModulePath, parseSourceModel } from './native-source-index.mjs';
import { WORKSPACE_FUNCTION_ROLES, matchesWorkspaceFunction, workspaceInputProperties } from '../../codex/frontend/src/adapter/workspace-role-contracts.js';

const scopeRoles = {
  appScope: { brand: 'AppScope', parent: null, capabilities: ['navigation', 'shortcuts'] },
  threadScope: { brand: 'ThreadScope', parent: 'appScope', capabilities: ['navigationInput', 'transcript', 'composer', 'viewport'] },
  routeScope: { brand: 'RouteScope', parent: 'threadScope', capabilities: ['navigationInput', 'transcript', 'composer', 'viewport'] },
  composerScope: { brand: 'ComposerScope', parent: 'routeScope', capabilities: ['navigationInput', 'transcript', 'composer'] },
};

export function workspaceSourceAnalysis(index) {
  const manifestPath = path.join(index.snapshot, 'snapshot.json');
  if (digest(fs.readFileSync(manifestPath)) !== index.snapshotSha256) throw Error('Snapshot metadata changed after indexing');
  const manifest = JSON.parse(fs.readFileSync(manifestPath)), files = new Map(manifest.files.map(file => [file.path, file]));
  const modules = new Map(index.modules.map(module => [module.path, module])), sources = new Map();
  const source = module => {
    if (!sources.has(module.path)) {
      const bytes = fs.readFileSync(path.join(index.snapshot, 'sources', module.path));
      if (digest(bytes) !== module.sha256 || module.sha256 !== files.get(module.path)?.sha256) throw Error(`Indexed source changed: ${module.path}`);
      sources.set(module.path, bytes.toString('utf8'));
    }
    return sources.get(module.path);
  };
  const records = [], byBinding = new Map(), importBindings = new Map();
  const key = (module, binding) => `${module.path}#${binding}`;
  for (const module of modules.values()) {
    for (const imported of module.imports.filter(item => !item.dynamic)) for (const specifier of imported.specifiers) {
      importBindings.set(key(module, specifier.binding), { module: resolveModulePath(module.path, imported.source), exported: specifier.imported });
    }
    for (const record of module.records) {
      const item = { module, record, key: key(module, record.binding) };
      records.push(item);
      if (!byBinding.has(item.key)) byBinding.set(item.key, []);
      byBinding.get(item.key).push(item);
    }
  }
  const resolve = (module, binding, seen = new Set()) => {
    const current = key(module, binding);
    if (seen.has(current)) return null;
    seen.add(current);
    const imported = importBindings.get(current);
    if (!imported) return current;
    const target = modules.get(imported.module);
    if (!target) return null;
    const exported = target.exports.filter(item => item.exported === imported.exported);
    if (exported.length !== 1 || !exported[0].binding) return null;
    return resolve(target, exported[0].binding, seen);
  };
  const same = (left, leftRef, right, rightRef) => leftRef?.binding && rightRef?.binding &&
    resolve(left.module, leftRef.binding) !== null && resolve(left.module, leftRef.binding) === resolve(right.module, rightRef.binding);
  const code = item => source(item.module).slice(item.record.start.offset, item.record.end.offset);
  const evidence = item => ({
    file: item.module.path, sha256: item.module.sha256, binding: item.record.binding, local: item.record.local,
    exports: item.record.exportNames, start: item.record.start, end: item.record.end, type: item.record.type,
    normalizedHash: item.record.normalizedHash, interfaceHash: item.record.interfaceHash, interface: item.record.interface,
    dependencies: (item.record.dependencies ?? []).map(dependency => ({ ...dependency, resolved: resolve(item.module, dependency.binding) })),
    unresolved: item.record.unresolved ?? null,
  });
  const unique = values => [...new Map(values.map(item => [item.key, item])).values()];
  const roles = {};
  const add = (name, matches, contract, extra = {}) => {
    const candidates = unique(matches);
    roles[name] = { ...contract, status: candidates.length === 1 ? 'located' : candidates.length ? 'ambiguous' : 'not-located',
      candidates: candidates.map(evidence), ...extra };
    return candidates;
  };
  const scoped = {};
  for (const [name, contract] of Object.entries(scopeRoles)) scoped[name] = add(name, records.filter(item =>
    item.record.value?.type === 'CallExpression' && item.record.value.arguments[0]?.literal === contract.brand), contract);
  for (const [name, contract] of Object.entries(scopeRoles)) if (contract.parent && scoped[name].length === 1 && scoped[contract.parent].length === 1) {
    const current = scoped[name][0], parent = scoped[contract.parent][0];
    const ref = current.record.value.arguments[1]?.object?.find(property => property.key === 'parent')?.value;
    roles[name].parentRelation = { expectedRole: contract.parent,
      matched: ref?.binding ? resolve(current.module, ref.binding) === parent.key : false,
      sourceReference: ref ?? null };
    if (!roles[name].parentRelation.matched) roles[name].status = 'interface-mismatch';
  }

  const functions = records.filter(item => item.record.interface?.kind === 'function');
  for (const [name, contract] of Object.entries(WORKSPACE_FUNCTION_ROLES)) {
    const matches = functions.filter(item => {
      const record = item.record;
      if (!record.exportNames.length && !['viewportSetOpen', 'viewportPersistence'].includes(name)) return false;
      if (name === 'viewportPersistence') {
        const parameter = record.interface.parameters[0];
        const names = parameter?.properties?.map(property => property.key?.name ?? property.key?.value) ?? [];
        if (names.length !== 4 || !['mainContentWidth', 'storageKey', 'widthMode', 'width'].every(value => names.includes(value))) return false;
      }
      const text = code(item);
      if (!contract.markers.every(marker => text.includes(marker))) return false;
      const inputProperties = contract.inputProperties ? workspaceInputProperties(parseSourceModel(text).ast.body[0]) : [];
      return matchesWorkspaceFunction(text, record.interface.parameters.length, contract, inputProperties);
    });
    add(name, matches, contract);
  }

  const defaults = records.filter(item => item.record.value?.object?.length === 3 &&
    ['navigate', 'navigateToLocalConversation', 'prepareNavigation'].every(name => item.record.value.object.some(property => property.key === name)));
  const navPairs = [];
  for (const item of records) {
    const value = item.record.value;
    if (value?.type !== 'CallExpression' || value.arguments.length !== 2 || !item.record.exportNames.length) continue;
    for (const fallback of defaults) if (value.arguments[1]?.binding && resolve(item.module, value.arguments[1].binding) === fallback.key) {
      navPairs.push({ signal: item, fallback });
    }
  }
  add('navigationSignal', navPairs.map(pair => pair.signal), { label: 'navigation signal', capabilities: ['navigation', 'navigationInput', 'locationRestore'] },
    { defaults: unique(navPairs.map(pair => pair.fallback)).map(evidence) });

  const queries = records.filter(item => item.record.value?.type === 'CallExpression' &&
    [2, 3].includes(item.record.value.arguments.length) && item.record.value.arguments[1]?.literal === 'codex-command-keymap-state');
  const queryPairs = [];
  for (const derived of records) {
    const value = derived.record.value;
    if (value?.type !== 'CallExpression' || value.arguments.length !== 2 || !derived.record.exportNames.length ||
        !code(derived).includes('primaryNumberShortcutTarget')) continue;
    for (const query of queries) {
      if (!same(derived, value.arguments[0], query, query.record.value.arguments[0])) continue;
      const reads = derived.record.calls.filter(call => call.callee?.parameter?.path?.length === 1 &&
        call.callee.parameter.path[0] === 'get' && call.arguments.length === 1 && call.arguments[0]?.binding &&
        resolve(derived.module, call.arguments[0].binding) === query.key);
      if (reads.length) queryPairs.push({ query, derived, reads });
    }
  }
  add('shortcutQuery', queryPairs.map(pair => pair.query), { label: 'shortcut query declaration', capabilities: ['shortcuts'] },
    { declarationsWithKey: queries.length });
  add('shortcutState', queryPairs.map(pair => pair.derived), { label: 'derived shortcut state', capabilities: ['shortcuts'] },
    { flow: queryPairs.map(pair => ({ query: evidence(pair.query), derived: evidence(pair.derived), reads: pair.reads,
      consumers: records.filter(item => item.key !== pair.derived.key &&
        item.record.dependencies?.some(dependency => resolve(item.module, dependency.binding) === pair.derived.key))
        .map(item => ({ file: item.module.path, local: item.record.local, start: item.record.start, exports: item.record.exportNames })) })) });

  add('viewportShell', records.filter(item => item.record.exportNames.length &&
    item.record.type === 'ObjectExpression' && ['RightPanelOutlet', 'DetailPanelOutlet', 'HeaderToolbar', 'MainContentLayout']
      .every(marker => item.record.value.object.some(property => property.key === marker))),
  { label: 'Native viewport namespace', capabilities: ['viewport'] });
  const capabilities = {};
  for (const [name, role] of Object.entries(roles)) for (const capability of role.capabilities) {
    const entry = capabilities[capability] ??= { source: 'located', roles: [], simulated: 'not-verified', live: 'not-verified' };
    entry.roles.push(name);
    if (role.status !== 'located') entry.source = 'incomplete';
  }

  // Compact cross-build mapping data. Native source and the complete reference
  // index remain in their separate immutable snapshot/index artifacts.
  const structures = records.filter(item => item.record.normalizedHash && item.record.end.offset - item.record.start.offset > 24)
    .map(item => ({ key: item.key, id: item.record.id, hash: item.record.normalizedHash,
      interfaceHash: item.record.interfaceHash, type: item.record.type,
      dependencies: (item.record.dependencies ?? []).map(dependency => resolve(item.module, dependency.binding)),
      unresolved: item.record.unresolved ?? null }));
  return { schema: 1, kind: 'native-workspace-source-analysis', identity: index.identity,
    snapshot: index.snapshot, snapshotSha256: index.snapshotSha256, analysis: { ...index.analysis, unindexedCount: index.analysis.unindexed.length, unindexed: undefined },
    roles, capabilities, structures,
    limits: ['Source location is not a live capability check.', 'Unindexed dynamic modules and missing baseline files remain unverified.',
      'Equal binding-normalized AST requires dependency review and does not prove runtime semantics.'] };
}

