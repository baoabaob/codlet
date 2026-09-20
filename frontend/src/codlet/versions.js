export const updatePhases=['development','idle','checking','upToDate','available','downloading','downloaded','installRequested','failed'];
export const busyUpdatePhases=['checking','downloading','installRequested'];
export const installPhases=['queued','downloading','installing','checkingStatus','updated','upToDate','reviewRequired','failed'];
export const validPluginInstall=value=>Number.isSafeInteger(value?.id)&&value.id>=0&&typeof value.running==='boolean'&&Array.isArray(value.items)&&value.items.length<=128&&new Set(value.items.map(i=>i.pluginId)).size===value.items.length&&value.items.every(i=>typeof i?.pluginId==='string'&&typeof i.versionKey==='string'&&installPhases.includes(i.phase));
export const validUpdate=value=>typeof value?.currentVersion==='string'&&typeof value.configured==='boolean'&&updatePhases.includes(value.phase);
export const validOfficialUpdate=value=>value&&typeof value.available==='boolean'&&typeof value.restartPreserved==='boolean'&&typeof value.isUpdateReady==='boolean'&&['idle','checking','downloading','ready','installing'].includes(value.phase)&&['idle','downloading','preparing','installing','failed'].includes(value.combinedPhase)&&(value.error===null||typeof value.error==='string');
export const validPluginUpdates=value=>['idle','checking','completed','failed'].includes(value?.phase)&&(value.checkedAt===null||Number.isSafeInteger(value.checkedAt))&&value.plugins&&typeof value.plugins==='object'&&!Array.isArray(value.plugins)&&Object.values(value.plugins).every(item=>item&&typeof item.versionKey==='string'&&['unknown','upToDate','available','failed'].includes(item.status)&&(item.status!=='available'||typeof item.releaseTag==='string'&&typeof item.releaseUrl==='string'));
export function versionWarnings(state){
  const notices=[],update=state.update,client=state.clientStatus;
  // The Core retains a confirmed candidate during rechecks and failed
  // downloads. Those transitions do not make the installed version current.
  if(update?.configured&&update.candidate?.version&&['available','checking','downloading','downloaded','installRequested','failed'].includes(update.phase))notices.push('A Codlet update is available.');
  if(client?.matchesRunningClient===false)notices.push('This running client version has not been verified with Codlet.');
  return notices;
}
const interval=value=>Number.isSafeInteger(value)&&value>=300&&value<=86400;
export function validateSettings(reply){
  const v=reply?.values,e=reply?.effective,d=reply?.defaults,a=reply?.availability;
  if(reply?.schema!==1||!Number.isSafeInteger(reply.revision)||reply.revision<0||typeof v?.automaticUpdateChecks!=='boolean'||typeof v.checkPluginUpdatesOnStartup!=='boolean'||typeof v.showPluginTags!=='boolean'||
    !(v.updateCheckIntervalSeconds===null||interval(v.updateCheckIntervalSeconds))||!(v.localSourceAutoReload===null||typeof v.localSourceAutoReload==='boolean')||
    !interval(d?.updateCheckIntervalSeconds)||typeof d.localSourceAutoReload!=='boolean'||typeof a?.updateChecks!=='boolean'||typeof a.pluginUpdateChecks!=='boolean'||typeof a.localSourceWatch!=='boolean'||e?.checkPluginUpdatesOnStartup!==v.checkPluginUpdatesOnStartup||
    e?.automaticUpdateChecks!==v.automaticUpdateChecks||e.showPluginTags!==v.showPluginTags||e.updateCheckIntervalSeconds!==(v.updateCheckIntervalSeconds??d.updateCheckIntervalSeconds)||e.localSourceAutoReload!==(v.localSourceAutoReload??d.localSourceAutoReload))throw new Error('Settings are unavailable or incomplete.');
  return reply;
}
