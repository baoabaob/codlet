import { Manager } from './controller.js';
import { PERMISSION_COPY, descriptionText } from './messages.js';
import { displayPath } from './paths.js';
import { versionWarnings } from './versions.js';
import { createSettingsView } from './settings.jsx';
import layout from './layout.css';
import { createCodletIcon } from '../brand.js';
import { tagCatalog, tagAtCaret, suggestTags, insertTag } from './tag-search.js';
let React,h,C,I,ui,manager,Settings,CodletIcon,epoch=0;
const t = value => manager.messages.t(value);
const name = plugin => manager.messages.name(plugin);
const description = plugin => manager.messages.description(plugin);
const mutationBusy = s => !!manager.pending || !!s.confirmation || !!s.combinedConfirmation || manager.combiningUpdates() || manager.installingPlugins();
function IconAction({icon:Icon,label,onClick,disabled,loading,iconClassName,...rest}) {
  return <C.Tooltip content={t(label)}><C.Button color="secondary" variant="ghost" size="sm" uniform aria-label={t(label)} disabled={disabled} loading={loading} onClick={onClick} {...rest}><Icon className={iconClassName}/></C.Button></C.Tooltip>;
}
function Back(){return <C.Button color="secondary" variant="ghost" size="md" opticallyAlign="start" aria-label={t('Back')} data-codlet-back-button="" onClick={()=>manager.back()}><I.ArrowLeft/>{t('Back')}</C.Button>;}
function Copy({children,error=false,role}){return <p className={'codlet-copy'+(error?' codlet-error':'')} role={role}>{error?children:descriptionText(children)}</p>;}
function ReleaseTrigger({label}){return <><span className="codlet-sr-only">{t('GitHub release')}: </span>{label}</>;}
function AssetTrigger({label}){return <><span className="codlet-sr-only">{t('GitHub ZIP asset')}: </span>{label}</>;}
function Source({source,metadata}) {
  if(!source)return null;
  return <><Copy>{t(`Repository: ${source.repositoryUrl}\nRelease/tag: ${source.tag}\nAsset: ${source.assetName}\nSHA-256: ${source.sha256}\nGitHub digest: ${source.upstreamDigestVerified?'matched':'not available for verification'}`)}</Copy>
    <Copy>{t(`Runtime compatibility: ${metadata?.runtimeApi==null?'unknown (not declared)':`author declared API ${metadata.runtimeApi}`}\nPlatforms: ${metadata?.platforms?.length?`author declared ${metadata.platforms.join(', ')}`:'unknown (not declared)'}`)}</Copy></>;
}
function TagHash(){return <svg className="codlet-tag-hash" width="16" height="16" viewBox="0 0 16 16" fill="none" stroke="currentColor" strokeWidth="2.6" strokeLinecap="round" aria-hidden="true" focusable="false"><path d="M6.3 2.7L4.7 13.3 M11.3 2.7L9.7 13.3 M2.7 5.5H13.3 M2.7 10.5H13.3"/></svg>;}
function PluginTags({tags,show=true,query,onSelect}) {
  if(!show)return null;
  if(!tags?.length)return null;
  const selected=new Set(query.toLowerCase().split(/\s/u));
  return <span className="codlet-plugin-tags">{tags.map(tag=><button type="button" className="codlet-plugin-tag" key={tag} aria-label={`#${tag}`} aria-pressed={selected.has(`#${tag.toLowerCase()}`)} onClick={()=>onSelect(tag)}><TagHash/>{tag}</button>)}</span>;
}
function PluginRow({plugin,s,showTags,onSelectTag}) {
  const busy=mutationBusy(s)||s.loading||s.listStale, enabled=plugin.enabled===true, registered=plugin.registered!==false;
  const error=plugin.execution?.error || plugin.validation?.error?.message,update=manager.pluginUpdate(plugin),install=manager.installState(plugin);
  return <div className="codlet-plugin-row" data-codlet-plugin={plugin.id} aria-busy={manager.pending?.pluginId===plugin.id}>
    <div className="codlet-plugin-copy">
      <div className="codlet-plugin-title"><span className="codlet-plugin-name">{name(plugin)}</span><span className="codlet-version">{plugin.version}</span><PluginTags tags={plugin.tags} show={showTags} query={s.query} onSelect={onSelectTag}/>{registered&&update?.status==='available'&&<C.Button color="info" variant="soft" size="xs" disabled={busy||manager.checkingPlugins()} aria-label={t(`Update ${name(plugin)}`)} onClick={()=>manager.updatePlugins([plugin])}><I.Download/>{t('Update')}</C.Button>}</div>
      {description(plugin)&&<div className="codlet-plugin-description">{description(plugin)}</div>}
      {!registered&&plugin.loaded&&<Copy>{t('Registration removed; still loaded')}</Copy>}
      {plugin.validation?.status==='not_loaded'&&<Copy>{t('Registered, not loaded')}</Copy>}
      {error&&<Copy error>{t(error)}</Copy>}
      {install&&install.phase!=='upToDate'&&<Copy error={install.phase==='failed'} role="status">{t(({queued:'Waiting to update',downloading:'Downloading update',installing:'Installing update',checkingStatus:'Checking installation status',updated:'Updated',reviewRequired:'Needs review',failed:'Update failed'})[install.phase])}{install.message?` · ${t(install.message)}`:''}</Copy>}
      {install?.phase==='reviewRequired'&&<C.Button color="secondary" variant="soft" size="sm" disabled={busy} onClick={()=>manager.reviewPluginUpdate(plugin)}>{t('Review update')}</C.Button>}
      {install?.phase==='failed'&&<C.Button color="secondary" variant="ghost" size="sm" disabled={busy} onClick={()=>manager.importPage('github',plugin)}>{t('Choose a version manually')}</C.Button>}
    </div>
    <div className="codlet-plugin-actions">
      {registered&&<C.Button color="secondary" variant="ghost" size="sm" aria-label={t(`Details for ${name(plugin)}`)} disabled={busy} onClick={()=>manager.details(plugin)}>{t('Details')}</C.Button>}
      {!registered ? plugin.loaded&&<C.Button color="secondary" variant="ghost" size="sm" data-codlet-focus-key={`stop:${plugin.id}`} aria-label={t(`Stop ${name(plugin)}`)} disabled={busy} onClick={()=>manager.disable(plugin)}>{t('Stop')}</C.Button> :
        <>{enabled?<IconAction icon={I.Regenerate} label={`Reload ${name(plugin)}`} loading={manager.pending?.pluginId===plugin.id} disabled={busy} onClick={()=>manager.mutate(plugin.id,plugin.loaded||Number.isSafeInteger(plugin.generation)?'reload':'enable')}/>:<span className="codlet-action-space" aria-hidden="true"/>}
        <C.Switch checked={enabled} disabled={busy} data-codlet-focus-key={`disable:${plugin.id}`} aria-label={t(plugin.id===manager.context.pluginId?'Enable Codlet GUI':`Enable ${name(plugin)}`)} onCheckedChange={next=>next?manager.mutate(plugin.id,'enable'):manager.disable(plugin)}/></>}
    </div>
  </div>;
}
function PluginList({s}) {
  const [draft,setDraft]=React.useState(s.query),composing=React.useRef(false),input=React.useRef(null);
  const [focused,setFocused]=React.useState(false),[ime,setIme]=React.useState(false),[dismissed,setDismissed]=React.useState(false),[active,setActive]=React.useState(0);
  const [caret,setCaret]=React.useState({start:0,end:0}),caretRef=React.useRef(caret),pendingCaret=React.useRef(null),options=React.useRef(null),listId=React.useId();
  React.useEffect(()=>setDraft(s.query),[s.query]);
  const rememberCaret=node=>{const next={start:node.selectionStart,end:node.selectionEnd};if(next.start!==caretRef.current.start||next.end!==caretRef.current.end){caretRef.current=next;setCaret(next);setDismissed(false);setActive(0);}};
  const token=tagAtCaret(draft,caret.start,caret.end),candidates=suggestTags(tagCatalog(s.plugins),draft,token);
  const open=focused&&!ime&&!dismissed&&!!token,selected=Math.min(active,Math.max(0,candidates.length-1)),activeId=open&&candidates.length?`${listId}-${selected}`:undefined;
  React.useLayoutEffect(()=>{if(pendingCaret.current==null)return;const position=pendingCaret.current;pendingCaret.current=null;input.current?.focus();input.current?.setSelectionRange(position,position);const next={start:position,end:position};caretRef.current=next;setCaret(next);},[draft]);
  React.useEffect(()=>{if(activeId)options.current?.querySelector('[aria-selected="true"]')?.scrollIntoView?.({block:'nearest'});},[activeId,candidates.join('\n')]);
  const commit=result=>{setDraft(result.query);manager.setQuery(result.query);setDismissed(true);setActive(0);pendingCaret.current=result.caret;input.current?.focus();if(result.query===draft){pendingCaret.current=null;input.current?.setSelectionRange(result.caret,result.caret);rememberCaret(input.current);setDismissed(true);}};
  const clear=()=>commit({query:'',caret:0});
  const addTag=tag=>commit(insertTag(draft,tag));
  const complete=tag=>commit(insertTag(draft,tag,token));
  const keyDown=event=>{
    if(event.nativeEvent.isComposing||composing.current||event.altKey||event.ctrlKey||event.metaKey)return;
    if((event.key==='ArrowDown'||event.key==='ArrowUp')&&token&&candidates.length){event.preventDefault();setDismissed(false);setActive(open?(selected+(event.key==='ArrowDown'?1:-1)+candidates.length)%candidates.length:event.key==='ArrowDown'?0:candidates.length-1);}
    else if(event.key==='Enter'&&open&&candidates.length){event.preventDefault();event.stopPropagation();complete(candidates[selected]);}
    else if(event.key==='Escape'&&!event.shiftKey&&(open||draft)){event.preventDefault();event.stopPropagation();open?setDismissed(true):clear();}
    else if(event.key==='Tab')setDismissed(true);
  };
  const plugins=manager.filtered(),updates=manager.updateCandidates().length,checking=manager.checkingPlugins(),checkMessage=manager.pluginCheckMessage(),showTags=s.settings?.effective?.showPluginTags!==false;
  return <>
    <div className="codlet-search-sticky"><div className="codlet-search-toolbar codlet-width">
      <div className="codlet-search-anchor"><C.Input className="codlet-search" ref={input} variant="outline" size="md" pill type="text" role="combobox" data-codlet-plugin-search="" aria-label={t('Search plugins')} placeholder={t('Search plugins')} value={draft} aria-autocomplete="list" aria-haspopup="listbox" aria-expanded={open} aria-controls={open?listId:undefined} aria-activedescendant={activeId}
        startAdornment={<I.Search width={16} height={16}/>} endAdornment={draft?<IconAction icon={I.X} label="Clear search" onClick={clear}/>:null}
        onFocus={event=>{setFocused(true);rememberCaret(event.currentTarget);}} onBlur={()=>{setFocused(false);setDismissed(true);}}
        onSelect={event=>rememberCaret(event.currentTarget)}
        onCompositionStart={()=>{composing.current=true;setIme(true);}} onCompositionEnd={event=>{composing.current=false;setIme(false);setDraft(event.currentTarget.value);manager.setQuery(event.currentTarget.value);rememberCaret(event.currentTarget);setDismissed(false);setActive(0);}}
        onChange={event=>{setDraft(event.currentTarget.value);rememberCaret(event.currentTarget);setDismissed(false);setActive(0);if(!composing.current)manager.setQuery(event.currentTarget.value);}}
        onKeyDown={keyDown}/>
      {open&&<div className="codlet-tag-menu"><div className="codlet-tag-menu-title">{t('Tags')}</div><div id={listId} ref={options} role="listbox" aria-label={t('Tag suggestions')} className="codlet-tag-options">
        {candidates.map((tag,index)=><div key={tag} id={`${listId}-${index}`} role="option" aria-label={`#${tag}`} aria-selected={index===selected} className="codlet-tag-option" onPointerMove={()=>setActive(index)} onPointerDown={event=>event.preventDefault()} onMouseDown={event=>event.preventDefault()} onClick={()=>complete(tag)}><TagHash/><span>{tag}</span></div>)}
        {!candidates.length&&<div className="codlet-tag-empty" role="status">{t('No matching tags')}</div>}
      </div></div>}</div>
    </div></div>
    <div className="codlet-body codlet-width">
    <div className="codlet-list-toolbar"><div className="codlet-filters" role="group" aria-label={t('Filter plugins')}>
      {[['all','All'],['enabled','Enabled'],['disabled','Not enabled']].map(([value,label])=><C.Button key={value} color="secondary" variant={s.filter===value?'soft':'ghost'} size="sm" aria-pressed={s.filter===value} onClick={()=>manager.setFilter(value)}>{t(label)}</C.Button>)}
    </div>
      <div className="codlet-update-actions"><C.Tooltip content={t('Check plugins imported from GitHub')}><C.Button color="secondary" variant="ghost" size="sm" aria-label={t('Check for plugin updates')} disabled={mutationBusy(s)||s.loading||s.listStale||checking||!s.githubAvailable||!manager.githubPlugins().length} loading={checking} onClick={()=>manager.checkPluginUpdates()}><I.Regenerate/>{t('Check for updates')}</C.Button></C.Tooltip>
        {(updates>0||manager.installingPlugins())&&<C.Button color="info" variant="soft" size="sm" disabled={mutationBusy(s)||s.loading||s.listStale||checking} loading={manager.installingPlugins()} onClick={()=>manager.updatePlugins()}><I.Download/>{t('Update all')} ({updates})</C.Button>}
      </div>
    </div>
    {checkMessage&&<p className="codlet-update-status codlet-copy" role="status">{t(checkMessage)}</p>}
    {[...new Set([s.pluginUpdateError,s.pluginUpdates?.error].filter(Boolean))].map(error=><Copy error role="alert" key={error}>{t(error)}</Copy>)}
    {s.error&&<p className="codlet-status codlet-error" role="alert">{t(s.error)}</p>}
    {s.pluginInstallError&&<Copy error role="alert">{t(s.pluginInstallError)}</Copy>}
    {s.operationStatus&&<p className="codlet-sr-only" role="status">{t(s.operationStatus)}</p>}
    {s.loading&&!s.plugins.length?<div className="codlet-empty codlet-loading" role="status"><C.LoadingIndicator size={24} aria-hidden="true"/><span className="codlet-sr-only">{t('Loading plugins...')}</span></div>:!plugins.length?<div className="codlet-empty" role="status"><C.EmptyMessage><C.EmptyMessage.Description>{t(s.query||s.filter!=='all'?'No matching plugins':'No plugins')}</C.EmptyMessage.Description></C.EmptyMessage></div>:null}
    <div className="codlet-list-scroll">{plugins.length>0&&<div className="codlet-plugin-list">{plugins.map(plugin=><PluginRow key={plugin.id} plugin={plugin} s={s} showTags={showTags} onSelectTag={addTag}/>)}</div>}</div>
    </div>
  </>;
}
function Preview({s}) {
  const p=s.preview,m=p.manifest;
  const requirements=[...(m.renderer?(m.requires??[]):[]),...(m.host?(m.renderer?m.host.requires??[]:m.requires??[]):[])];
  const choices=[['host.fs','readRoots','Allowed read folders — one full path per line'],['host.fs.write','writeRoots','Allowed write folders — one full path per line'],['host.fs.watch','watchRoots','Allowed watch folders — one full path per line'],['host.network','networkOrigins','Allowed network origins — one HTTP(S) origin per line'],[m.permissions.includes('host.process.spawn')?'host.process.spawn':'host.process','executables','Allowed child programs — one full path per line'],['host.process.spawn','cwdRoots','Allowed working folders — one full path per line'],['host.process.spawn','envKeys','Allowed environment keys — one name per line'],['core.shortcuts','shortcuts','Allowed global shortcuts — one combination per line']];
  return <div className="codlet-local-preview">
    <h2>{name(m)}</h2><Copy>{m.id} · {m.version}</Copy>
    {requirements.length>0&&<Copy>{t('Dependencies')}{'\n'}{requirements.map(r=>`${r.name}@${r.api} (${r.scope})`).join('\n')}</Copy>}
    {(p.dependencyCheck?.requirements??[]).some(r=>r.status==='unavailable')&&<Copy>{t(`Currently unavailable: ${p.dependencyCheck.requirements.filter(r=>r.status==='unavailable').map(r=>`${r.capability.name}@${r.capability.api}`).join(', ')}. You can import the folder while disabled, then enable its providers first.`)}</Copy>}
    {s.mode==='github'&&<Source source={p.source} metadata={p.metadata}/>}
    {p.currentVersion&&<><Copy>{t(`Version: ${p.currentVersion.manifest.version} → ${m.version}\nRepository: ${p.currentVersion.source.repositoryUrl} → ${p.source.repositoryUrl}\nRelease: ${p.currentVersion.source.tag} → ${p.source.tag}`)}</Copy>
      {[['Permissions added','permissionsAdded'],['Permissions removed','permissionsRemoved'],['Dependencies added','requirementsAdded'],['Dependencies removed','requirementsRemoved']].map(([label,key])=><Copy key={key}>{t(`${label}: ${(p.changes?.[key]??[]).map(v=>typeof v==='string'?v:`${v.name}@${v.api} (${v.scope})`).join(', ')||t('None')}`)}</Copy>)}</>}
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
  const submitText=s.importOperation==='update'?'Update plugin':'Import plugin';
  const submitLabel=s.mode==='local'?'Confirm local import':s.importOperation==='update'?'Confirm managed update':'Confirm GitHub import';
  return <section className="codlet-page"><Back/>
    <C.SegmentedControl className="codlet-import-source" value={s.mode} onChange={mode=>manager.importPage(mode)} aria-label={t('Import source')} size="sm" pill>
      <C.SegmentedControl.Option value="local" aria-label={t('Local folder')}>{t('Local folder')}</C.SegmentedControl.Option>
      <C.SegmentedControl.Option value="github" aria-label={t('Import from GitHub')} disabled={!s.githubAvailable}>GitHub</C.SegmentedControl.Option>
    </C.SegmentedControl>
    {s.mode==='local'?<div className="codlet-field"><label htmlFor="codlet-import-path">{t('Plugin folder')}</label><div className="codlet-folder-input">
      <C.Input id="codlet-import-path" aria-label={t('Plugin folder')} aria-describedby="codlet-import-status" value={displayPath(s.path)} invalid={!!s.importError}
        onCompositionStart={()=>{composing.current=true;manager.setPath(s.path,true);}} onCompositionEnd={e=>{composing.current=false;manager.setPath(e.currentTarget.value);}}
        onChange={e=>manager.setPath(e.currentTarget.value,composing.current)}/>
      {s.localManagement?.folderPicker&&<IconAction icon={I.FolderOpen} label="Choose plugin folder" disabled={s.importBusy} onClick={()=>manager.chooseFolder()}/>}
    </div></div>:!s.preview&&<>
      <div className="codlet-field"><label htmlFor="codlet-github-url">{t('GitHub repository or release URL')}</label><C.Input id="codlet-github-url" aria-label={t('GitHub repository or release URL')} value={s.url} onChange={e=>manager.setUrl(e.currentTarget.value)}/></div>
      <C.Button color="secondary" variant="soft" size="md" aria-label={t('Find versions')} loading={s.importBusy&&manager.job?.kind==='releases'} disabled={s.importBusy} onClick={()=>manager.readReleases()}><I.Regenerate/>{t('Find versions')}</C.Button>
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
    <ImportNotice s={s} submitLabel={submitLabel} submitText={submitText}/>
    <C.TextLink href="https://github.com/topics/codlet-plugin" target="_blank" rel="noopener noreferrer" className="codlet-community-link">{t('Browse community plugins')}<I.ExternalLink/></C.TextLink>
  </section>;
}
function ImportNotice({s,submitLabel,submitText}){
  return <C.Dialog.Root open={!!s.importWarning} onOpenChange={open=>{if(!open)manager.cancelImportWarning();}}>
    <C.Dialog.Trigger asChild><C.Button color="primary" variant="solid" size="md" aria-label={t(submitLabel)} disabled={!manager.importReady()} onClick={()=>manager.submitImport()}>{t(submitText)}</C.Button></C.Dialog.Trigger>
    <C.Dialog.Portal><C.Dialog.Overlay className="codlet-help-overlay"/><C.Dialog.Content className="codlet-help-dialog codlet-install-notice">
      <div className="codlet-help-heading"><div className="codlet-install-title"><I.TriangleExclamationErrorWarning className="codlet-install-icon" aria-hidden="true"/><C.Dialog.Title>{t('Installation notice')}</C.Dialog.Title></div><C.Dialog.Close asChild><C.Button color="secondary" variant="ghost" size="sm" uniform aria-label={t('Close')}><I.X/></C.Button></C.Dialog.Close></div>
      <C.Dialog.Description className="codlet-install-copy">{t('Codlet does not guarantee the safety of any unofficial plugin. Third-party plugins may access your data or modify the client. Only install plugins you trust.')}</C.Dialog.Description>
      <button type="button" className="codlet-inline-link" disabled={s.createBusy} onClick={()=>manager.reviewImport()}>{t('Let Codex check')}<I.ArrowUpRight aria-hidden="true"/></button>
      {s.importReviewError&&<Copy error role="alert">{t(s.importReviewError)}</Copy>}
      <div className="codlet-help-actions codlet-install-actions"><C.Dialog.Close asChild><C.Button color="secondary" variant="outline" size="md">{t('Cancel')}</C.Button></C.Dialog.Close><C.Button color="primary" variant="solid" size="md" disabled={!manager.importReady()} onClick={()=>manager.confirmImport()}>{t('Got it')}</C.Button></div>
    </C.Dialog.Content></C.Dialog.Portal>
  </C.Dialog.Root>;
}
function Details({s}){
  const p=s.details;
  return <section className="codlet-page"><Back/>
    {s.detailsError&&<Copy error role="alert">{t(s.detailsError)}</Copy>}
    {s.detailsBusy?<Copy role="status">{t('Loading permissions...')}</Copy>:p&&<>
      <div className="codlet-details-identity"><div className="codlet-details-heading"><h2>{name(p)}</h2>{p.version&&<span className="codlet-version">{p.version}</span>}{p.source!=='bundled'&&<IconAction icon={I.FolderOpen} label="Open plugin folder" onClick={()=>manager.openFolder()}/>}</div>
        <Copy>{p.id}</Copy>{description(p)&&<Copy>{description(p)}</Copy>}</div>
      {p.ownership==='core-managed-github'&&<Source source={p.managedSource} metadata={p.metadata}/>}
      {p.grants?.length>0&&<h2>{t('Granted permissions')}</h2>}
      {(p.grants??[]).map(permission=><div className="codlet-permission-line" key={permission}><Copy>{permission}{'\n'}{t(PERMISSION_COPY[permission]||'')}</Copy>
        {p.source!=='bundled'&&<C.Button color="secondary" variant="ghost" size="sm" data-codlet-focus-key={`revoke:${p.id}:${permission}`} aria-label={t(`Revoke ${permission}`)} onClick={()=>manager.requestRemoval(p,permission)}>{t('Revoke')}</C.Button>}</div>)}
      {[['readRoots','Allowed read folders'],['writeRoots','Allowed write folders'],['watchRoots','Allowed watch folders'],['networkOrigins','Allowed network origins'],['executables','Allowed child programs'],['cwdRoots','Allowed working folders'],['envKeys','Allowed environment keys'],['shortcuts','Allowed global shortcuts']].filter(([key])=>p.brokerPolicy?.[key]?.length).map(([key,label])=><Copy key={key}>{t(label)}{'\n'}{p.brokerPolicy[key].join('\n')}</Copy>)}
      {manager.removalRequiresCli(p)?<div className="codlet-removal-notice"><Copy>{t('The GUI plugin cannot uninstall itself or its dependencies')}</Copy><p className="codlet-copy">{t('To uninstall, use the CLI or ')}<button type="button" className="codlet-inline-link" disabled={s.createBusy||s.detailsBusy||mutationBusy(s)} onClick={()=>manager.uninstallWithCodex()}>{t('use Codex')}<I.ArrowUpRight aria-hidden="true"/></button></p></div>:p.source!=='bundled'&&<C.Button color="danger" variant="soft" size="md" data-codlet-focus-key={`remove:${p.id}`} aria-label={t(`Remove ${name(p)}`)} onClick={()=>manager.requestRemoval(p)}>{t('Remove plugin')}</C.Button>}
      {p.ownership==='core-managed-github'&&<>
        <C.Button color="secondary" variant="soft" size="md" aria-label={t('Check GitHub versions')} onClick={()=>manager.importPage('github',p)}>{t('Check GitHub versions')}</C.Button>
      </>}
    </>}
  </section>;
}
function Confirmation({s}){
  const c=s.confirmation,p=c.plugin,verb=c.kind==='remove'?'Remove':c.kind==='revoke'?'Revoke':'Disable';
  const title=c.kind==='install'?'Install and restart Codlet?':`${verb} ${name(p)}?`;
  const dependents=[...new Set(p?.disableDependents??[])].filter(id=>id!==p.id).map(id=>s.plugins.find(x=>x.id===id)??{id});
  const copy=c.kind==='install'?'The current client will restart and running local tasks will be interrupted.':c.kind==='remove'?'Remove this plugin’s registration and disable it. Source files and plugin data are kept by default. Selecting deletion below removes the source folder and all its contents.':c.kind==='revoke'?`Revoke ${c.permission}. This stops the package and its running dependents. To grant it again, ${p.ownership==='core-managed-github'?'select a managed version and confirm its permissions again':'import the local folder and confirm its permissions'}.`:p.id===manager.context.pluginId||p.disableDependents?.includes(manager.context.pluginId)?'The Codlet GUI will close in all open windows. Re-enable the plugins from the launcher to restore it.':'These plugins will stay disabled until you enable them again.';
  return <section className="codlet-page"><h2>{t(title)}</h2><Copy>{t(copy)}</Copy>
    {dependents.length>0&&<section className="codlet-field" aria-labelledby="codlet-affected-heading"><h2 id="codlet-affected-heading">{t(c.kind==='revoke'?'Plugins that will also stop':'Plugins that will also be disabled')}</h2><Copy>{t('Includes indirect dependencies. These plugins and their files will be kept.')}</Copy><ul className="codlet-affected-plugins">{dependents.map(plugin=><li key={plugin.id}><span className="codlet-plugin-name">{name(plugin)}</span><span className="codlet-version">{plugin.id}</span></li>)}</ul></section>}
    {c.kind==='remove'&&<><C.Checkbox checked={c.deleteSource} disabled={!manager.sourceDeletable()||c.busy} aria-label={t('Delete source files')} label={t('Delete the plugin source folder')} onCheckedChange={value=>manager.setDeleteSource(value)}/>
      <Copy>{t(c.busy?'Checking source folder...':manager.sourceDeletable()?`Source folder: ${displayPath(c.source.path)}`:c.source?.status==='missing'?'The source folder is missing or moved. Removing registration is still available.':'Source deletion is unavailable. Removing registration keeps the remaining files.')}</Copy>
      {c.source?.warning&&<Copy>{c.source.warning}</Copy>}</>}
    {c.error&&<Copy error role="alert">{t(c.error)}</Copy>}
    <div className="codlet-confirmation-actions"><C.Button color="secondary" variant="soft" size="md" disabled={c.submitting} onClick={()=>manager.cancelConfirmation()} data-codlet-cancel="">{t('Cancel')}</C.Button>
      <C.Button color={c.kind==='install'?'primary':'danger'} variant="solid" size="md" disabled={c.busy||c.submitting} loading={c.submitting} aria-label={t(c.kind==='install'?'Install and restart':verb)} onClick={()=>manager.confirm()}>{t(c.kind==='install'?'Install and restart':verb)}</C.Button></div>
  </section>;
}
function SkillHelp({s}){
  const [open,setOpen]=React.useState(false);
  return <C.Dialog.Root open={open} onOpenChange={setOpen}>
    <C.Tooltip content={t('About the Codlet skill')}><C.Dialog.Trigger asChild><C.Button color="secondary" variant="ghost" size="sm" uniform aria-label={t('About the Codlet skill')} disabled={!!s.confirmation}><I.QuestionMarkCircle/></C.Button></C.Dialog.Trigger></C.Tooltip>
    <C.Dialog.Portal><C.Dialog.Overlay className="codlet-help-overlay"/><C.Dialog.Content className="codlet-help-dialog">
      <div className="codlet-help-heading"><C.Dialog.Title>{t('Codlet skill')}</C.Dialog.Title><C.Dialog.Close asChild><C.Button color="secondary" variant="ghost" size="sm" uniform aria-label={t('Close')}><I.X/></C.Button></C.Dialog.Close></div>
      <C.Dialog.Description>{t('Use the Codlet skill to manage plugins in a conversation, or ask anything about Codlet')}</C.Dialog.Description>
      <div className="codlet-help-actions"><C.Button color="primary" variant="solid" size="md" disabled={mutationBusy(s)||s.loading||s.listStale||s.createBusy} onClick={()=>{setOpen(false);void manager.quickStart();}}>{t('Try it!')}</C.Button></div>
    </C.Dialog.Content></C.Dialog.Portal>
  </C.Dialog.Root>;
}
function Page({s,toolbar}){
  const panel=React.useRef(null),lastFocus=React.useRef(null),focusedRow=React.useRef(null),previous=React.useRef(null),handledJump=React.useRef(0),highlightTimer=React.useRef(null);
  const [versionHighlight,setVersionHighlight]=React.useState(false);
  React.useEffect(()=>()=>clearTimeout(highlightTimer.current),[]);
  ui.useEscCloseStack(!!s.confirmation,()=>manager.cancelConfirmation());
  React.useLayoutEffect(()=>{
    const returning=previous.current?.confirmation&&!s.confirmation;
    const trigger=returning&&[...panel.current.querySelectorAll('[data-codlet-focus-key]')].find(node=>node.dataset.codletFocusKey===lastFocus.current&&!node.disabled);
    const jumping=!s.confirmation&&s.page==='settings'&&s.settingsReady&&!s.settingsBusy&&s.versionJump>handledJump.current;
    const changed=!previous.current||previous.current.page!==s.page||previous.current.confirmation!==!!s.confirmation;
    previous.current={page:s.page,confirmation:!!s.confirmation};
    if(!changed&&!jumping)return;
    if(changed){const scroll=panel.current?.querySelector('.codlet-scroll');if(scroll)scroll.scrollTop=0;}
    const target=trigger||panel.current?.querySelector(s.confirmation?'[data-codlet-cancel]':jumping?'#codlet-version-heading':s.page==='plugins'?'[data-codlet-plugin-search]':s.page==='settings'?'[data-codlet-page-heading]':'[data-codlet-back-button]');
    target?.focus({preventScroll:!returning});
    if(jumping){
      panel.current?.querySelector('#codlet-version-section')?.scrollIntoView({block:'start',behavior:matchMedia('(prefers-reduced-motion: reduce)').matches?'instant':'smooth'});
      handledJump.current=s.versionJump;setVersionHighlight(true);clearTimeout(highlightTimer.current);highlightTimer.current=setTimeout(()=>setVersionHighlight(false),2600);
    }else if(s.page!=='settings'){clearTimeout(highlightTimer.current);setVersionHighlight(false);}
  },[s.page,!!s.confirmation,s.versionJump,s.settingsReady,s.settingsBusy]);
  React.useLayoutEffect(()=>{
    const old=focusedRow.current;
    if(!old||old.isConnected)return;
    focusedRow.current=null;
    if(s.page==='plugins'&&!s.confirmation&&document.activeElement===document.body){
      const target=panel.current?.querySelector('.codlet-filters [aria-pressed=true]')??panel.current?.querySelector('[data-codlet-plugin-search]');
      target?.focus({preventScroll:true});
    }
  });
  React.useEffect(()=>{const changed=()=>manager.setVisible(document.visibilityState!=='hidden');changed();document.addEventListener('visibilitychange',changed);return()=>document.removeEventListener('visibilitychange',changed);},[]);
  const settings=s.page==='settings',notices=versionWarnings(s);
  const navigation=<div className="codlet-top-toolbar"><nav className="codlet-top-navigation" aria-label={t('Codlet pages')}>{[['plugins','Plugin management'],['settings','Settings']].map(([page,label])=><C.Button key={page} color="secondary" variant={(settings?'settings':'plugins')===page?'soft':'ghost'} size="sm" aria-label={t(label)} aria-current={(settings?'settings':'plugins')===page?'page':undefined} disabled={!!s.confirmation} onClick={()=>page==='settings'?manager.settingsPage():manager.pluginsPage()}>{t(label)}</C.Button>)}</nav>
    {s.page==='plugins'&&!s.confirmation&&<div className="codlet-toolbar-actions"><IconAction icon={I.Regenerate} label="Refresh plugins" disabled={s.loading&&!manager.pending} loading={s.loading} onClick={()=>manager.refresh()}/>
      {s.localManagement?.available&&<C.Menu><C.Menu.Trigger><C.Button color="primary" variant="solid" size="sm" aria-label={t('Add')} disabled={mutationBusy(s)||s.loading||s.listStale}>{t('Add')}<I.ChevronDown/></C.Button></C.Menu.Trigger>
        <C.Menu.Content align="end" minWidth={180}><C.Menu.Item disabled={s.createBusy} onSelect={()=>manager.createPlugin()}><I.Cube/>{t('Create plugin')}</C.Menu.Item><C.Menu.Item onSelect={()=>manager.importPage()}><I.Plus/>{t('Import plugin')}</C.Menu.Item></C.Menu.Content>
      </C.Menu>}
    </div>}
  </div>;
  return <>{toolbar&&ui.createPortal(navigation,toolbar)}<section ref={panel}
    onFocusCapture={event=>{if(!s.confirmation)lastFocus.current=event.target.closest('[data-codlet-focus-key]')?.dataset.codletFocusKey??null;focusedRow.current=event.target.closest('[data-codlet-plugin]')?event.target:null;}}
    onBlurCapture={event=>{if(event.relatedTarget||event.target.isConnected&&!event.target.disabled)focusedRow.current=null;}}
    onPointerDownCapture={event=>{if(!event.target.closest('[data-codlet-plugin]'))focusedRow.current=null;}}
    data-codlet-panel="codlet" data-codlet-view={s.confirmation?'confirmation':s.page} aria-label={t(s.confirmation?'Confirm action':settings?'Settings':'Codlet')}>
    <div className="codlet-scroll">
      <header className="codlet-heading codlet-width"><div className="codlet-heading-inner">
        <div className="codlet-brand">{!settings&&<CodletIcon size={32}/>}<h1 data-codlet-page-heading="" tabIndex={-1}>{settings?t('Settings'):'Codlet'}</h1>{!settings&&<><span className="codlet-version">{s.runtimeVersion}</span>{s.page==='plugins'&&<SkillHelp s={s}/>} {notices.length>0&&<IconAction icon={I.ExclamationMarkCircle} iconClassName="codlet-warning-icon" label={notices.join('\n')+'\n'+t('View version information in settings')} onClick={()=>manager.settingsPage(true)} disabled={!!s.confirmation}/>}</>}</div>
        <p className="codlet-subtitle">{descriptionText(t(settings?'Manage Codlet preferences and version updates.':'Create or manage Codlet plugins'))}</p>
      </div></header>
      {s.page==='plugins'&&!s.confirmation?<PluginList s={s}/>:<div className="codlet-body codlet-width">{s.confirmation?<Confirmation s={s}/>:s.page==='import'?<ImportPage s={s}/>:s.page==='details'?<Details s={s}/>:<Settings s={s} highlight={versionHighlight}/>}</div>}
    </div>
  </section></>;
}
function App({toolbar}){
  const s=React.useSyncExternalStore(manager.subscribe,manager.snapshot);
  return <><style>{layout}</style><Page s={s} toolbar={toolbar}/></>;
}
export function deactivate(){epoch++;ui?.dispose();manager?.dispose();manager=ui=null;}
export async function activate(context){
    deactivate();const current=epoch;context.onDeactivate(deactivate);
    try{
      if(context.ui?.api!==2)throw new Error('Update the renderer runtime for official UI components');
      ui=context.ui.create();({React,components:C,icons:I}=ui);h=React.createElement;manager=new Manager(context);
      Settings=createSettingsView({React,C,I,manager,t,Copy,mutationBusy});CodletIcon=createCodletIcon(React);
      const owned=manager;
      await ui.page({label:'Codlet',icon:'Cube',toolbar:true,render:({toolbar})=> <App toolbar={toolbar}/>,onActivate:()=>owned.open(document.visibilityState!=='hidden'),onDeactivate:()=>owned.close()});
    }catch(error){if(current===epoch){ui?.dispose();manager?.dispose();context.reportDiagnostic?.({code:'gui_ui_unavailable',message:String(error?.message??error)});}}
}
