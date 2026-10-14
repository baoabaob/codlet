// Onboarding may display the new profile's native sign-in/setup UI, but must
// never call that instance ready for tests until all normal gates are met.
export function backendReadiness(result,{onboarding=false}={}){
  if(!result.initialized||!result.fileCredentialStore||!result.readOnlyBackend||!result.desktopAppToolsDisabled||result.chromeInstalled||!result.originRejected)throw Error('Backend isolation checks failed: '+JSON.stringify(result));
  if(!result.authenticated){if(onboarding&&result.authenticated===false)return 'awaiting_authentication';throw Error('Test profile authentication is required');}
  if(result.windowsReadiness!=='ready'){
    if(onboarding&&result.windowsReadiness==='notConfigured')return 'awaiting_sandbox';
    throw Error('Test profile Windows sandbox readiness is required: '+result.windowsReadiness);
  }
  return 'ready';
}

// config/read reloads the file, while windowsSandbox/readiness uses the
// app-server's startup config. Reconnecting a WebSocket does not restart that
// externally owned server. After normal setup, restart the owned pair once.
export function onboardingRestartRequired(result){
  return result.authenticated===true&&result.windowsReadiness==='notConfigured'
    &&['elevated','unelevated'].includes(result.windowsMode);
}
