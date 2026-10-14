import assert from 'node:assert/strict';
import test from 'node:test';
import fs from 'node:fs';
import path from 'node:path';
import vm from 'node:vm';
import os from 'node:os';
import {createRequire} from 'node:module';
const require=createRequire(import.meta.url);
const {createCollector}=require('../scripts/native-core/foreground-collector.cjs');

const source=fs.readFileSync(new URL('../scripts/native-core/foreground-collector.cjs',import.meta.url),'utf8');
function fixture({nativeWindows=false,link=null,notDirectory=null,rootError=null,posix=false}={}){
  const calls=[],output=posix?'/sample/capture':'X:/sample/capture';
  const known=new Set(posix?['/sample/capture','/sample','/']:['X:/sample/capture','X:/sample','X:/']);
  const io={lstatSync(value){
    calls.push(value);const normalized=value.replace(/\\/g,'/');
    if(normalized==='X:')throw Object.assign(Error("EISDIR lstat 'X:'"),{code:'EISDIR'});
    if(normalized==='X:/'&&rootError)throw Object.assign(Error('root inspection denied'),{code:rootError});
    if(!known.has(normalized))throw Error('Unexpected filesystem path: '+value);
    return{isDirectory:()=>normalized!==notDirectory,isSymbolicLink:()=>normalized===link};
  }};
  // Reproduce the slash-normalized Host path contract: unlike path.win32,
  // dirname('X:/sample') is 'X:' and dirname('X:/') is also 'X:'.
  const hostPath=nativeWindows?path.win32:{resolve:value=>value.replace(/\\/g,'/'),dirname:path.posix.dirname};
  const module={exports:{}};
  vm.runInNewContext(source,{module,require:name=>{
    if(name==='node:fs')return io;if(name==='node:path')return hostPath;
    if(name==='./foreground-page.cjs')return{installForegroundObserver(){throw Error('No page probe allowed');}};
    throw Error('Unexpected dependency');
  }});
  const create=()=>module.exports.createCollector({cdp:{request(){throw Error('No CDP request allowed');}},sessionId:'session',targetId:'target',sampleId:'sample',markerKey:'marker',nonce:'nonce',outputDirectory:output});
  return{create,calls};
}

test('slash-normalized Host checks the volume root without visiting the drive-relative path',()=>{
  const f=fixture();assert.doesNotThrow(f.create);
  assert.deepEqual(f.calls,['X:/sample/capture','X:/sample','X:/']);
});
test('native Windows path traversal still checks every directory including its root',()=>{
  const f=fixture({nativeWindows:true});assert.doesNotThrow(f.create);
  assert.deepEqual(f.calls.map(p=>p.replace(/\\/g,'/')),['X:/sample/capture','X:/sample','X:/']);
});
test('the POSIX root is still verified',()=>{
  const f=fixture({posix:true});assert.doesNotThrow(f.create);assert.deepEqual(f.calls,['/sample/capture','/sample','/']);
});
test('symlinked output, intermediate directory and volume root all remain rejected',()=>{
  for(const link of ['X:/sample/capture','X:/sample','X:/'])assert.throws(fixture({link}).create,/Plain output directory required/);
});
test('non-directory ancestry and real root inspection errors are not skipped or swallowed',()=>{
  assert.throws(fixture({notDirectory:'X:/sample'}).create,/Plain output directory required/);
  for(const rootError of ['EISDIR','EACCES'])assert.throws(fixture({rootError}).create,{code:rootError});
});

function realDirectory(t){
  const directory=fs.mkdtempSync(path.join(os.tmpdir(),'codlet-namespaced-metadata-'));
  t.after(()=>{assert.equal(path.dirname(path.resolve(directory)),path.resolve(os.tmpdir()));assert.ok(path.basename(directory).startsWith('codlet-namespaced-metadata-'));fs.rmSync(directory,{recursive:true,maxRetries:10,retryDelay:20});});
  return directory;
}
const construct=outputDirectory=>createCollector({cdp:{request(){assert.fail('No client access allowed');}},sessionId:'s',targetId:'t',sampleId:'offline',markerKey:'m',nonce:'n',outputDirectory});

test('real Windows Node filesystem accepts a namespaced output without the broken namespaced volume-root call',{skip:process.platform!=='win32'},t=>{
  const directory=realDirectory(t),namespaced=path.toNamespacedPath(directory);
  assert.ok(namespaced.startsWith('\\\\?\\'));
  assert.doesNotThrow(()=>construct(namespaced));
});

test('real Windows junction remains rejected inside a namespaced ancestor chain',{skip:process.platform!=='win32'},t=>{
  const directory=realDirectory(t),actual=path.join(directory,'actual'),link=path.join(directory,'linked');
  fs.mkdirSync(actual);fs.mkdirSync(path.join(actual,'capture'));fs.symlinkSync(actual,link,'junction');
  assert.throws(()=>construct(path.toNamespacedPath(path.join(link,'capture'))),/Plain output directory required/);
});
