import test from 'node:test';
import assert from 'node:assert/strict';
import {transcriptImplementationReference,transcriptModuleReferences} from '../frontend/src/adapter/workspace-discovery.js';
const root='app://-/assets/',initial=root+'app-initial-new.js',wrapper=root+'local-conversation-thread-wrapper.js',inner=root+'local-conversation-thread-inner.js';
const source='import{view,initialize}from"./local-conversation-thread-inner.js";initialize();export{view as LocalConversationSideChatTab};',implementation='function content(){return ["trackReadState","retainActiveInterest"]}';

test('transcript follows the wrapper export and its own implementation initializer',async()=>{
  const files={[wrapper]:source,[inner]:implementation},reads=[];
  assert.deepEqual(await transcriptModuleReferences('import("./local-conversation-thread-wrapper.js")',initial,async url=>{reads.push(url);return files[url];}),{wrapper,implementation:inner});
  assert.deepEqual(reads,[wrapper,inner]);
  reads.length=0;
  assert.deepEqual(await transcriptModuleReferences('["./local-conversation-thread-wrapper.js","./local-conversation-thread-inner.js"]',initial,async url=>{reads.push(url);return files[url];}),{wrapper,implementation:inner});
  assert.deepEqual(reads,[wrapper,inner]);
});

test('transcript rejects uninitialized, ambiguous, foreign and unrelated wrapper dependencies',async()=>{
  for(const changed of [source.replace('initialize();',''),source.replace('initialize();','view();').replace('{view,initialize}','{initialize}'),source.replace('initialize();','foreign();'),source.replace('./local-conversation-thread-inner.js','https://example.com/local-conversation-thread-inner.js'),source+'export{other as LocalConversationSideChatTab}'])
    assert.equal(transcriptImplementationReference(changed,wrapper),null);
  const read=url=>url===wrapper?source:url===inner?'function unrelated(){}':implementation;
  await assert.rejects(transcriptModuleReferences('"./local-conversation-thread-wrapper.js"',initial,read),{code:'workspace_transcript_unavailable'});
  await assert.rejects(transcriptModuleReferences('["./local-conversation-thread-wrapper.js","./local-conversation-thread-decoy.js"]',initial,url=>url===wrapper?source:implementation),{code:'workspace_transcript_unavailable'});
});
