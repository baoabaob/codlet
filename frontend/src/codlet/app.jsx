import { Manager } from './controller.js';
import { PERMISSION_COPY } from './messages.js';
import layout from './layout.css';
let React,h,C,I,ui,manager,epoch=0;
const t = value => manager.messages.t(value);
const name = plugin => manager.messages.name(plugin);
const description = plugin => manager.messages.description(plugin);
const mutationBusy = s => !!manager.pending || !!s.confirmation;
function IconAction({icon:Icon,label,onClick,disabled,loading,...rest}) {
  return <C.Tooltip content={t(label)}><C.Button color="secondary" variant="ghost" size="sm" uniform aria-label={t(label)} disabled={disabled} loading={loading} onClick={onClick} {...rest}><Icon/></C.Button></C.Tooltip>;
}
function Back(){return <C.Button color="secondary" variant="ghost" size="md" opticallyAlign="start" aria-label={t('Back')} data-codlet-back-button="" onClick={()=>manager.back()}><I.ArrowLeft/>{t('Back')}</C.Button>;}
function Copy({children,error=false,role}){return <p className={'codlet-copy'+(error?' codlet-error':'')} role={role}>{children}</p>;}
function ReleaseTrigger({label}){return <><span className="codlet-sr-only">{t('GitHub release')}: </span>{label}</>;}
function AssetTrigger({label}){return <><span className="codlet-sr-only">{t('GitHub ZIP asset')}: </span>{label}</>;}
function Source({source,metadata}) {
  if(!source)return null;
  return <><Copy>{t(`Repository: ${source.repositoryUrl}\nRelease/tag: ${source.tag}\nAsset: ${source.assetName}\nSHA-256: ${source.sha256}\nGitHub digest: ${source.upstreamDigestVerified?'matched':'not available for verification'}`)}</Copy>
    <Copy>{t(`Runtime compatibility: ${metadata?.runtimeApi==null?'unknown (not declared)':`author declared API ${metadata.runtimeApi}`}\nPlatforms: ${metadata?.platforms?.length?`author declared ${metadata.platforms.join(', ')}`:'unknown (not declared)'}`)}</Copy></>;
}
function PluginRow({plugin,s}) {
  const busy=mutationBusy(s)||s.loading, enabled=plugin.enabled===true, registered=plugin.registered!==false;
  const error=plugin.execution?.error || plugin.validation?.error?.message;
  return <div className="codlet-plugin-row" data-codlet-plugin={plugin.id} aria-busy={manager.pending?.pluginId===plugin.id}>
    <div className="codlet-plugin-copy">
      <div className="codlet-plugin-title"><span className="codlet-plugin-name">{name(plugin)}</span><span className="codlet-version">{plugin.version}</span></div>
      {description(plugin)&&<div className="codlet-plugin-description">{description(plugin)}</div>}
      {!registered&&plugin.loaded&&<Copy>{t('Registration removed; still loaded')}</Copy>}
      {plugin.validation?.status==='not_loaded'&&<Copy>{t('Registered, not loaded')}</Copy>}
      {error&&<Copy error>{t(error)}</Copy>}
    </div>
    <div className="codlet-plugin-actions">
      {registered&&<C.Button color="secondary" variant="ghost" size="sm" aria-label={t(`Details for ${name(plugin)}`)} disabled={busy} onClick={()=>manager.details(plugin)}>{t('Details')}</C.Button>}
      {!registered ? plugin.loaded&&<C.Button color="secondary" variant="ghost" size="sm" aria-label={t(`Stop ${name(plugin)}`)} disabled={busy} onClick={()=>manager.disable(plugin)}>{t('Stop')}</C.Button> :
        <>{enabled?<IconAction icon={I.Regenerate} label={`Reload ${name(plugin)}`} loading={manager.pending?.pluginId===plugin.id} disabled={busy} onClick={()=>manager.mutate(plugin.id,plugin.loaded||Number.isSafeInteger(plugin.generation)?'reload':'enable')}/>:<span className="codlet-action-space" aria-hidden="true"/>}
        <C.Switch checked={enabled} disabled={busy} aria-label={t(plugin.id===manager.context.pluginId?'Enable Codlet GUI':`Enable ${name(plugin)}`)} onCheckedChange={next=>next?manager.mutate(plugin.id,'enable'):manager.disable(plugin)}/></>}
    </div>
  </div>;
}
function PluginList({s}) {
  const [draft,setDraft]=React.useState(s.query),composing=React.useRef(false),input=React.useRef(null);
  React.useEffect(()=>setDraft(s.query),[s.query]);
  const clear=()=>{setDraft('');manager.setQuery('');input.current?.focus();};
  const plugins=manager.filtered();
  return <>
    <div className="codlet-search-toolbar">
      <C.Input className="codlet-search" ref={input} size="md" pill type="search" aria-label={t('Search plugins')} placeholder={t('Search plugins')} value={draft}
        startAdornment={<I.Search width={16} height={16}/>} endAdornment={draft?<IconAction icon={I.X} label="Clear search" onClick={clear}/>:null}
        onCompositionStart={()=>{composing.current=true;}} onCompositionEnd={event=>{composing.current=false;manager.setQuery(event.currentTarget.value);}}
        onChange={event=>{setDraft(event.currentTarget.value);if(!composing.current)manager.setQuery(event.currentTarget.value);}}
        onKeyDown={event=>{if(event.key==='Escape'&&!event.nativeEvent.isComposing&&!composing.current&&draft&&!event.altKey&&!event.ctrlKey&&!event.metaKey&&!event.shiftKey){event.preventDefault();event.stopPropagation();clear();}}}/>
      {s.localManagement?.available&&<C.Button color="secondary" variant="soft" size="md" aria-label={t('Import plugins')} disabled={mutationBusy(s)||s.loading} onClick={()=>manager.importPage()}><I.Download/>{t('Import plugins')}</C.Button>}
      <IconAction icon={I.Regenerate} label="Refresh plugins" disabled={s.loading&&!manager.pending} loading={s.loading} onClick={()=>manager.refresh()}/>
    </div>
    {s.error&&<p className="codlet-status codlet-error" role="alert">{t(s.error)}</p>}
    {s.operationStatus&&<p className="codlet-sr-only" role="status">{t(s.operationStatus)}</p>}
    {s.loading&&!s.plugins.length?<Copy role="status">{t('Loading plugins...')}</Copy>:!plugins.length?<p className="codlet-status" role="status">{t(s.query?'No matching plugins':'No plugins')}</p>:null}
    <div className="codlet-list-scroll">{plugins.length>0&&<div className="codlet-plugin-list">{plugins.map(plugin=><PluginRow key={plugin.id} plugin={plugin} s={s}/>)}</div>}</div>
  </>;
}
function Preview({s}) {
  const p=s.preview,m=p.manifest;
  const requirements=[...(m.renderer?(m.requires??[]):[]),...(m.host?(m.renderer?m.host.requires??[]:m.requires??[]):[])];
  const choices=[['host.fs','readRoots','Allowed read folders — one full path per line'],['host.network','networkOrigins','Allowed network origins — one HTTP(S) origin per line'],['host.process','executables','Allowed child programs — one full .exe path per line']];
  return <div className="codlet-local-preview">
    <h2>{name(m)}</h2><Copy>{m.id} · {m.version}</Copy>
    {requirements.length>0&&<Copy>{t('Dependencies')}{'\n'}{requirements.map(r=>`${r.name}@${r.api} (${r.scope})`).join('\n')}</Copy>}
    {(p.dependencyCheck?.requirements??[]).some(r=>r.status==='unavailable')&&<Copy>{t(`Currently unavailable: ${p.dependencyCheck.requirements.filter(r=>r.status==='unavailable').map(r=>`${r.capability.name}@${r.capability.api}`).join(', ')}. You can import the folder while disabled, then enable its providers first.`)}</Copy>}
    {s.mode==='github'&&<Source source={p.source} metadata={p.metadata}/>}
    {p.currentVersion&&<><Copy>{t(`Version: ${p.currentVersion.manifest.version} → ${m.version}\nRepository: ${p.currentVersion.source.repositoryUrl} → ${p.source.repositoryUrl}\nRelease: ${p.currentVersion.source.tag} → ${p.source.tag}`)}</Copy>
      {[['Permissions added','permissionsAdded'],['Permissions removed','permissionsRemoved'],['Dependencies added','requirementsAdded'],['Dependencies removed','requirementsRemoved']].map(([label,key])=><Copy key={key}>{t(label)}: {(p.changes?.[key]??[]).map(v=>typeof v==='string'?v:`${v.name}@${v.api} (${v.scope})`).join(', ')||t('None')}</Copy>)}</>}
    {p.existingRegistration&&s.mode==='local'&&<Copy>{t(`Already registered at this folder. Confirm all grants again to replace its permission settings.\nCurrent grants: ${p.existingRegistration.grants.join(', ')||'None'}. Stop the package before importing it again.`)}</Copy>}
    <h2>{t('Requested permissions')}</h2>
    {!m.permissions.length&&<Copy>{t('No permissions requested.')}</Copy>}
    {m.permissions.map(permission=><C.Checkbox key={permission} checked={s.grants.includes(permission)} aria-label={t(`Grant ${permission}`)} label={`${permission} — ${t(PERMISSION_COPY[permission])}`} onCheckedChange={next=>manager.grant(permission,next)}/>)}
    {choices.filter(([permission])=>m.permissions.includes(permission)).map(([,key,label])=><div className="codlet-field" key={key}><label htmlFor={key}>{t(label)}</label><C.Textarea id={key} aria-label={t(label)} rows={2} value={s.policy[key]??''} onChange={e=>manager.set({policy:{...s.policy,[key]:e.currentTarget.value}})}/></div>)}
    {choices.some(([permission])=>m.permissions.includes(permission))&&<Copy>{t('Empty lists grant no access through the file, network or child-process broker. Native Host code still runs with your OS user permissions.')}</Copy>}
    <C.Checkbox checked={s.trusted} aria-label={t(s.mode==='local'?'Trust this local plugin':'Trust this GitHub source')} label={t(s.mode==='local'?'I trust this plugin’s author and this local folder.':`I trust the author and this exact source: ${p.source.repositoryUrl}, release ${p.source.tag}, asset ${p.source.assetName}.`)} onCheckedChange={trusted=>manager.set({trusted})}/>
    <C.Checkbox checked={s.enableAfter} aria-label={t('Enable after import')} label={t('Enable immediately after importing')} onCheckedChange={enableAfter=>manager.set({enableAfter})}/>
  </div>;
}
function ImportPage({s}) {
  const composing=React.useRef(false),release=manager.selectedRelease(),assets=release?.assets.filter(a=>/\.zip$/i.test(a.name))??[];
  const submitText=s.importOperation==='update'?'Update plugin':s.importOperation==='rollback'?'Roll back plugin':'Import plugin';
  const submitLabel=s.mode==='local'?'Confirm local import':s.importOperation==='update'?'Confirm managed update':s.importOperation==='rollback'?'Confirm managed rollback':'Confirm GitHub import';
  return <section className="codlet-page"><Back/>
    {s.importOperation!=='rollback'&&<C.SegmentedControl value={s.mode} onChange={mode=>manager.importPage(mode)} aria-label={t('Import source')} size="sm" pill>
      <C.SegmentedControl.Option value="local" aria-label={t('Local folder')}>{t('Local folder')}</C.SegmentedControl.Option>
      <C.SegmentedControl.Option value="github" aria-label={t('Import from GitHub')} disabled={!s.githubAvailable}>GitHub</C.SegmentedControl.Option>
    </C.SegmentedControl>}
    {s.mode==='local'?<div className="codlet-field"><label htmlFor="codlet-import-path">{t('Plugin folder')}</label><div className="codlet-folder-input">
      <C.Input id="codlet-import-path" aria-label={t('Plugin folder')} aria-describedby="codlet-import-status" value={s.path} invalid={!!s.importError}
        onCompositionStart={()=>{composing.current=true;manager.setPath(s.path,true);}} onCompositionEnd={e=>{composing.current=false;manager.setPath(e.currentTarget.value);}}
        onChange={e=>manager.setPath(e.currentTarget.value,composing.current)}/>
      {s.localManagement?.folderPicker&&<IconAction icon={I.FolderOpen} label="Choose plugin folder" disabled={s.importBusy} onClick={()=>manager.chooseFolder()}/>}
    </div></div>:s.importOperation!=='rollback'&&<>
      <div className="codlet-field"><label htmlFor="codlet-github-url">{t('GitHub repository or release URL')}</label><C.Input id="codlet-github-url" aria-label={t('GitHub repository or release URL')} value={s.url} onChange={e=>manager.setUrl(e.currentTarget.value)}/></div>
      <C.Button color="secondary" variant="soft" size="md" aria-label={t('Read GitHub releases')} loading={s.importBusy&&manager.job?.kind==='releases'} disabled={s.importBusy} onClick={()=>manager.readReleases()}><I.Regenerate/>{t('Read releases')}</C.Button>
      {s.catalog&&<><div className="codlet-field"><label htmlFor="codlet-github-release">{t('GitHub release')}</label><C.Select id="codlet-github-release" TriggerView={ReleaseTrigger} placeholder={t('Choose a release')} searchPlaceholder={t('Search releases')} searchEmptyMessage={t('No matching releases')} value={s.release} disabled={s.importBusy} options={s.catalog.releases.map(r=>({value:String(r.id),label:r.tag,description:r.name}))} onChange={r=>manager.selectRelease(r.value)}/></div>
        {release&&<div className="codlet-field"><label htmlFor="codlet-github-asset">{t('GitHub ZIP asset')}</label><C.Select id="codlet-github-asset" TriggerView={AssetTrigger} placeholder={t('Choose a ZIP asset')} searchPlaceholder={t('Search assets')} searchEmptyMessage={t('No matching assets')} value={s.asset} disabled={s.importBusy||!assets.length} options={assets.map(a=>({value:String(a.id),label:a.name,description:`${a.size.toLocaleString()} ${t('bytes')}`}))} onChange={a=>manager.selectAsset(a.value)}/></div>}
        {release&&!assets.length&&<Copy>{t('This release has no ZIP assets. Repository source archives are not plugin release packages. Ask the author for a built package or use local folder import.')}</Copy>}
        <C.Button color="secondary" variant="soft" size="md" aria-label={t('Download selected GitHub asset')} disabled={s.importBusy||!manager.selectedAsset()} onClick={()=>manager.downloadAsset()}><I.Download/>{t('Download and inspect ZIP')}</C.Button></>}
      {s.importBusy&&manager.job&&<C.Button color="secondary" variant="ghost" size="sm" aria-label={t('Cancel GitHub task')} onClick={()=>manager.cancelImportJob()}>{t('Cancel GitHub task')}</C.Button>}
      {s.jobRetry&&<C.Button color="secondary" variant="ghost" size="sm" aria-label={t('Check GitHub task status')} onClick={()=>manager.pollJob()}>{t('Check task status')}</C.Button>}
    </>}
    {s.importStatus&&<p id="codlet-import-status" className="codlet-copy" role="status">{t(s.importStatus)}</p>}
    {s.importError&&<details><summary>{t('Error details')}</summary><Copy error>{s.importError}</Copy></details>}
    {s.preview&&<Preview s={s}/>}
    <C.Button color="primary" variant="solid" size="md" aria-label={t(submitLabel)} disabled={!manager.importReady()} onClick={()=>manager.submitImport()}>{t(submitText)}</C.Button>
    <C.TextLink href="https://github.com/topics/codlet-plugin" target="_blank" rel="noopener noreferrer" className="codlet-community-link">{t('Browse community plugins')}<I.ExternalLink/></C.TextLink>
  </section>;
}
function Details({s}){
  const p=s.details;
  return <section className="codlet-page"><Back/>
    {s.detailsError&&<Copy error role="alert">{t(s.detailsError)}</Copy>}
    {s.detailsBusy?<Copy role="status">{t('Loading permissions...')}</Copy>:p&&<>
      <div className="codlet-details-heading"><h2>{name(p)}</h2>{p.source!=='bundled'&&<IconAction icon={I.FolderOpen} label="Open plugin folder" onClick={()=>manager.openFolder()}/>}</div>
      <Copy>{p.id}{p.version?` · ${p.version}`:''}</Copy>{description(p)&&<Copy>{description(p)}</Copy>}
      {p.ownership==='core-managed-github'&&<Source source={p.managedSource} metadata={p.metadata}/>}
      {p.grants?.length>0&&<h2>{t('Granted permissions')}</h2>}
      {(p.grants??[]).map(permission=><div className="codlet-permission-line" key={permission}><Copy>{permission}{'\n'}{t(PERMISSION_COPY[permission]||'')}</Copy>
        {p.source!=='bundled'&&<C.Button color="secondary" variant="ghost" size="sm" aria-label={t(`Revoke ${permission}`)} onClick={()=>manager.requestRemoval(p,permission)}>{t('Revoke')}</C.Button>}</div>)}
      {[['readRoots','Allowed read folders'],['networkOrigins','Allowed network origins'],['executables','Allowed child programs']].filter(([key])=>p.brokerPolicy?.[key]?.length).map(([key,label])=><Copy key={key}>{t(label)}{'\n'}{p.brokerPolicy[key].join('\n')}</Copy>)}
      {p.source!=='bundled'&&<C.Button color="danger" variant="soft" size="md" aria-label={t(`Remove ${name(p)}`)} onClick={()=>manager.requestRemoval(p)}>{t('Remove plugin')}</C.Button>}
      {p.ownership==='core-managed-github'&&<>
        <C.Button color="secondary" variant="soft" size="md" aria-label={t('Check GitHub versions')} onClick={()=>manager.importPage('github',p)}>{t('Check GitHub versions')}</C.Button>
        <h2>{t('Installed version history')}</h2>
        {s.history.map(v=><div className="codlet-field" key={v.versionKey}><Copy>{v.manifest.version} · {v.source.tag}{v.versionKey===s.historyVersion?` · ${t('Current')}`:''}{'\n'}{v.source.repositoryUrl}{'\n'}{v.source.assetName}{'\n'}SHA-256: {v.source.sha256}</Copy>
          {v.versionKey!==s.historyVersion&&<C.Button color="secondary" variant="ghost" size="sm" aria-label={t(`Review rollback ${v.versionKey}`)} onClick={()=>manager.rollback(p,v.versionKey)}>{t('Review rollback')}</C.Button>}</div>)}
        {s.historyError&&<Copy error>{t(s.historyError)}</Copy>}
        {s.historyCursor!==null&&<C.Button color="secondary" variant="ghost" size="sm" loading={s.historyBusy} disabled={s.historyBusy} aria-label={t('Load more versions')} onClick={()=>manager.loadHistory()}>{t('Load more versions')}</C.Button>}
      </>}
    </>}
  </section>;
}
function UpdatePage({s}){
  const r=s.update,phase=r?.phase;
  const texts={development:'This development build has no configured update source.',checking:'Checking for updates...',upToDate:'Codlet is up to date.',available:`Codlet ${r?.candidate?.version||''} is available.`,downloading:r?.totalBytes?`Downloading update: ${Math.min(100,Math.round(r.downloadedBytes/r.totalBytes*100))}%`:'Downloading update...',downloaded:`Codlet ${r?.candidate?.version||''} is ready to install.`,installRequested:'Installation was requested. Follow the update process to restart Codlet.',failed:`Update failed.\n${r?.error?.message||''}`};
  return <section className="codlet-page"><Back/><h2>{t('Updates')}</h2><Copy role="status">{t(s.updateError||texts[phase]||'Checking for updates...')}</Copy>
    <Copy>{t(`Current Codlet version: ${r?.currentVersion||s.runtimeVersion}`)}</Copy>
    {r?.configured&&!['checking','downloading','installRequested'].includes(phase)&&<C.Button color="secondary" variant="soft" size="md" disabled={s.updateBusy||s.updateUncertain} onClick={()=>manager.loadUpdate('checkRuntimeUpdate')}><I.Regenerate/>{t('Check for Codlet updates')}</C.Button>}
    {phase==='available'&&<C.Button color="primary" size="md" disabled={s.updateBusy||s.updateUncertain} onClick={()=>manager.loadUpdate('downloadRuntimeUpdate')}><I.Download/>{t('Download update')}</C.Button>}
    {phase==='downloaded'&&(r.installAvailable?<C.Button color="primary" size="md" disabled={s.updateBusy||s.updateUncertain} onClick={()=>manager.requestInstall()}><I.ArrowRotateCw/>{t('Install and restart')}</C.Button>:<Copy>{t(`Automatic installation is unavailable for this launch.\n${r.unavailableReason||''}`)}</Copy>)}
  </section>;
}
function Confirmation({s}){
  const c=s.confirmation,p=c.plugin,verb=c.kind==='remove'?'Remove':c.kind==='revoke'?'Revoke':'Disable';
  const title=c.kind==='install'?'Install and restart Codlet?':`${verb} ${name(p)}?`;
  const dependents=(p?.disableDependents??[]).filter(id=>id!==p.id).map(id=>name(s.plugins.find(x=>x.id===id)??{id}));
  const copy=c.kind==='install'?'The current client will restart and running local tasks will be interrupted.':c.kind==='remove'?'Remove this plugin’s registration and disable it. Source files and plugin data are kept by default. Selecting deletion below removes the source folder and all its contents.':c.kind==='revoke'?`Revoke ${c.permission}. This stops the package and its running dependents. To grant it again, ${p.ownership==='core-managed-github'?'select a managed version and confirm its permissions again':'import the local folder and confirm its permissions'}.`:p.id===manager.context.pluginId||p.disableDependents?.includes(manager.context.pluginId)?'The Codlet GUI will close in all open windows. Re-enable the plugins from the launcher to restore it.':'These plugins will stay disabled until you enable them again.';
  return <section className="codlet-page"><h2>{t(title)}</h2><Copy>{t(copy)}{dependents.length?'\n'+t(`Also disable: ${dependents.join(', ')}.`):''}</Copy>
    {c.kind==='remove'&&<><C.Checkbox checked={c.deleteSource} disabled={!manager.sourceDeletable()||c.busy} aria-label={t('Delete source files')} label={t('Delete the plugin source folder')} onCheckedChange={value=>manager.setDeleteSource(value)}/>
      <Copy>{t(c.busy?'Checking source folder...':manager.sourceDeletable()?`Source folder: ${c.source.path}`:c.source?.status==='missing'?'The source folder is missing or moved. Removing registration is still available.':'Source deletion is unavailable. Removing registration keeps the remaining files.')}</Copy>
      {c.source?.warning&&<Copy>{c.source.warning}</Copy>}</>}
    {c.error&&<Copy error role="alert">{t(c.error)}</Copy>}
    <div className="codlet-confirmation-actions"><C.Button color="secondary" variant="soft" size="md" disabled={c.submitting} onClick={()=>manager.cancelConfirmation()} data-codlet-cancel="">{t('Cancel')}</C.Button>
      <C.Button color={c.kind==='install'?'primary':'danger'} variant="solid" size="md" disabled={c.busy||c.submitting} loading={c.submitting} aria-label={t(c.kind==='install'?'Install and restart':verb)} onClick={()=>manager.confirm()}>{t(c.kind==='install'?'Install and restart':verb)}</C.Button></div>
  </section>;
}
function Version({s}) {
  const status=s.clientStatus;
  const lines=[];
  if(status?.status==='officialUpdateAvailable'||status?.officialUpdateAvailable)lines.push('Official client update available. A routine update usually does not affect Codlet, but not every plugin is guaranteed to work.');
  if(status?.status==='unmatched')lines.push('This Codlet version is not matched to the latest client version. This usually does not affect use, but not every plugin is guaranteed to work.');
  if(status?.status==='matched')lines.push('This Codlet version matches the latest client version.');
  if(!lines.length)lines.push('Client compatibility information is unavailable.');
  return <C.Popover><C.Popover.Trigger><C.Button color="secondary" variant="ghost" size="sm" uniform aria-label={t('Version and compatibility')}><I.InfoCircle/></C.Button></C.Popover.Trigger>
    <C.Popover.Content width={320} maxWidth="calc(100vw - 40px)" align="start"><section className="codlet-version-copy" aria-label={t('Version and compatibility')}><h2>Codlet {s.runtimeVersion}</h2><Copy>{lines.map(t).join('\n')}</Copy><C.Button color="secondary" variant="ghost" size="sm" onClick={()=>manager.updates()}>{t('Updates')}</C.Button></section></C.Popover.Content></C.Popover>;
}
function Page({s}){
  const panel=React.useRef(null);
  ui.useEscCloseStack(!!s.confirmation,()=>manager.cancelConfirmation());
  React.useLayoutEffect(()=>{
    const target=panel.current?.querySelector(s.confirmation?'[data-codlet-cancel]':s.page==='plugins'?'input[type=search]':'[data-codlet-back-button]');
    target?.focus({preventScroll:true});
  },[s.page,!!s.confirmation]);
  const phase=s.update?.phase,updateAction=phase==='downloaded'?'Install and restart':'Download update';
  return <section ref={panel} data-codlet-panel="codlet" data-codlet-view={s.confirmation?'confirmation':s.page} aria-label={t(s.confirmation?'Confirm action':s.page==='import'?'Import plugins':s.page==='updates'?'Updates':'Codlet')}>
    <div className="codlet-content">
      <header className="codlet-header"><div className="codlet-brand"><h1>Codlet</h1><div className="codlet-version-group"><span className="codlet-version">{s.runtimeVersion}</span>{s.update?.configured===false&&<span className="codlet-version">{t('Development')}</span>}<Version key={s.page+Boolean(s.confirmation)} s={s}/></div></div>
        {['available','downloading','downloaded','checking','installRequested'].includes(phase)&&<IconAction icon={phase==='downloaded'?I.ArrowRotateCw:I.Download} label={updateAction} loading={['checking','downloading','installRequested'].includes(phase)} disabled={s.updateBusy||s.updateUncertain||mutationBusy(s)} onClick={()=>phase==='downloaded'?manager.requestInstall():manager.loadUpdate('downloadRuntimeUpdate')}/>}
      </header>
      <div className="codlet-panel-body">{s.confirmation?<Confirmation s={s}/>:s.page==='plugins'?<PluginList s={s}/>:s.page==='import'?<ImportPage s={s}/>:s.page==='details'?<Details s={s}/>:<UpdatePage s={s}/>}</div>
    </div>
  </section>;
}
function App(){
  const s=React.useSyncExternalStore(manager.subscribe,manager.snapshot);
  return <><style>{layout}</style><Page s={s}/></>;
}
export function deactivate(){epoch++;ui?.dispose();manager?.dispose();manager=ui=null;}
export async function activate(context){
    deactivate();const current=epoch;context.onDeactivate(deactivate);
    try{
      if(context.ui?.api!==2)throw new Error('Update the renderer runtime for official UI components');
      ui=context.ui.create();({React,components:C,icons:I}=ui);h=React.createElement;manager=new Manager(context);
      const owned=manager;
      await ui.page({label:'Codlet',icon:'Cube',render:()=> <App/>,onActivate:()=>owned.open(),onDeactivate:()=>owned.close()});
    }catch(error){if(current===epoch){ui?.dispose();manager?.dispose();context.reportDiagnostic?.({code:'gui_ui_unavailable',message:String(error?.message??error)});}}
}
