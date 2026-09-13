import assert from 'node:assert/strict';
import {readFileSync} from 'node:fs';
import test from 'node:test';
import {uiFixture,uiSource} from './support/ui-fixture.mjs';
const bootstrap=readFileSync(new URL('../bundled/runtime/bootstrap.js',import.meta.url),'utf8');
for(const world of ['main','isolated'])test(`managed ${world} context synchronously retires official React roots`,async t=>{
  const f=uiFixture();t.after(()=>f.dispose());
  f.window.eval(`(${bootstrap})({world:${JSON.stringify(world)}},(${uiSource}))`);
  const runtime=f.window.__codletRendererV1,owners=[],contexts=[];
  const definition={activate(ctx){const ui=ctx.ui.create();const node=ui.container();ui.mount(node,ui.React.createElement(ui.components.Button,{color:'primary'},'Official'));owners.push(ui);contexts.push(ctx);},deactivate(){}};
  const first=await runtime.activate({id:'test.ui',generation:1},definition);assert.equal(first.ok,true,JSON.stringify(first));
  assert.equal((await runtime.activate({id:'test.ui',generation:2},definition)).ok,true);
  assert.equal(owners[0].signal.aborted,true);assert.equal(owners[1].signal.aborted,false);
  assert.equal(f.document.querySelectorAll('[data-codlet-official-ui]').length,1);
  assert.throws(()=>contexts[0].ui.create(),{code:'plugin_deactivated'});
  assert.equal((await runtime.deactivate('test.ui',2)).ok,true);
  assert.equal(owners[1].signal.aborted,true);assert.equal(f.document.querySelectorAll('[data-codlet-official-ui]').length,0);
  assert.equal(f.document.querySelectorAll('[data-codlet-official-styles]').length,0);
});
