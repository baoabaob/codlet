'use strict';

const fs = require('node:fs');
const path = require('node:path');
const { setTimeout: delay } = require('node:timers/promises');

module.exports = {
  async activate(context) {
    const settingsPath = path.join(__dirname, '..', 'settings.json');
    const settings = fs.existsSync(settingsPath) ? JSON.parse(fs.readFileSync(settingsPath, 'utf8')) : {};
    const start = performance.now();
    const budget = reserve => Math.max(1, Math.min(4000, Math.floor(start + reserve - performance.now())));
    const call = (method, params = {}, sessionId, reserve = 4000) =>
      context.cdp.request(method, params, { ...(sessionId ? { sessionId } : {}), timeoutMs: budget(reserve) });
    let sessionId;
    let subscription;
    let primary;
    let result;
    const events = [];
    try {
      let target;
      while (!target) {
        const { targetInfos } = await call('Target.getTargets');
        target = settings.targetId ? targetInfos.find(item => item.targetId === settings.targetId)
          : targetInfos.find(item => item.type === 'page') || targetInfos[0];
        if (target) break;
        if (performance.now() - start >= 3500) throw new Error('No selected CDP target became available');
        await delay(50, undefined, { signal: context.signal });
      }
      ({ sessionId } = await call('Target.attachToTarget', { targetId: target.targetId, flatten: true }));
      subscription = await context.cdp.subscribe({ scope: 'session', sessionId }, event => {
        if (events.length < 16) events.push(event);
      });
      await call('Runtime.enable', {}, sessionId);
      const expression = settings.expression ?? "typeof document === 'object' ? document.title : 'No document in this target'";
      const evaluation = await call('Runtime.evaluate', { expression, returnByValue: true }, sessionId);
      result = { ready: true, targetId: target.targetId, sessionId, evaluation, events };
    } catch (error) { primary = error; }
    finally {
      // A raw plugin owns its CDP sessions and side effects. Cleanup happens
      // before returning from activate; shutdown admits no new Core calls.
      if (!context.signal.aborted) {
        try { if (subscription) await subscription.unsubscribe(); }
        catch (error) { primary ??= error; }
        try { if (sessionId) await call('Target.detachFromTarget', { sessionId }, undefined, 4500); }
        catch (error) { primary ??= error; }
      }
    }
    if (settings.report && !context.signal.aborted) {
      const report = primary ? { ready: false, error: { code: primary.code, message: primary.message } } : { ...result, unsubscribed: true, detached: true };
      fs.writeFileSync(path.resolve(context.root, settings.report), JSON.stringify(report, null, 2));
    }
    if (primary) throw primary;
  },
  // The demonstration releases its CDP resources before activate returns.
  deactivate() {},
};
