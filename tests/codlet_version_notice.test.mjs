import assert from 'node:assert/strict';
import test from 'node:test';
import {versionWarnings} from '../frontend/src/codlet/versions.js';

test('publication evidence never claims this machine has an installable update or an incompatible running client',()=>{
  const clientStatus={source:'official-public-manifest',status:'unmatched',newerReleasePublished:true,matchesRunningClient:true,matchesPublishedClient:false};
  assert.deepEqual(versionWarnings({clientStatus}),[]);
  assert.deepEqual(versionWarnings({clientStatus:{...clientStatus,status:'matched',newerReleasePublished:false}}),[]);
  assert.deepEqual(versionWarnings({clientStatus:{...clientStatus,newerReleasePublished:false,matchesRunningClient:false}}),['This running client version has not been verified with Codlet.']);
});

test('a known newer Codlet stays visible while rechecking or recovering a failed download',()=>{
  const update={configured:true,currentVersion:'0.1.0',candidate:{id:'newer-release',version:'0.2.0'}};
  for(const phase of ['available','checking','downloading','downloaded','installRequested','failed']) {
    assert.ok(versionWarnings({update:{...update,phase},clientStatus:{status:'matched'}}).includes('A Codlet update is available.'),phase);
  }
});

test('development, unchecked and unavailable version data are not mislabeled as an outdated release',()=>{
  for(const phase of ['development','idle','checking','upToDate','failed']) {
    assert.deepEqual(versionWarnings({update:{configured:phase!=='development',currentVersion:'0.1.0',phase,candidate:null},clientStatus:{status:'unknown'}}),[],phase);
  }
  assert.deepEqual(versionWarnings({update:null,clientStatus:{status:'matched'}}),[]);
});

test('only an actual running-version mismatch produces a client notice',()=>{
  assert.deepEqual(versionWarnings({update:{configured:false,phase:'development'},clientStatus:{matchesRunningClient:false}}),['This running client version has not been verified with Codlet.']);
  assert.deepEqual(versionWarnings({clientStatus:{matchesRunningClient:true}}),[]);
});
