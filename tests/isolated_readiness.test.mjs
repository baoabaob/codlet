import test from 'node:test';
import assert from 'node:assert/strict';
import {backendReadiness,onboardingRestartRequired} from '../scripts/isolated-readiness.mjs';
const ready={initialized:true,authenticated:true,fileCredentialStore:true,readOnlyBackend:true,desktopAppToolsDisabled:true,windowsReadiness:'ready',chromeInstalled:false,originRejected:true};
test('normal startup still requires authentication and sandbox readiness',()=>{
  assert.equal(backendReadiness(ready),'ready');
  assert.throws(()=>backendReadiness({...ready,authenticated:false}),/authentication/);
  assert.throws(()=>backendReadiness({...ready,windowsReadiness:'notConfigured'}),/sandbox readiness/);
});
test('onboarding states remain explicitly unready until both requirements hold',()=>{
  assert.equal(backendReadiness({...ready,authenticated:false,windowsReadiness:'notConfigured'},{onboarding:true}),'awaiting_authentication');
  assert.equal(backendReadiness({...ready,windowsReadiness:'notConfigured'},{onboarding:true}),'awaiting_sandbox');
  assert.equal(backendReadiness(ready,{onboarding:true}),'ready');
  assert.throws(()=>backendReadiness({...ready,windowsReadiness:'unexpected'},{onboarding:true}),/sandbox readiness/);
});
test('onboarding cannot bypass backend isolation checks',()=>{
  for(const key of ['initialized','fileCredentialStore','readOnlyBackend','desktopAppToolsDisabled','originRejected'])assert.throws(()=>backendReadiness({...ready,[key]:false,authenticated:false},{onboarding:true}),/isolation checks/);
  assert.throws(()=>backendReadiness({...ready,chromeInstalled:true},{onboarding:true}),/isolation checks/);
});

test('only a saved sandbox mode with stale startup readiness requests a restart',()=>{
  for(const windowsMode of ['elevated','unelevated'])assert.equal(onboardingRestartRequired({...ready,windowsReadiness:'notConfigured',windowsMode}),true);
  for(const windowsReadiness of ['ready','updateRequired','checkFailed'])assert.equal(onboardingRestartRequired({...ready,windowsReadiness,windowsMode:'elevated'}),false);
  assert.equal(onboardingRestartRequired({...ready,windowsReadiness:'notConfigured',windowsMode:null}),false);
  assert.equal(onboardingRestartRequired({...ready,authenticated:false,windowsReadiness:'notConfigured',windowsMode:'elevated'}),false);
});
