'use strict';
const fs = require('node:fs'), path = require('node:path');
module.exports = {
  async activate(context) {
    const spec = JSON.parse(fs.readFileSync(path.join(context.root, 'probe-spec.json'), 'utf8'));
    const expression = fs.readFileSync(path.join(context.root, 'probe.js'), 'utf8');
    const reports = [], { targetInfos } = await context.cdp.request('Target.getTargets');
    for (const target of targetInfos.filter(value => spec.targetIds.includes(value.targetId) && value.type === 'page' && value.url === 'app://-/index.html')) {
      let sessionId;
      const report = { targetId: target.targetId };
      try {
        ({ sessionId } = await context.cdp.request('Target.attachToTarget', { targetId: target.targetId, flatten: true }));
        const reply = await context.cdp.request('Runtime.evaluate', { expression, awaitPromise: true, returnByValue: true }, { sessionId });
        if (reply.exceptionDetails) throw Error(reply.exceptionDetails.exception?.description ?? reply.exceptionDetails.text);
        report.result = reply.result?.value;
      } catch (error) { report.error = String(error.message); }
      finally {
        if (sessionId) try { await context.cdp.request('Target.detachFromTarget', { sessionId }); report.detached = true; }
        catch (error) { report.detachError = String(error.message); }
        reports.push(report);
      }
    }
    fs.writeFileSync(path.join(context.root, 'report.json'), JSON.stringify({
      schema: 1, kind: 'native-readonly-contract-probe', candidate: spec.candidate, residentCoreVersion: spec.residentCoreVersion,
      native: spec.native, reports, completedAt: new Date().toISOString(),
    }, null, 2) + '\n', { flag: 'wx' });
  },
  deactivate() {},
};
