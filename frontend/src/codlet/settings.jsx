// Components use the owner's React instance and public SDK controls.
import {descriptionText} from './messages.js';
export function createSettingsView({React,C,I,manager,t,Copy,mutationBusy}){
  const h=React.createElement;
  function Row({label,description,children}){return <div className="codlet-setting-row"><div className="codlet-setting-copy"><div className="codlet-setting-label">{t(label)}</div><Copy>{t(description)}</Copy></div><div className="codlet-setting-control">{children}</div></div>;}
  return function Settings({s,highlight=false}){
    const config=s.settings,r=s.update,phase=r?.phase,client=s.clientStatus,o=s.officialUpdate;
    const combinedBusy=manager.combiningUpdates(),showCombined=combinedBusy||o?.available&&o.restartPreserved&&r?.installAvailable&&['available','downloaded'].includes(phase)&&(o.isUpdateReady||o.phase==='downloading');
    const disabled=s.settingsBusy||s.settingsUncertain||mutationBusy(s),updatesDisabled=s.updateBusy||s.updateUncertain||mutationBusy(s)||combinedBusy;
    const updateRunning=['checking','downloading','installRequested'].includes(phase),summary=manager.pluginSummary();
    const texts={development:'This development build has no configured update source.',idle:'Codlet updates have not been checked yet.',checking:'Checking for updates...',upToDate:'Codlet is up to date.',available:`Codlet ${r?.candidate?.version||''} is available.`,downloading:r?.totalBytes?`Downloading update: ${Math.min(100,Math.round(r.downloadedBytes/r.totalBytes*100))}%`:'Downloading update...',downloaded:`Codlet ${r?.candidate?.version||''} is ready to install.`,installRequested:'Installation was requested. Follow the update process to restart Codlet.',failed:`Update failed.\n${r?.error?.message||''}`};
    return <div className="codlet-settings">
      <section aria-labelledby="codlet-basic-heading"><h2 id="codlet-basic-heading">{t('Basic settings')}</h2>
        {s.settingsError&&<Copy error role="alert">{t(s.settingsError)}</Copy>}
        {!config?<><Copy role="status">{t(s.settingsBusy?'Loading settings...':'Settings are unavailable or incomplete.')}</Copy>{!s.settingsBusy&&<C.Button color="secondary" variant="soft" size="md" onClick={()=>manager.loadSettings()}>{t('Retry settings')}</C.Button>}</>:<>
          <Row label="Automatically check for Codlet updates" description={config.availability.updateChecks?'Check for Codlet releases in the background. Downloads and installation remain manual.':'This development build has no configured update source.'}>
            <C.Switch aria-label={t('Automatically check for Codlet updates')} checked={config.effective.automaticUpdateChecks} disabled={disabled||!config.availability.updateChecks} onCheckedChange={value=>manager.saveSettings({automaticUpdateChecks:value})}/>
          </Row>
          <Row label="Check for plugin updates at startup" description="Check plugins imported from GitHub once when Codlet starts. Downloads and installation remain manual.">
            <C.Switch aria-label={t('Check for plugin updates at startup')} checked={config.effective.checkPluginUpdatesOnStartup} disabled={disabled||!config.availability.pluginUpdateChecks} onCheckedChange={value=>manager.saveSettings({checkPluginUpdatesOnStartup:value})}/>
          </Row>
          <Row label="Show plugin tags" description="Show literal labels after plugin versions in the management list.">
            <C.Switch aria-label={t('Show plugin tags')} checked={config.effective.showPluginTags} disabled={disabled} onCheckedChange={value=>manager.saveSettings({showPluginTags:value})}/>
          </Row>
          <Row label="Reload local plugins when files change" description="Automatically reloads running local plugins after files are saved.">
            <C.Switch aria-label={t('Reload local plugins when files change')} checked={config.effective.localSourceAutoReload} disabled={disabled||!config.availability.localSourceWatch} onCheckedChange={value=>manager.saveSettings({localSourceAutoReload:value})}/>
          </Row>
          {s.settingsUncertain&&<C.Button color="secondary" variant="soft" size="md" disabled={s.settingsBusy} onClick={()=>manager.loadSettings()}>{t('Reload saved settings')}</C.Button>}
        </>}
      </section>
      <section aria-labelledby="codlet-folders-heading"><h2 id="codlet-folders-heading">{t('Files and troubleshooting')}</h2>
        <Row label="Installation directory" description="Open the folder containing this Codlet installation."><C.Button color="secondary" variant="soft" size="sm" aria-label={t('Open installation directory')} disabled={!!s.folderBusy} loading={s.folderBusy==='installation'} onClick={()=>manager.openRuntimeFolder('installation')}><I.FolderOpen/>{t('Open folder')}</C.Button></Row>
        <Row label="Error logs" description="Open this runtime’s local error logs for troubleshooting."><C.Button color="secondary" variant="soft" size="sm" aria-label={t('Open error logs')} disabled={!!s.folderBusy} loading={s.folderBusy==='logs'} onClick={()=>manager.openRuntimeFolder('logs')}><I.FolderOpen/>{t('Open folder')}</C.Button></Row>
        {s.folderError&&<Copy error role="alert">{t(s.folderError)}</Copy>}
      </section>
      <section aria-labelledby="codlet-plugin-summary-heading"><h2 id="codlet-plugin-summary-heading">{t('Plugin information')}</h2>
        {s.listStale||s.loading?<Copy role="status">{t(s.loading?'Loading plugins...':'Plugin state could not be refreshed.')}</Copy>:<dl className="codlet-plugin-summary">
          {[['Installed plugins','total'],['Running normally','healthy'],['Not enabled','disabled'],['Needs attention','attention']].map(([label,key])=><div key={key}><dt>{t(label)}</dt><dd>{summary[key]}</dd></div>)}
        </dl>}
      </section>
      <section id="codlet-version-section" className={highlight?'codlet-version-highlight':''} aria-labelledby="codlet-version-heading">
        <div className="codlet-section-heading"><h2 id="codlet-version-heading" tabIndex={-1}>{t('Version information')}</h2><C.Button color="secondary" variant="soft" size="sm" aria-label={t('Check for Codlet updates')} disabled={updatesDisabled||updateRunning} loading={phase==='checking'||s.updateBusy} onClick={()=>manager.loadUpdate('checkRuntimeUpdate')}><I.Regenerate/>{t('Check for updates')}</C.Button></div>
        {highlight&&<p className="codlet-sr-only" role="status">{t('Version information is highlighted below.')}</p>}
        <dl className="codlet-version-details">
          {[['Codlet version',r?.currentVersion||s.runtimeVersion||t('Not available')],['Current client version',client?.runningVersion||t('Not available')],['Codlet adapted version',client?.adaptedVersions?.join(', ')||t('Not available')]].map(([label,value])=><React.Fragment key={label}><dt>{t(label)}</dt><dd>{value}</dd></React.Fragment>)}
        </dl>
        {r&&<Copy role="status">{t(texts[phase]||'Version information is unavailable.')}</Copy>}
        {[...new Set([s.versionError,s.updateError].filter(Boolean))].map(error=><Copy key={error} error role="alert">{t(error)}</Copy>)}
        {r?.candidate?.releaseUrl&&<C.TextLink href={r.candidate.releaseUrl} target="_blank" rel="noopener noreferrer">{t('Release details')}</C.TextLink>}
        <C.Dialog.Root open={!!s.combinedConfirmation} onOpenChange={open=>{if(!open)manager.cancelCombinedInstall();}}>
        <div className="codlet-actions">
          {phase==='available'&&<C.Button color="primary" size="md" disabled={updatesDisabled} onClick={()=>manager.loadUpdate('downloadRuntimeUpdate')}><I.Download/>{t('Download update')}</C.Button>}
          {phase==='downloaded'&&(r.installAvailable?<C.Button color="primary" size="md" data-codlet-focus-key="install:page" disabled={updatesDisabled} onClick={()=>manager.requestInstall()}><I.ArrowRotateCw/>{t('Install and restart')}</C.Button>:<Copy>{t(`Automatic installation is unavailable for this launch.\n${r.unavailableReason||''}`)}</Copy>)}
          {showCombined&&<C.Dialog.Trigger asChild><C.Button color="secondary" variant="soft" size="md" className="codlet-combined-update" disabled={updatesDisabled||!manager.canCombineUpdates()} loading={combinedBusy} onClick={()=>manager.requestCombinedInstall()}><I.ArrowRotateCw/>{t(combinedBusy?'Updating together...':'Update both')}</C.Button></C.Dialog.Trigger>}
        </div>
        {showCombined&&!combinedBusy&&o.phase==='downloading'&&<Copy role="status">{t('Waiting for the client update to finish downloading')}</Copy>}
        {combinedBusy&&<Copy role="status">{t(o.combinedPhase==='downloading'?'Preparing the Codlet update...':o.combinedPhase==='preparing'?'Verifying both updates...':'Installing the client update, then restarting through Codlet...')}</Copy>}
        {o?.combinedPhase==='failed'&&o.error&&<Copy error role="alert">{t(o.error)}</Copy>}
          <C.Dialog.Portal><C.Dialog.Overlay className="codlet-help-overlay"/><C.Dialog.Content className="codlet-help-dialog codlet-combined-dialog">
            <div className="codlet-help-heading"><C.Dialog.Title>{t('Update Codlet and the client together')}</C.Dialog.Title></div>
            <C.Dialog.Description>{descriptionText(t('The current client will restart and running local tasks will be interrupted.'))}</C.Dialog.Description>
            <dl className="codlet-version-details"><dt>Codlet</dt><dd>{r?.currentVersion} → {r?.candidate?.version}</dd><dt>{t('Client')}</dt><dd>{t('Update prepared by the official client')}</dd></dl>
            <Copy>{t('After updating, launch through Codlet with your plugins and settings preserved')}</Copy>
            {s.combinedConfirmation?.error&&<Copy error role="alert">{t(s.combinedConfirmation.error)}</Copy>}
            <div className="codlet-confirmation-actions"><C.Button color="secondary" variant="soft" disabled={s.updateBusy} onClick={()=>manager.cancelCombinedInstall()}>{t('Cancel')}</C.Button><C.Button color="primary" disabled={s.updateBusy} loading={s.updateBusy} onClick={()=>manager.confirmCombinedInstall()}>{t('Update and restart')}</C.Button></div>
          </C.Dialog.Content></C.Dialog.Portal>
        </C.Dialog.Root>
      </section>
    </div>;
  };
}
