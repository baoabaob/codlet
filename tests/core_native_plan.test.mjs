import test from 'node:test';
import assert from 'node:assert/strict';
import {auditedVersions,preflightBlockers} from '../scripts/prepare-core-native-run.mjs';
const valid={labBinaryPresent:true,officialCliPresent:true,officialCliSignature:'Valid'};
test('native preflight refuses unreviewed versions and mismatched identities',()=>{
  const packages=[{Version:'26.1007.2314.0',PackageFullName:'OpenAI.Codex_26.1007.2314.0_x64__2p2nqsd0c76g0'}];
  assert.ok(preflightBlockers(packages,['26.915.4065.0'],valid).includes('installed_package_ipc_isolation_not_reviewed'));
  assert.ok(preflightBlockers([{...packages[0],PackageFullName:'different'}],['26.1007.2314.0'],valid).includes('installed_package_ipc_isolation_not_reviewed'));
});
test('static preflight cannot claim process, target or data ownership',()=>{
  const reasons=preflightBlockers([{Version:'1.2.3.0',PackageFullName:'OpenAI.Codex_1.2.3.0_x64__2p2nqsd0c76g0'}],['1.2.3.0'],valid);
  assert.deepEqual(reasons,['fresh_profile_and_backend_effective_config_not_verified','run_pid_target_and_synthetic_data_not_verified']);
});
test('preflight reads the literal allowlist and fails closed on unknown source',()=>{
  assert.deepEqual(auditedVersions('const AUDITED_PACKAGE_VERSION: &str = "1.2.3.0";\nconst AUDITED_PACKAGE_VERSIONS: &[&str] = &[AUDITED_PACKAGE_VERSION,"2.3.4.0",];'),['1.2.3.0','2.3.4.0']);
  assert.throws(()=>auditedVersions(''),/Cannot identify/);
  assert.ok(preflightBlockers([],[],{labBinaryPresent:false,officialCliPresent:false}).includes('installed_package_not_unique'));
});
