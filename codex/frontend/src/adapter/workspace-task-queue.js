// A hidden backing document can still own the visible native window. Yield
// between continuous commits so the host gets a chance to process input.
export function createWorkspaceTaskQueue({microtask=queueMicrotask,channel=()=>new MessageChannel()}={}) {
  let first=true,epoch=0,sequence=0,ports;
  const callbacks=new Map();
  return {
    post(callback){
      const current=epoch;
      if(first){first=false;microtask(()=>{if(current===epoch)callback();});return;}
      if(!ports){
        ports=channel();ports.port1.onmessage=event=>{const item=callbacks.get(event.data);callbacks.delete(event.data);item?.();};
        ports.port1.unref?.();ports.port2.unref?.();
      }
      const id=++sequence;callbacks.set(id,()=>{if(current===epoch)callback();});ports.port2.postMessage(id);
    },
    clear(){epoch++;first=true;callbacks.clear();ports?.port1.close();ports?.port2.close();ports=undefined;},
  };
}
