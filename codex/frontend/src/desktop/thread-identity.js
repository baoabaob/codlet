const localId=value=>typeof value==='string'&&value.length>0&&value.length<=256?value:null;

// Native retains background agent conversations in the same cache as ordinary
// tasks. Their source/ancestry, rather than their title or running state, tells
// consumers whether they are child tasks.
export function threadIdentity(thread) {
  const source=thread?.source;
  const subagent=source&&typeof source==='object'&&!Array.isArray(source)&&Object.hasOwn(source,'subAgent');
  const parent=thread?.parentThreadId??thread?.subagentParentThreadId??(subagent?source.subAgent?.thread_spawn?.parent_thread_id:null);
  return {
    isSubagent:parent!=null||!!subagent||thread?.isSubagentSource===true||thread?.threadSource==='subagent',
    parentThreadId:localId(parent),
  };
}
