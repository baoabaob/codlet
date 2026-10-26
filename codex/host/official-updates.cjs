'use strict';
const fs = require('node:fs/promises');
const path = require('node:path');
const { createHash } = require('node:crypto');
const failure = code => Object.assign(new Error(code), { code });
const rootMethods = ['getIsUpdateReady', 'getUpdateLifecycleState', 'getDownloadedUpdateAppBrand', 'getSupportsAutoInstallWhenIdle', 'installUpdatesIfAvailable'];
const digest = value => createHash('sha256').update(value).digest('hex');
const version = value => typeof value === 'string' && /^\d+(?:\.\d+){2,3}$/.test(value);
const samePath = (a,b) => typeof a === 'string' && typeof b === 'string' && path.resolve(a).toLowerCase() === path.resolve(b).toLowerCase();
const fileIdentity = value => JSON.stringify([value.dev,value.ino,value.size,value.mtimeMs,value.ctimeMs]);

// Inspect the updater instance that Native already owns. Reading staged state
// directly avoids Native's readStageState(), which deletes invalid staging.
function createOfficialUpdates(electron, modules, io = fs) {
  let cached, closed = false, installation = null;
  function owner() {
    const roots = new Set(), constructors = new Set();
    for (const record of modules?.list?.() ?? []) for (const description of record.classes ?? []) {
      if (!/^[A-Za-z_$][\w$]*$/.test(description.binding) || !rootMethods.every(name => description.methods?.includes(name))) continue;
      let Constructor; try { Constructor = record.evaluate(description.binding); } catch { continue; }
      if (typeof Constructor !== 'function' || constructors.has(Constructor)) continue;
      constructors.add(Constructor);
      if (!rootMethods.every(name => typeof Constructor.prototype?.[name] === 'function')) continue;
      for (const value of modules.instances(Constructor)) if (rootMethods.every(name => typeof value[name] === 'function')) roots.add(value);
    }
    if (roots.size !== 1) throw failure(roots.size ? 'official_update_owner_ambiguous' : 'official_update_owner_pending');
    return roots.values().next().value;
  }
  function selected(root) {
    if (closed || root.getIsUpdateReady() !== true || root.getUpdateLifecycleState() !== 'ready') throw failure('official_update_not_ready');
    const wrapper = root.updater, updater = wrapper && 'activeUpdater' in wrapper ? wrapper.activeUpdater : wrapper;
    if (!updater || updater.getIsUpdateReady?.() !== true || typeof updater.getStageStatePath !== 'function' ||
        typeof updater.options?.nativeAddon?.readPackageMetadata !== 'function') throw failure('official_update_target_unavailable');
    return updater;
  }
  async function inspect() {
    const root = owner(), updater = selected(root), addon = updater.options.nativeAddon;
    const stagePath = updater.getStageStatePath(), expectedPath = path.join(addon.getPackageLocalCachePath(), 'windows-updates', 'prepared.msix');
    const before = await io.stat(stagePath), bytes = await io.readFile(stagePath), after = await io.stat(stagePath);
    if (!before.isFile() || fileIdentity(before) !== fileIdentity(after)) throw failure('official_update_target_changed');
    const stage = JSON.parse(bytes);
    if (!samePath(stage.packagePath, expectedPath) || !version(stage.buildVersion) ||
        stage.sha256 != null && !/^[a-f0-9]{64}$/i.test(stage.sha256)) throw failure('official_update_stage_invalid');
    const packageBefore = await io.stat(expectedPath);
    if (!packageBefore.isFile() || stage.length != null && stage.length !== packageBefore.size) throw failure('official_update_target_changed');
    const fingerprint = digest(Buffer.concat([bytes, Buffer.from(fileIdentity(packageBefore))]));
    let metadata;
    if (cached?.root === root && cached.updater === updater && cached.fingerprint === fingerprint) metadata = cached.metadata;
    else metadata = await addon.readPackageMetadata(expectedPath);
    if (!version(metadata?.packageVersion) || metadata.packageIdentity !== updater.options.packageIdentity ||
        metadata.packagePublisher !== updater.options.packagePublisher || metadata.architecture !== process.arch) throw failure('official_update_package_invalid');
    if (owner() !== root || selected(root) !== updater || fingerprint !== digest(Buffer.concat([await io.readFile(stagePath), Buffer.from(fileIdentity(await io.stat(expectedPath)))]))) throw failure('official_update_target_changed');
    const target = { id: digest(JSON.stringify([fingerprint, metadata.packageIdentity, metadata.packagePublisher, metadata.architecture, metadata.packageVersion])), version: metadata.packageVersion };
    cached = { root, updater, fingerprint, metadata, target };
    return { root, updater, target };
  }
  return {
    async target() {
      try { return { target: (await inspect()).target, reason: null, installation }; }
      catch (error) { return { target: null, reason: error.code ?? 'official_update_target_unavailable', installation }; }
    },
    async install(expectedTarget) {
      const value = await inspect();
      if (value.target.id !== expectedTarget) throw failure('official_update_target_changed');
      // Core reserves this operation before dispatch. The Native updater owns
      // its policy, installation, cancellation and Windows restart behavior.
      const current = installation = { targetId: value.target.id, state: 'pending' };
      const result = value.root.installUpdatesIfAvailable();
      Promise.resolve(result).then(accepted => { if (installation === current) installation = { ...current, state: accepted === false ? 'cancelled' : 'completed' }; }, () => { if (installation === current) installation = { ...current, state: 'failed' }; });
      return { accepted: true, target: value.target };
    },
    close() { closed = true; cached = undefined; },
  };
}
module.exports = { createOfficialUpdates };
