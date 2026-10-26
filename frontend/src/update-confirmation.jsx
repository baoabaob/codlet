import * as React from 'react';

// Core owns this prompt even when the management page is closed or disabled.
export function officialUpdateConfirmation(ui) {
  const {components:C}=ui,container=ui.container(),overlay=ui.container();
  const chinese=/^zh(?:-|$)/i.test(document.documentElement.lang||navigator.language||'en');
  const text=chinese?{
    title:'更新官方客户端',message:'直接更新官方客户端可能导致 Codlet 不适配，是否仍要更新？',
    suppress:'不再显示此提示',cancel:'取消',continue:'仍要更新',
  }:{title:'Update the official client',message:'Updating the official client directly may make Codlet incompatible. Update anyway?',
    suppress:'Don’t show this again',cancel:'Cancel',continue:'Update anyway'};
  let settled=false,resolve;
  const result=new Promise(done=>{resolve=done;});
  function finish(accepted=false,suppress=false){
    if(settled)return;settled=true;
    queueMicrotask(()=>{try{ui.dispose();}finally{resolve({accepted,suppress:accepted&&suppress});}});
  }
  function Prompt(){
    const [suppress,setSuppress]=React.useState(false);
    return <C.Dialog.Root open onOpenChange={open=>{if(!open)finish();}}><C.Dialog.Portal>
      <C.Dialog.Overlay className="codlet-native-update-overlay"/>
      <C.Dialog.Content className="codlet-native-update-dialog" onPointerDownOutside={event=>event.preventDefault()}>
        <C.Dialog.Title className="codlet-native-update-title">{text.title}</C.Dialog.Title>
        <C.Dialog.Description className="codlet-native-update-description">{text.message}</C.Dialog.Description>
        <C.Checkbox checked={suppress} onCheckedChange={value=>setSuppress(value===true)} label={text.suppress}/>
        <div className="codlet-native-update-actions"><C.Button color="secondary" variant="soft" onClick={()=>finish()}>{text.cancel}</C.Button><C.Button color="primary" onClick={()=>finish(true,suppress)}>{text.continue}</C.Button></div>
      </C.Dialog.Content>
    </C.Dialog.Portal></C.Dialog.Root>;
  }
  try{ui.mountReact(container,<Prompt/>,{sync:true,overlay,scope:{contains:node=>container.contains(node)||overlay.contains(node)}});}
  catch(error){ui.dispose();throw error;}
  return {result,dispose:()=>finish()};
}
