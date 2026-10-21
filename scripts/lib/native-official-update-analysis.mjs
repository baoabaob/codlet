import fs from 'node:fs';
import path from 'node:path';
import { digest } from './native-source-snapshot.mjs';
import { resolveModulePath, parseSourceModel } from './native-source-index.mjs';

const stateKeys = ['downloadProgressPercent', 'installProgressPercent', 'isUpdateReady',
  'lifecycleState', 'relaunchNotice', 'supportsAutoInstallWhenIdle'];

// Resolve the existing Native update signal and service. This only reads the
// captured AST index; it never imports Native code or calls its update methods.
export function officialUpdateSourceAnalysis(index) {
  const manifestPath = path.join(index.snapshot, 'snapshot.json');
  if (digest(fs.readFileSync(manifestPath)) !== index.snapshotSha256) throw Error('Snapshot changed after indexing');
  const manifest = JSON.parse(fs.readFileSync(manifestPath));
  const files = new Map(manifest.files.map(file => [file.path, file]));
  const modules = new Map(index.modules.map(module => [module.path, module]));
  const imports = new Map(), records = [], bindings = new Map(), sources = new Map();
  const key = (module, binding) => `${module.path}#${binding}`;
  for (const module of modules.values()) {
    for (const imported of module.imports.filter(item => !item.dynamic)) for (const specifier of imported.specifiers) {
      imports.set(key(module, specifier.binding), { module: resolveModulePath(module.path, imported.source), exported: specifier.imported });
    }
    for (const record of module.records) {
      const item = { module, record, key: key(module, record.binding) };
      records.push(item);
      if (!bindings.has(item.key)) bindings.set(item.key, []);
      bindings.get(item.key).push(item);
    }
  }
  const resolve = (module, binding, seen = new Set()) => {
    if (!binding) return null;
    const id = key(module, binding);
    if (seen.has(id)) return null;
    seen.add(id);
    const imported = imports.get(id);
    if (!imported) return id;
    const target = modules.get(imported.module);
    const exported = target?.exports.filter(item => item.exported === imported.exported);
    return exported?.length === 1 ? resolve(target, exported[0].binding, seen) : null;
  };
  const source = module => {
    if (!sources.has(module.path)) {
      const bytes = fs.readFileSync(path.join(index.snapshot, 'sources', module.path));
      if (digest(bytes) !== module.sha256 || files.get(module.path)?.sha256 !== module.sha256) throw Error(`Indexed source changed: ${module.path}`);
      sources.set(module.path, bytes.toString('utf8'));
    }
    return sources.get(module.path);
  };
  const evidence = item => ({ file: item.module.path, sha256: item.module.sha256, binding: item.record.binding,
    exports: item.record.exportNames, start: item.record.start, end: item.record.end, normalizedHash: item.record.normalizedHash });
  const unique = items => [...new Map(items.map(item => [item.key, item])).values()];
  const scopes = unique(records.filter(item => item.record.value?.type === 'CallExpression' &&
    item.record.value.arguments[0]?.literal === 'AppScope' && item.record.exportNames.length));
  const defaults = unique(records.filter(item => Array.isArray(item.record.value?.object) && stateKeys.every(name => item.record.value.object.some(property => property.key === name)) &&
    item.record.value.object.find(property => property.key === 'lifecycleState').value.literal === 'idle'));
  const atoms = [], selectors = [];
  for (const scope of scopes) for (const fallback of defaults) for (const item of records) {
    const value = item.record.value;
    if (value?.type === 'CallExpression' && value.arguments.length === 2 &&
        resolve(item.module, value.arguments[0]?.binding) === scope.key &&
        resolve(item.module, value.arguments[1]?.binding) === fallback.key) atoms.push({ item, scope, fallback });
  }
  for (const atom of atoms) for (const item of records) {
    const value = item.record.value;
    if (value?.type !== 'CallExpression' || value.arguments.length !== 2 || !item.record.exportNames.length ||
        resolve(item.module, value.arguments[0]?.binding) !== atom.scope.key ||
        !item.record.properties.includes('isUpdateReady')) continue;
    const reads = item.record.calls.filter(call => call.callee?.parameter?.index === 0 &&
      call.callee.parameter.path?.length === 1 && call.callee.parameter.path[0] === 'get' &&
      call.arguments.length === 1 && resolve(item.module, call.arguments[0]?.binding) === atom.item.key);
    if (reads.length !== 1 || item.record.calls.length !== 2) continue;
    const expression = parseSourceModel(source(item.module).slice(item.record.start.offset, item.record.end.offset)).ast.body[0]?.expression;
    const callback = expression?.arguments?.[1], body = callback?.body;
    if (callback?.type !== 'ArrowFunctionExpression' || callback.async || body?.type !== 'MemberExpression' ||
        body.computed || body.property.name !== 'isUpdateReady' || body.object.type !== 'CallExpression' ||
        body.object.callee.type !== 'Identifier' || body.object.arguments.length !== 1) continue;
    selectors.push({ item, ...atom, selector: item });
  }
  const services = [], calls = [];
  for (const item of records) for (const call of item.record.calls) {
    const method = call.callee;
    if (method?.member !== 'installUpdate' || method.computed || method.object?.member !== 'appUpdates' ||
        method.object.computed || call.arguments.length) continue;
    const id = resolve(item.module, method.object.object?.binding);
    const candidates = bindings.get(id)?.filter(value => value.record.exportNames.length) ?? [];
    if (candidates.length !== 1) continue;
    services.push(candidates[0]); calls.push({ file: item.module.path, sha256: item.module.sha256, at: call.at, service: id });
  }
  const serviceBindings = unique(services), selectorBindings = unique(selectors.map(pair => pair.selector));
  const entries = manifest.files.filter(file => /^webview\/assets\/index-[a-f0-9]+\.js$/.test(file.path));
  const counts = { scopes: scopes.length, defaults: defaults.length, atoms: atoms.length,
    selectors: selectorBindings.length, services: serviceBindings.length, entries: entries.length };
  const report = { schema: 1, kind: 'native-official-update-source-analysis', identity: index.identity,
    snapshotSha256: index.snapshotSha256, status: Object.values(counts).every(count => count === 1) ? 'located' : 'incomplete', counts,
    evidence: { scopes: scopes.map(evidence), defaults: defaults.map(evidence), atoms: unique(atoms.map(pair => pair.item)).map(evidence),
      selectors: selectorBindings.map(evidence), services: serviceBindings.map(evidence), installCalls: calls, entries }, profile: null };
  if (report.status !== 'located') return report;
  const scope = scopes[0], selector = selectorBindings[0], service = serviceBindings[0];
  // Validate all files represented by the generated profile, including exports
  // whose declarations do not need parsing for the semantic predicate above.
  for (const item of [scope, service, selector]) source(item.module);
  const entryBytes = fs.readFileSync(path.join(index.snapshot, 'sources', entries[0].path));
  if (digest(entryBytes) !== entries[0].sha256) throw Error('Entry source changed');
  if (!index.identity.appVersion || index.identity.buildNumber == null) throw Error('Exact Native build identity is required');
  const url = file => `app://-/${file.replace(/^webview\//, '')}`;
  report.profile = { appVersion: index.identity.appVersion, buildNumber: String(index.identity.buildNumber),
    entry: url(entries[0].path), module: url(selector.module.path), scopeModule: url(scope.module.path),
    servicesModule: url(service.module.path), exports: { scope: scope.record.exportNames[0], services: service.record.exportNames[0] },
    officialUpdates: { stateSelector: selector.record.exportNames[0] } };
  return report;
}
