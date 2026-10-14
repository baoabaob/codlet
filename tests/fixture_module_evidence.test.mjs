import test from 'node:test';import assert from 'node:assert/strict';import vm from 'node:vm';import {readFileSync}from'node:fs';
import {stampFixtureModule,fixtureEvidenceSymbol}from'../scripts/fixture-module-evidence.mjs';
import {coreModuleIds,coreModulePath}from'../scripts/prepare-online-core.mjs';
const identity={id:'a'.repeat(64),version:'1.0.0-rc.2'};
test('owned candidate factory stamps execute and retain only bounded plain counters',()=>{
 const scope=vm.createContext({});const factory=vm.runInContext(stampFixtureModule('renderer-codex-sdk','(context)=>({owner:context.owner})',identity),scope);
 assert.equal(scope[Symbol.for(fixtureEvidenceSymbol)],undefined);assert.equal(factory({owner:'owned'}).owner,'owned');
 const evidence=scope[Symbol.for(fixtureEvidenceSymbol)];assert.equal(evidence.counts['renderer-codex-sdk:factory'],1);assert.deepEqual(Object.keys(evidence),['api','id','version','counts']);
 const reused=vm.runInContext(stampFixtureModule('renderer-bootstrap','()=>({ok:true,reused:true})',identity),scope);reused();assert.equal(evidence.counts['renderer-bootstrap:factory'],undefined);
});
test('provider getter exports and Native handoff methods preserve results and this identity through fixture wrappers',async()=>{
 const scope=vm.createContext({module:{exports:{}}});vm.runInContext(stampFixtureModule('client-source',`const install=()=>Object.freeze({ready(){return true},resume(){return this.ready()},confirmTakeover(){return true}});Object.defineProperty(module.exports,'installElectronTraffic',{enumerable:true,get:()=>install})`,identity),scope);
 const runtime=scope.module.exports.installElectronTraffic();assert.equal(runtime.resume(),true);assert.equal(runtime.confirmTakeover(),true);
 const counts=scope[Symbol.for(fixtureEvidenceSymbol)].counts;assert.equal(counts['client-source:factory:installElectronTraffic'],1);assert.equal(counts['client-source:runtime:resume'],1);assert.equal(counts['client-source:runtime:ready'],1);
});
test('all actual generated Core components remain valid scripts after acceptance-only instrumentation',()=>{
 for(const id of ['client-source',...coreModuleIds]){const path=id==='client-source'?'runtime/core-modules/client-source.cjs':coreModulePath(id);const source=readFileSync(new URL('../'+path,import.meta.url),'utf8');assert.doesNotThrow(()=>new vm.Script(stampFixtureModule(id,source,identity),{filename:id}),id);}
});
