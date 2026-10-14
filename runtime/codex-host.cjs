'use strict';
// Semantic wrappers capture the consuming Host context, so every traffic
// operation uses that owner's broker/grants and generation cancellation.
const { createCodexTraffic, classifyCodexTraffic, readCodexJsonBody, rewrittenCodexJsonBody } = require('../codex/host/codex-traffic.cjs');
function createCodexHost(context) {
  return Object.freeze({ api: 1, traffic: Object.freeze({
    create: compatibility => createCodexTraffic(context, compatibility),
    probe: compatibility => createCodexTraffic(context, compatibility).probe(),
    classify: classifyCodexTraffic,
    readJsonBody: readCodexJsonBody,
    rewriteJsonBody: rewrittenCodexJsonBody,
  }) });
}
module.exports = { createCodexHost };
