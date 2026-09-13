let React,h,C,ui;
function Example(){
  const [value,setValue]=React.useState(0),[enabled,setEnabled]=React.useState(true),[busy,setBusy]=React.useState(false),[confirm,setConfirm]=React.useState(false);
  ui.useEscCloseStack(confirm,()=>setConfirm(false));
  React.useEffect(()=>{if(!busy)return;const timer=setTimeout(()=>{setValue(v=>v+1);setBusy(false);},500);return()=>clearTimeout(timer);},[busy]);
  return <section aria-label="Official UI controls" style={{padding:32,maxWidth:760,margin:'0 auto',display:'flex',flexDirection:'column',gap:16}}>
    <h1>Official UI controls</h1><p>Counter: {value}</p>
    <C.Switch checked={enabled} onCheckedChange={setEnabled} label="Enabled"/>
    <div style={{display:'flex',flexWrap:'wrap',gap:8}}>
      <C.Button color="primary" size="md" disabled={!enabled} onClick={()=>setValue(v=>v+1)}>Increment</C.Button>
      <C.Button color="secondary" variant="soft" size="md" loading={busy} disabled={busy} onClick={()=>setBusy(true)}>Run</C.Button>
      <C.Button color="secondary" variant="ghost" size="md" onClick={()=>setConfirm(true)}>Reset…</C.Button>
    </div>
    {confirm&&<div role="group" aria-label="Reset counter?"><p>Reset counter?</p><C.Button color="secondary" variant="ghost" size="sm" onClick={()=>setConfirm(false)}>Cancel</C.Button><C.Button color="danger" size="sm" onClick={()=>{setValue(0);setConfirm(false);}}>Reset</C.Button></div>}
  </section>;
}
export function deactivate(){ui?.dispose();ui=null;}
export async function activate(context){
  deactivate();context.onDeactivate(deactivate);
  ui=context.ui.create();({React,components:C}=ui);h=React.createElement;
  await ui.page({label:'UI controls',icon:'CodeSquareSlash',render:()=> <Example/>});
}
