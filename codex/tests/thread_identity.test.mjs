import test from 'node:test';
import assert from 'node:assert/strict';
import {threadIdentity} from '../frontend/src/desktop/thread-identity.js';
import {createLoadedThreads} from '../frontend/src/desktop/loaded-threads.js';

test('Native ancestry distinguishes child agents from untitled, forked and agent-created standalone tasks',()=>{
  for(const value of [{parentThreadId:'root-task'},{source:{subAgent:{thread_spawn:{parent_thread_id:'root-task',agent_path:'/root/review'}}}},{subagentParentThreadId:'root-task',isSubagentSource:true}])
    assert.deepEqual(threadIdentity(value),{isSubagent:true,parentThreadId:'root-task'});
  for(const value of [{source:{subAgent:'review'}},{threadSource:'subagent'}])assert.equal(threadIdentity(value).isSubagent,true);
  for(const value of [{title:null},{title:'Review',source:'vscode',threadSource:'agent_created_thread'},{forkedFromId:'original-task',threadSource:'agent_forked_thread'}])
    assert.deepEqual(threadIdentity(value),{isSubagent:false,parentThreadId:null});
});

test('loaded summaries expose child identity and publish a metadata-only ancestry change',()=>{
  const thread={id:'child-task',title:null,hostId:'local',resumeState:'resumed',requests:[],threadRuntimeStatus:{type:'active'}},events=[];
  const loaded=createLoadedThreads({getCachedConversations:()=>[thread],getConversation:()=>thread},event=>events.push(event),'fixture',{read:()=>true});
  try{
    assert.equal(loaded.read().threads[0].isSubagent,false);
    thread.source={subAgent:{thread_spawn:{parent_thread_id:'root-task'}}};loaded.refresh(thread.id);loaded.refresh(thread.id);
    assert.equal(events.length,1);assert.equal(events[0].thread.isSubagent,true);assert.equal(events[0].thread.parentThreadId,'root-task');
    assert.equal(events[0].thread.working,true);assert.equal('source' in events[0].thread,false);
    assert.equal(loaded.read({threadId:thread.id}).threads[0].isSubagent,true);
  }finally{loaded.dispose();}
});
