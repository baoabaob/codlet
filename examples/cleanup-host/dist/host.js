'use strict';

const fs = require('node:fs');
const path = require('node:path');
let sessionId;
let marker;
let root;
let settings;

function report(name, value) {
  if (settings?.report) fs.writeFileSync(path.resolve(root, `${settings.report}.${name}.json`), JSON.stringify(value, null, 2));
}

module.exports = {
  async activate(context) {
    root = context.root;
    const configuration = path.join(root, 'settings.json');
    settings = fs.existsSync(configuration) ? JSON.parse(fs.readFileSync(configuration, 'utf8')) : {};
    marker = `__codlet_cleanup_${context.plugin.id}_${context.plugin.generation}`;
    const { targetInfos } = await context.cdp.request('Target.getTargets');
    const target = settings.targetId ? targetInfos.find(item => item.targetId === settings.targetId) : targetInfos[0];
    if (!target) throw new Error('No selected CDP target is available');
    ({ sessionId } = await context.cdp.request('Target.attachToTarget', { targetId: target.targetId, flatten: true }));
    await context.cdp.request('Runtime.evaluate', { expression: `globalThis[${JSON.stringify(marker)}] = 'Codlet cleanup example'`, returnByValue: true }, { sessionId });
    report('active', { ready: true, sessionId, generation: context.plugin.generation });
  },

  async deactivate(cleanup) {
    if (!sessionId) return;
    const owned = sessionId;
    sessionId = undefined;
    let failure;
    try {
      await cleanup.cdp.request('Runtime.evaluate', { expression: `delete globalThis[${JSON.stringify(marker)}]`, returnByValue: true }, { sessionId: owned });
    } catch (error) { failure = error; }
    try {
      await cleanup.cdp.request('Target.detachFromTarget', { sessionId: owned });
    } catch (error) { failure ??= error; }
    report('cleanup', { completed: !failure, remainingMs: cleanup.remainingMs(), error: failure?.message });
    if (failure) throw failure;
  },
};
