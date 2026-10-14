import test from 'node:test';
import assert from 'node:assert/strict';
import {permissionGroups,pluginDependencies} from '../frontend/src/codlet/permissions.js';
import {PERMISSION_COPY} from '../frontend/src/codlet/messages.js';
const cap=(name,scope='target')=>({name,api:1,scope});
test('every permission appears once in a small readable category set',()=>{
  const requested=Object.keys(PERMISSION_COPY),groups=permissionGroups(requested);
  assert.equal(groups.length,5);assert.deepEqual(groups.flatMap(g=>g.permissions).sort(),requested.sort());
});
test('dependency summaries collapse interfaces into plugins and omit Core and self',()=>{
  const nav=cap('navigation'),read=cap('read'),write=cap('write'),own=cap('my.host','runtime');
  const manifest={id:'dev.lab',renderer:{},host:{provides:[own],requires:[cap('codlet.core.services','runtime')]},requires:[nav,read,write,own,cap('codlet.core.services','runtime'),cap('codlet.runtime.ping')]};
  const plugins=[{id:'ui',active:true,providedCapabilities:[nav]},{id:'desktop',active:false,providedCapabilities:[read,write]}];
  const result=pluginDependencies(manifest,plugins);
  assert.deepEqual(result.plugins.map(r=>[r.plugin.id,r.available]),[['ui',true],['desktop',false]]);assert.equal(result.missing,false);
  assert.equal(pluginDependencies(manifest,plugins.slice(0,1)).missing,true);
});
