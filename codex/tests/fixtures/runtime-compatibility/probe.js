// Read-only report sampling. Use build-probe.mjs for controlled model bootstrap.
(()=>{
  const state=globalThis[Symbol.for('codlet.functional.acceptance')]?.inspect();
  const skill=globalThis[Symbol.for('codlet.core.skills.v1')];
  return {phase:state?.phase,checks:state?.checks,host:state?.host,error:state?.error,
    panel:!!document.querySelector('[data-functional-test-panel]'),
    navigationEntries:document.querySelectorAll('[data-codlet-navigation-entry="compatibility.acceptance"]').length,
    reportNodes:document.querySelectorAll('[data-compatibility-acceptance]').length,
    composerLeases:document.querySelectorAll('[data-codlet-composer-action-owner="compatibility.acceptance"]').length,
    skill:skill&&{status:skill.status,error:skill.error}};
})()
