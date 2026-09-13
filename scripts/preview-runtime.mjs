// Deterministic demo responses. This module never accesses disk, GitHub or a
// real runtime. Browser preview controls are separate from the shipped UI.
export function createPreviewRuntime() {
  const state={long:false,phase:'development',failure:false};let id=0;
  const operations=new Map(),preferences=new Map(),removed=new Set();
  const source={repositoryUrl:'https://github.com/example/codlet-notes',releaseId:20,tag:'v2.0.0',assetId:200,assetName:'notes-win-x64.zip',sha256:'c'.repeat(64),upstreamDigestVerified:false};
  const manifest={id:'local.notes',name:'Local Notes',description:'Keep notes beside your project.',version:'1.2.0',permissions:['ui.dom'],renderer:{entry:'renderer.js',world:'isolated'},requires:[],provides:[]};
  const preview=()=>({schema:1,kind:'codlet.local-import-preview',path:'C:/Projects/Local Notes',contentDigest:'a'.repeat(64),registrationDigest:'b'.repeat(64),manifest,ownership:'development-directory'});
  const plugins=()=>[
    {id:'codlet-gui',name:'Codlet GUI',description:'Manage plugins, imports, permissions, and Codlet updates.',i18n:{zh:{name:'Codlet 管理界面',description:'管理插件、导入、权限和 Codlet 更新。'}},version:'0.1.0',source:'bundled',enabled:true},
    {id:'codex.ui.adapter',name:'Codex UI Adapter',description:'Connect plugin pages to Codex navigation.',i18n:{zh:{name:'Codex 界面适配器',description:'将插件页面接入 Codex 主导航。'}},version:'0.1.0',source:'bundled',enabled:true,disableDependents:['codlet-gui']},
    {id:'codex.desktop.adapter',name:'Codex Desktop Adapter',description:'Connect plugins to supported desktop features.',i18n:{zh:{name:'Codex 桌面适配器',description:'为插件提供已适配的 Codex 桌面功能。'}},version:'0.1.0',source:'bundled',enabled:true},
    {...manifest,source:'local',enabled:false},
    {id:'managed.notes',name:'GitHub Notes',description:'A community note panel for your workspace.',version:'2.0.0',source:'local',ownership:'core-managed-github',managedSource:source,enabled:true},
    ...(state.long?Array.from({length:40},(_,i)=>({id:`local.example-${i}`,name:`Workspace helper ${i+1}`,description:i%3?'A small tool for everyday tasks.':'A long description with a very-long-unbroken-filename-'+ 'x'.repeat(100),version:'1.0.0-preview',source:'local',enabled:i%2===0})):[]),
  ].filter(p=>!removed.has(p.id)).map(p=>({...p,enabled:preferences.get(p.id)??p.enabled,registered:true,loaded:preferences.get(p.id)??p.enabled,grants:['ui.dom'],validation:{status:'ok'}}));
  async function request(_cap,method,args) {
    if(method==='list'){if(state.failure)throw Error('Preview: connection unavailable. Refresh to retry.');return {plugins:plugins(),runtimeVersion:'0.1.0',clientStatus:{status:'matched'},localManagement:{available:true,folderPicker:true},githubManagement:{available:true}};}
    if(method==='previewLocal')return {...preview(),path:args.path};
    if(method==='chooseLocalFolder')return {selectionId:'fixture-folder',status:'selected',path:'C:/Projects/Local Notes'};
    if(method==='permissions')return {pluginId:args.pluginId,registration:{path:'C:/Projects/Local Notes',grants:['ui.dom'],brokerPolicy:{}},ownership:args.pluginId==='managed.notes'?'core-managed-github':'development-directory',managedSource:source};
    if(method==='openFolder')return {pluginId:args.pluginId,opened:true};
    if(method==='sourceRemovalPreview')return {pluginId:args.pluginId,status:'available',path:'C:/Projects/Local Notes',sourceIdentity:'fixture-source',registrationDigest:'b'.repeat(64)};
    if(method==='githubReleases')return {jobId:'release-fixture',kind:'releases',status:'completed',result:{repository:{url:source.repositoryUrl},releases:[{id:20,tag:'v2.0.0',name:'Notes 2.0',assets:[{id:200,name:source.assetName,size:12800}]}]}};
    if(method==='githubPrepare'||method==='previewRollback') {
      const result={...preview(),kind:'codlet.managed-preview',ownership:'core-managed-github',operation:method==='previewRollback'?'rollback':args.operation,source,manifest:{...manifest,id:args.pluginId??'managed.notes',version:'2.0.0'},changes:{permissionsAdded:[],permissionsRemoved:[],requirementsAdded:[],requirementsRemoved:[]}};
      return method==='previewRollback'?result:{jobId:'package-fixture',kind:'package',status:'completed',result};
    }
    if(method==='managedHistory')return {pluginId:args.pluginId,currentVersion:'v2',history:[{versionKey:'v2',manifest:{version:'2.0.0'},source},{versionKey:'v1',manifest:{version:'1.0.0'},source:{...source,tag:'v1.0.0'}}],nextCursor:null};
    if(method==='cancelGitHubJob')return {jobId:args.jobId,status:'cancelled'};
    if(method==='prepare'){const operation={operation_id:`preview-${++id}`,request:structuredClone(args)};operations.set(operation.operation_id,{status:'prepared',operation});return {status:'prepared',operation};}
    if(method==='submit'||method==='operation') {
      const record=operations.get(args.operationId);if(!record)return {status:'expired'};
      if(method==='submit')record.status='queued';
      if(method==='operation'&&record.status==='queued') {
        const r=record.operation.request;
        if(r.action==='remove')removed.add(r.plugin_id);else preferences.set(r.plugin_id,!['disable','revoke'].includes(r.action));
        record.status='completed';record.operation.completion={kind:'report',report:{outcome:'applied'}};
      }
      return structuredClone(record);
    }
    if(method.endsWith('RuntimeUpdate')||method==='runtimeUpdateStatus') {
      if(method==='checkRuntimeUpdate')state.phase='available';if(method==='downloadRuntimeUpdate')state.phase='downloaded';if(method==='installRuntimeUpdate')state.phase='installRequested';
      return {phase:state.phase,currentVersion:'0.1.0',configured:state.phase!=='development',installAvailable:true,candidate:{id:'fixture',version:'0.2.0'},downloadedBytes:60,totalBytes:100};
    }
    throw Error('Unsupported preview RPC: '+method);
  }
  return {state,request};
}
