'use strict';
const fs = require('node:fs'), path = require('node:path');
let pending;
module.exports = {
  activate(context) {
    // Bounded acceptance worker only. It uses Core-owned CDP sessions and adds
    // no AppServer/consumer connection. Normal retirement reclaims these sessions.
    pending = setTimeout(async () => {
      const output = path.join(context.root, 'report.json');
      const sessions = [];
      try {
        const { targetInfos } = await context.cdp.request('Target.getTargets');
        let result, targetId;
        for (const target of targetInfos.filter(target => target.type === 'page' && target.url === 'app://-/index.html')) {
          const { sessionId } = await context.cdp.request('Target.attachToTarget', { targetId: target.targetId, flatten: true }); sessions.push(sessionId);
          for (let attempt = 0; attempt < 40 && !context.signal.aborted; attempt++) {
            const probe = await context.cdp.request('Runtime.evaluate', { expression: 'globalThis[Symbol.for("codlet.workspace.audit")] ? globalThis[Symbol.for("codlet.workspace.audit")].inspect() : null', awaitPromise: true, returnByValue: true }, { sessionId });
            if (probe.exceptionDetails) { result = { status: 'failed', exception: probe.exceptionDetails.exception?.description ?? probe.exceptionDetails.text }; break; }
            if (probe.result.value?.available) {
              if (probe.result.value.visibilityState !== 'visible') try { await context.cdp.request('Page.bringToFront', {}, { sessionId }); } catch {}
              targetId = target.targetId;
              await context.cdp.request('Runtime.evaluate', { expression: 'void globalThis[Symbol.for("codlet.workspace.audit")].run(); "started"', returnByValue: true }, { sessionId });
              for (let poll = 0; poll < 90 && !context.signal.aborted; poll++) {
                const evaluated = await context.cdp.request('Runtime.evaluate', { expression: '(()=>{const audit=globalThis[Symbol.for("codlet.workspace.audit")];return audit.result ?? {status:"running",phase:audit.phase,transcriptStates:audit.transcriptStates};})()', returnByValue: true }, { sessionId });
                result = evaluated.result?.value ?? { status: 'failed', exception: evaluated.exceptionDetails?.exception?.description };
                if (result.status !== 'running') break;
                await new Promise(resolve => setTimeout(resolve, 500));
              }
              break;
            }
            if (probe.result.value?.auxiliary) break;
            await new Promise(resolve => setTimeout(resolve, 100));
          }
          if (targetId || result?.status === 'failed') break;
        }
        fs.writeFileSync(output, JSON.stringify({ targetId, result: result ?? { status: 'no-main-surface' } }, null, 2));
      } catch (error) { fs.writeFileSync(output, JSON.stringify({ result: { status: 'failed', code: error.code, message: error.message } }, null, 2)); }
      finally { for (const sessionId of sessions) try { await context.cdp.request('Target.detachFromTarget', { sessionId }); } catch {} }
    }, 200);
  },
  deactivate() { clearTimeout(pending); },
};
