import test from 'node:test';
import assert from 'node:assert/strict';
import {shortcutSettingsReferences} from '../frontend/src/adapter/workspace-discovery.js';
const root='app://-/assets/';
test('shortcut settings retain the direct Native graph and follow the current entry through lazy routes',async()=>{
  assert.deepEqual(await shortcutSettingsReferences('import("./keyboard-shortcuts-settings-old.js")',root+'app-initial-old.js',()=>assert.fail('Direct graph needs no additional source'),()=>assert.fail('Direct graph needs no entry')), [root+'keyboard-shortcuts-settings-old.js']);
  const files={
    [root+'index-new.js']:'import("./app-main-new.js")',
    [root+'app-main-new.js']:'["./settings-lazy-routes-new.js"]',
    [root+'settings-lazy-routes-new.js']:'["./keyboard-shortcuts-settings-wrapper.js","./keyboard-shortcuts-settings-impl.js"]',
  },reads=[];
  assert.deepEqual(await shortcutSettingsReferences('',root+'app-initial-new.js',async url=>{reads.push(url);return files[url];},()=>[root+'index-new.js']),[root+'keyboard-shortcuts-settings-wrapper.js',root+'keyboard-shortcuts-settings-impl.js']);
  assert.deepEqual(reads,Object.keys(files));
  await assert.rejects(shortcutSettingsReferences('',root+'app-initial-new.js',url=>files[url],()=>[root+'index-new.js',root+'index-other.js']),{code:'workspace_shortcuts_unavailable'});
});
