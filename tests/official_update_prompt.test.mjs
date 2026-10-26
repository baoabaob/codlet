import test from 'node:test';
import assert from 'node:assert/strict';
import {uiFixture,uiSource,tick} from './support/ui-fixture.mjs';

test('official update dialog returns the checkbox choice and cancellation cleans up its UI',async t=>{
  const f=uiFixture({locale:'zh'});t.after(()=>f.dispose());
  const factory=f.window.eval(uiSource),context={pluginId:'codlet.core.official-update',generation:0,onDeactivate:()=>()=>{}};
  const prompt=factory.confirmOfficialUpdate(context);await tick();
  assert.match(f.document.querySelector('[role=dialog]').textContent,/直接更新官方客户端可能导致 Codlet 不适配/);
  await f.click('不再显示此提示');await f.click('仍要更新');
  assert.deepEqual(JSON.parse(JSON.stringify(await prompt.result)),{accepted:true,suppress:true});assert.equal(f.document.querySelector('[role=dialog]'),null);
  const cancelled=factory.confirmOfficialUpdate(context);await tick();await f.click('取消');assert.equal((await cancelled.result).accepted,false);assert.equal(f.document.querySelector('[role=dialog]'),null);
});
