import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { indexSource, parseSourceModel, normalizedSource, indexSnapshot } from '../scripts/lib/native-source-index.mjs';
import { openSourceArchive, snapshotArchive, readSnapshot, relativeSourcePath } from '../scripts/lib/native-source-snapshot.mjs';

const shape = source => {
  const model = parseSourceModel(source);
  return normalizedSource(model.ast.body[0], model);
};
const temporary = t => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'codlet-native-source-'));
  t.after(() => fs.rmSync(root, { recursive: true }));
  return root;
};
function archiveFile(filename, entries) {
  let offset = 0; const files = {}, payloads = [];
  for (const [name, value] of Object.entries(entries)) {
    const data = Buffer.from(value), parts = name.split('/');
    let tree = files;
    for (const part of parts.slice(0, -1)) tree = (tree[part] ??= { files: {} }).files;
    tree[parts.at(-1)] = { size: data.length, offset: String(offset) };
    offset += data.length; payloads.push(data);
  }
  const json = Buffer.from(JSON.stringify({ files }));
  const headerSize = 8 + Math.ceil(json.length / 4) * 4, prefix = Buffer.alloc(16);
  prefix.writeUInt32LE(4, 0); prefix.writeUInt32LE(headerSize, 4); prefix.writeUInt32LE(headerSize - 4, 8); prefix.writeUInt32LE(json.length, 12);
  fs.writeFileSync(filename, Buffer.concat([prefix, json, Buffer.alloc(8 + headerSize - 16 - json.length), ...payloads]));
}

test('alpha normalization preserves lexical binding and reference identity across minified renaming', () => {
  const first = 'function a(x,y){let z=x;return ()=>{let x=y;return z+x+y}}';
  const renamed = 'function renamed(first,second){let cached=first;return ()=>{let first=second;return cached+first+second}}';
  assert.equal(shape(first).hash, shape(renamed).hash);
  assert.notEqual(shape(first).hash, shape('function a(x,y){let z=x;return ()=>{let x=y;return z+x+x}}').hash);
  assert.notEqual(shape('function a(x,y){return x-y}').hash, shape('function a(x,y){return y-x}').hash);
});

test('free globals, property names, captures and distinct external bindings are not erased', () => {
  assert.notEqual(shape('function a(x){return window.get(x)}').hash, shape('function a(x){return document.get(x)}').hash);
  assert.notEqual(shape('function a(x){return x.read()}').hash, shape('function a(x){return x.write()}').hash);
  const a = parseSourceModel('let first,second;function f(){return first+second}');
  const b = parseSourceModel('let left,right;function g(){return left+left}');
  const one = normalizedSource(a.ast.body[1], a), two = normalizedSource(b.ast.body[1], b);
  assert.notEqual(one.hash, two.hash);
  assert.equal(one.dependencies.length, 2); assert.equal(two.dependencies.length, 1);
  assert.notEqual(shape('function f(x){return {x}}').hash, shape('function f(y){return {y}}').hash, 'object keys form the interface');
});

test('parameter destructuring, catch bindings and hoisted references remain scoped', () => {
  assert.equal(shape('function f({get:a},x){try{return a(x)}catch(x){return x.message}}').hash,
    shape('function g({get:read},value){try{return read(value)}catch(error){return error.message}}').hash);
  assert.notEqual(shape('function f(a){return ()=>a}').hash, shape('function f(a){return a=>a}').hash);
  assert.equal(shape('function f(){return x;var x}').hash, shape('function g(){return renamed;var renamed}').hash);
});

test('module index joins declarations, exports, aliases, reads and query getter parameters', () => {
  const source = 'import {factory as make} from "./state.js";var query,derived;function init(){query=make(scope,"key",{enabled:true});derived=make(scope,({get:read})=>read(query));}export{derived as state,derived as alias};';
  const index = indexSource(source, 'webview/assets/app-initial-any.js');
  const query = index.records.find(item => item.local === 'query');
  const derived = index.records.find(item => item.local === 'derived');
  assert.deepEqual(derived.exportNames, ['state', 'alias']);
  assert.equal(derived.calls.find(call => call.callee?.parameter?.path[0] === 'get').arguments[0].binding, query.binding);
  assert.equal(index.imports[0].specifiers[0].imported, 'factory');
  assert.ok(index.bindings.find(item => item.name === 'query').references.some(reference => reference.read));
  assert.ok(derived.start.line > 0); assert.ok(derived.start.column > 0);
});

test('source snapshot binds exact archive bytes and rejects mutated source and path traversal', async t => {
  const root = temporary(t), archive = path.join(root, 'app.asar'), output = path.join(root, 'snapshot');
  archiveFile(archive, {
    'package.json': JSON.stringify({ version: '26.1013.40934', codexBuildNumber: '20770' }),
    'webview/assets/app-initial-a.js': 'export const source="do not execute";',
    '.vite/build/main-a.js': 'throw Error("must never execute");',
    'unrelated.txt': 'not a source input',
  });
  const result = await snapshotArchive({ archive, output, packageFullName: 'OpenAI.Codex_26.1013.4894.0_x64__publisher' });
  assert.equal(result.identity.buildNumber, '20770'); assert.equal(result.identity.packageVersion, '26.1013.4894.0');
  assert.equal(result.files.length, 3); assert.equal(result.provenance.archiveSha256.length, 64);
  assert.equal(readSnapshot(output).files.length, 3);
  await assert.rejects(() => snapshotArchive({ archive, output }), /must be new/);
  fs.appendFileSync(path.join(output, 'sources/webview/assets/app-initial-a.js'), '\n// changed');
  assert.throws(() => readSnapshot(output), /snapshot changed/);
  for (const name of ['../outside', '/absolute', 'a\\b', 'a/../../b', 'C:/outside']) assert.throws(() => relativeSourcePath(name), /Invalid/);
});

test('static dependency traversal retains missing modules and does not execute dynamic imports', async t => {
  const root = temporary(t), archive = path.join(root, 'app.asar'), output = path.join(root, 'snapshot');
  archiveFile(archive, {
    'package.json': '{"version":"1"}',
    'webview/assets/app-initial-a.js': 'import {state} from "./moved-b.js";export {state};import("./unloaded-c.js");',
    'webview/assets/moved-b.js': 'import "./missing-d.js";export const state={kind:"scope"};',
    'webview/assets/unloaded-c.js': 'throw Error("must not execute");',
  });
  await snapshotArchive({ archive, output });
  const index = await indexSnapshot(output);
  assert.equal(index.modules.length, 2);
  assert.deepEqual(index.analysis.missing, ['webview/assets/missing-d.js']);
  assert.deepEqual(index.analysis.unindexed, ['webview/assets/unloaded-c.js']);
  assert.equal(index.modules.find(module => module.path.endsWith('moved-b.js')).records[0].exportNames[0], 'state');
});

test('truncated or linked ASAR inputs fail before extraction', t => {
  const root = temporary(t), filename = path.join(root, 'bad.asar');
  fs.writeFileSync(filename, Buffer.alloc(4)); assert.throws(() => openSourceArchive(filename), /Truncated/);
  archiveFile(filename, { 'package.json': '{}' });
  const reader = openSourceArchive(filename);
  try { reader.entries.get('package.json').link = 'elsewhere'; assert.throws(() => reader.read('package.json'), /Unsupported/); }
  finally { reader.close(); }
});
