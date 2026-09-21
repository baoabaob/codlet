import assert from 'node:assert/strict';
import {spawnSync} from 'node:child_process';
import {fileURLToPath} from 'node:url';
import test from 'node:test';

test('a retained isolated runtime releases its lazy UI factory after its last owner retires',()=>{
  const result=spawnSync(process.execPath,['--expose-gc',fileURLToPath(new URL('./support/lazy-ui-retention.mjs',import.meta.url))],{encoding:'utf8',timeout:15000,windowsHide:true});
  assert.equal(result.status,0,result.stderr||result.stdout);
  assert.match(result.stdout,/lazy UI lifecycle passed/);
});
