// Registry preparation only; no client, backend or transport is opened here.
import fs from 'node:fs';
import path from 'node:path';

const internalIds = new Set(['codex.desktop.adapter', 'codex.ui.adapter']);
// Match the explicit process selections accepted alongside clientPermissions
// by Core's BrokerPolicy; never resolve a command through PATH or add defaults.
function fixturePolicy(policy) {
  if (!policy || typeof policy !== 'object' || Array.isArray(policy) || policy.clientPermissions !== true
    || Object.keys(policy).some(key => !['clientPermissions', 'executables', 'cwdRoots', 'envKeys'].includes(key))) {
    throw Error('extraPluginPolicies accepts only clientPermissions:true and explicit executables/cwdRoots/envKeys arrays');
  }
  for (const key of ['executables', 'cwdRoots', 'envKeys']) {
    if (!Object.hasOwn(policy, key)) continue;
    const values = policy[key], pathValues = key !== 'envKeys';
    if (!Array.isArray(values) || values.length > 32 || new Set(values).size !== values.length
      || values.some(value => typeof value !== 'string' || !value || !value.isWellFormed()
        || /[\x00-\x1f\x7f-\x9f]/u.test(value) || Buffer.byteLength(value) > (pathValues ? 4096 : 128)
        || (pathValues ? !path.isAbsolute(value) || value.split(/[\\/]/u).some(part => part === '.' || part === '..')
          : !/^[A-Za-z_][A-Za-z0-9_]*$/u.test(value)))) throw Error('invalid explicit broker selection: ' + key);
    if (pathValues && process.platform === 'win32' && values.some(value => {
      if (!/^(?:[A-Za-z]:[\\/]|\\\\\?\\[A-Za-z]:\\)/u.test(value)) return true;
      const components = value.slice(path.parse(value).root.length).split(/[\\/]/u);
      return components.some(part => /:|[. ]$/u.test(part) || /^(?:CON|PRN|AUX|NUL|CLOCK\$|COM[1-9¹²³]|LPT[1-9¹²³])(?:\.|$)/iu.test(part))
        || key === 'executables' && path.extname(value).toLowerCase() !== '.exe';
    })) throw Error('invalid explicit Windows broker path: ' + key);
  }
  return policy;
}

export function acceptanceGuiPath(config) {
  const source = config.guiPlugin ?? (typeof config.pluginsRoot === 'string' && path.isAbsolute(config.pluginsRoot)
    ? path.join(config.pluginsRoot, 'bundled/codlet') : null);
  if (typeof source !== 'string' || !path.isAbsolute(source)) throw Error('guiPlugin must be an absolute GUI plugin directory');
  return source;
}

export function prepareAcceptancePlugins(config, { root, baseUrl }) {
  const registry = { schema: 2, plugins: {}, localPlugins: {} };
  const manifestAt = source => {
    const manifest = JSON.parse(fs.readFileSync(path.join(source, 'codlet.json'), 'utf8'));
    if (!/^[A-Za-z0-9][A-Za-z0-9._-]{0,127}$/.test(manifest.id) || internalIds.has(manifest.id)
      || registry.localPlugins[manifest.id] || !Array.isArray(manifest.permissions)) throw Error('invalid, internal or duplicate fixture plugin id');
    return manifest;
  };
  const gui = acceptanceGuiPath(config), manifest = manifestAt(gui);
  registry.localPlugins[manifest.id] = { path: gui, grants: manifest.permissions };
  if (config.extraPlugins != null && !Array.isArray(config.extraPlugins)) throw Error('extraPlugins requires absolute trusted fixture directories');
  for (const source of config.extraPlugins ?? []) {
    if (typeof source !== 'string' || !path.isAbsolute(source)) throw Error('extraPlugins requires absolute trusted fixture directories');
    const manifest = manifestAt(source), directory = path.join(root, 'fixture-plugins', manifest.id);
    const suppliedPolicy = config.extraPluginPolicies?.[manifest.id];
    const policy = suppliedPolicy === undefined ? undefined : fixturePolicy(suppliedPolicy);
    fs.cpSync(source, directory, { recursive: true, errorOnExist: true, force: false });
    fs.writeFileSync(path.join(directory, 'fixture.json'), JSON.stringify({ baseUrl: baseUrl ?? null, autorun: config.functionalTestAuto === true }));
    registry.localPlugins[manifest.id] = { path: directory, grants: manifest.permissions,
      ...(policy ? { brokerPolicy: policy } : baseUrl && manifest.permissions.includes('host.network')
        ? { brokerPolicy: { networkOrigins: [new URL(baseUrl).origin] } } : {}) };
  }
  return registry;
}
