import assert from 'node:assert/strict';
import test from 'node:test';
import fs from 'node:fs';
import path from 'node:path';
import vm from 'node:vm';
import crypto from 'node:crypto';
import {createRequire} from 'node:module';
const require=createRequire(import.meta.url);
const {probeOwnAncestors}=require('../scripts/native-core/foreground-host-metadata.cjs');

test('metadata probe reports this process binding identities and only its cwd ancestor walk',()=>{
  const cwd=process.cwd(),report=probeOwnAncestors({root:cwd});
  assert.equal(report.cwd,cwd);assert.equal(report.steps[0].literal,cwd);assert.equal(report.readOnly,true);
  assert.equal(report.bindings.fsIsProcessBuiltin,true);assert.equal(report.bindings.pathIsProcessBuiltin,true);
  assert.equal(report.methods.lstatSync.sourceSha256.length,64);assert.ok(report.steps.length>1);
  for(let i=1;i<report.steps.length;i++)assert.equal(report.steps[i].literal,path.dirname(report.steps[i-1].literal));
});
test('metadata probe refuses another root rather than inspecting an arbitrary path',()=>{
  assert.throws(()=>probeOwnAncestors({root:path.dirname(process.cwd())}),/restricted to this Host cwd/);
});
test('metadata failure preserves the passed path and complete native error without following it',()=>{
  const calls=[],failure=Object.assign(new Error('EISDIR diagnostic'),{code:'EISDIR',path:'X:',syscall:'lstat',errno:-4068});
  const io={lstatSync(value){calls.push(value);assert.doesNotMatch(value,/^(?:\\\\\?\\)?[a-z]:$/i);throw failure;},statSync(){assert.fail('stat after failed lstat');},realpathSync(){assert.fail('realpath after failed lstat');}};
  const module={exports:{}},source=fs.readFileSync(new URL('../scripts/native-core/foreground-host-metadata.cjs',import.meta.url),'utf8');
  vm.runInNewContext(source,{module,__filename:'probe.cjs',process:{cwd:()=>String.raw`X:\sample`,versions:{node:'fixture',uv:'fixture'},platform:'win32',execPath:'X:/fixture-node',pid:1,getBuiltinModule:name=>name==='fs'?io:path.win32},require:name=>name==='node:crypto'?crypto:name.endsWith('fs')?io:path.win32});
  const report=module.exports.probeOwnAncestors();const result=report.steps[0].variants[0];
  assert.equal(result.input,String.raw`X:\sample`);assert.equal(result.lstat.error.path,'X:');assert.equal(result.lstat.error.stack,failure.stack);
  assert.equal(result.lstat.error.errno,-4068);assert.ok(result.followingMethodsSkipped);assert.ok(calls.length>0);
});
