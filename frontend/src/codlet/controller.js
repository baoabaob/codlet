import { createMessages, PERMISSION_COPY } from './messages.js';
import { skillPrompt } from './creation.js';
import { validUpdate, validOfficialUpdate, validPluginUpdates, validPluginInstall, busyUpdatePhases, validateSettings } from './versions.js';
const capability = { name: 'codlet.runtime.manage', api: 1, scope: 'target' };
const digest = value => typeof value === 'string' && /^[a-f0-9]{64}$/.test(value);
const message = error => String(error?.message ?? error);
const updateIdentity = value => value?.candidate?.id && value?.candidate?.version ? `${value.candidate.id}:${value.candidate.version}` : null;
const githubTimeout = kind => kind==='releases' ? 'Reading GitHub releases timed out. Check the connection or proxy, then try again.' : 'Preparing the GitHub package timed out. No installation was submitted. Try again.';

export class Manager {
  constructor(context) {
    this.context = context; this.messages = createMessages(context);
    this.listeners = new Set(); this.timers = new Map(); this.sequence = { list:0, page:0, removal:0, update:0, version:0, settings:0 };
    this.visible=true;
    this.alive = true; this.job = null; this.pending = null; this.updateCommand = null;this.settingsWrite=null;
    this.state = { open:false, page:'plugins', plugins:[], query:'', filter:'all', loading:false, error:'', operationError:'', listError:'', listStale:false, operationStatus:'',
      runtimeVersion:'', clientStatus:null, localManagement:null, githubAvailable:false, runtimeSkill:null, confirmation:null,createBusy:false,
      mode:'local', importOperation:'install', target:null, path:'', url:'', catalog:null, release:'', asset:'',
      preview:null, importBusy:false, importStatus:'', importError:'', importWarning:null, importReviewError:'', grants:[], trusted:false, enableAfter:false, policy:{},
      details:null, detailsBusy:false, detailsError:'',
      update:null, updateBusy:false, updateUncertain:false, updateError:'', versionError:'',versionLoading:false,versionJump:0,
      officialUpdate:null,combinedConfirmation:null,
      pluginUpdates:null,pluginUpdateBusy:false,pluginUpdateError:'',pluginInstall:null,pluginInstallBusy:false,pluginInstallUncertain:false,pluginInstallError:'',folderBusy:null,folderError:'',
      settings:null,settingsBusy:false,settingsReady:false,settingsError:'',settingsUncertain:false, jobRetry:false, locale:context.i18n?.locale ?? 'en' };
    this.unsubscribeLocale = context.i18n?.onChange?.(() => this.set({locale:context.i18n.locale}));
  }
  subscribe = fn => { this.listeners.add(fn); return () => this.listeners.delete(fn); };
  snapshot = () => this.state;
  set(patch) { if (!this.alive) return; this.state = {...this.state,...patch}; this.state.error=[this.state.operationError,this.state.listError].filter(Boolean).join('\n'); for (const fn of this.listeners) fn(); }
  rpc(method, params = null) { return this.context.rpc.request(capability, method, params); }
  createPlugin(){return this.openSkillTask('create');}
  quickStart(){return this.openSkillTask('help');}
  reviewImport(){return this.openSkillTask('review',this.state.preview);}
  uninstallWithCodex(){return this.openSkillTask('remove',this.state.details);}
  removalRequiresCli(plugin){return !!plugin&&(plugin.id===this.context.pluginId||plugin.disableDependents?.includes(this.context.pluginId)===true);}
  async openSkillTask(mode,subject=null){
    const page=mode==='review'?'import':mode==='remove'?'details':'plugins',errorKey=mode==='review'?'importReviewError':mode==='remove'?'detailsError':'operationError';
    if(!this.available()||this.state.createBusy||this.state.page!==page)return false;
    if(mode==='review'&&(!this.state.importWarning||this.state.importWarning.preview!==subject)||mode==='remove'&&(!subject||this.state.detailsBusy||!this.removalRequiresCli(subject)))return false;
    const sequence=this.sequence.page;
    this.set({createBusy:true,[errorKey]:''});
    try{
      const selected=mode==='remove'?{...subject,name:this.messages.name(subject)}:subject;
      const prompt=skillPrompt(this.state.runtimeSkill,this.state.locale,mode,selected);
      const reply=await this.context.rpc.request({name:'codex.ui.navigation.page',api:1,scope:'target'},'newTaskDraft',{prompt});
      if(reply?.opened!==true||reply.submitted!==false)throw new Error('The new task could not be opened.');
      if(mode==='review'&&this.current('page',sequence,page))this.cancelImportWarning();
      return true;
    }catch(error){if(this.current('page',sequence,page))this.set({[errorKey]:this.state.runtimeSkill?.available?'The new task could not be opened.':'The Codlet skill is unavailable. Refresh or restart Codlet and try again.'});return false;}
    finally{if(this.alive)this.set({createBusy:false});}
  }
  clearTimer(name) { clearTimeout(this.timers.get(name)); this.timers.delete(name); }
  after(name, delay, fn) { this.clearTimer(name); this.timers.set(name,setTimeout(()=>{this.timers.delete(name); if(this.alive) void fn();},delay)); }
  current(channel, sequence, page) { return this.alive && this.state.open && this.sequence[channel] === sequence && (!page || this.state.page === page); }
  available() { return this.alive && this.state.open && !this.state.listStale && !this.pending && !this.state.confirmation && !this.state.combinedConfirmation && !this.combiningUpdates() && !this.installingPlugins(); }
  installingPlugins(){return this.state.pluginInstallBusy||this.state.pluginInstallUncertain||this.state.pluginInstall?.running===true;}
  checkingPlugins(){return this.state.pluginUpdateBusy||this.state.pluginUpdates?.phase==='checking';}
  githubPlugins(){return this.state.plugins.filter(p=>p.registered!==false&&p.ownership==='core-managed-github');}
  updateCandidates(){return this.githubPlugins().filter(p=>this.pluginUpdate(p)?.status==='available');}
  pluginSummary(){
    const plugins=this.state.plugins.filter(p=>p.registered!==false);
    const healthy=p=>p.enabled===true&&p.active===true&&p.validation?.status==='ok'&&!p.execution?.error;
    return {total:plugins.length,healthy:plugins.filter(healthy).length,disabled:plugins.filter(p=>p.enabled===false).length,
      attention:plugins.filter(p=>p.enabled===true&&!healthy(p)).length};
  }
  pluginCheckMessage(){
    const s=this.state,status=s.pluginUpdates;
    if(this.checkingPlugins())return 'Checking plugin updates...';
    if(!status||status.phase==='idle')return '';
    if(status.phase==='failed')return 'Plugin update check failed.';
    if(!this.githubPlugins().length)return 'No GitHub plugins to check.';
    if(this.githubPlugins().some(p=>!this.pluginUpdate(p)))return 'Check again to refresh plugin update status';
    if(this.githubPlugins().some(p=>!['available','upToDate'].includes(this.pluginUpdate(p)?.status)))return 'Some plugins could not be checked. Try again or open their details.';
    return this.updateCandidates().length?'':'GitHub plugins are up to date';
  }
  installState(plugin){const item=this.state.pluginInstall?.items.find(item=>item.pluginId===plugin.id);if(!item)return null;if(item.phase==='updated')return item.version===plugin.version?item:null;return !this.state.pluginInstall.running&&item.versionKey!==plugin.managedVersionKey?null:item;}
  async updatePlugins(plugins=null){
    if(!this.available()||this.checkingPlugins()||!(plugins??this.updateCandidates()).length)return;
    this.set({pluginInstallBusy:true,pluginInstallError:''});
    try{const reply=await this.rpc('updatePlugins',{pluginIds:(plugins??this.updateCandidates()).map(p=>p.id)});if(!validPluginInstall(reply))throw Error('Plugin update status is unavailable.');this.set({pluginInstall:reply,pluginInstallUncertain:false});if(!reply.running)void this.refresh();}
    catch(error){this.set({pluginInstallError:message(error),pluginInstallUncertain:true});}
    finally{this.set({pluginInstallBusy:false});if(this.state.open&&this.visible)void this.pollVersions();}
  }
  async reviewPluginUpdate(plugin){
    if(!this.available())return;
    const batch=this.state.pluginInstall?.id;if(!batch)return;
    this.invalidateImport();const sequence=this.sequence.page;
    this.set({page:'import',mode:'github',target:plugin,importOperation:'update',importBusy:true,catalog:null,release:'',asset:'',importStatus:'Loading update review...',importError:''});
    try{const p=await this.rpc('pluginUpdateReview',{batchId:batch,pluginId:plugin.id});if(!this.current('page',sequence,'import'))return;this.validatePreview(p,true);this.set({preview:p,trusted:true,grants:p.manifest.permissions.filter(permission=>p.existingRegistration?.grants?.includes(permission)),enableAfter:p.existingEnabled===true,policy:Object.fromEntries(Object.entries(p.existingRegistration?.brokerPolicy??{}).map(([key,value])=>[key,value.join('\n')])),importStatus:'Review the changed permissions and dependencies before installing.'});}
    catch(error){if(this.current('page',sequence,'import'))this.set({importStatus:message(error)});}
    finally{if(this.current('page',sequence,'import'))this.set({importBusy:false});}
  }
  async open(visible=true) { if (this.state.open) return; this.visible=visible;this.set({open:true});return Promise.all([this.pending?.id?this.checkMutation():this.refresh(),this.pollVersions(),this.loadSettings(false,true)]); }
  setVisible(visible){if(this.visible===visible)return;this.visible=visible;this.clearTimer('version');this.sequence.version++;this.set({versionLoading:false});if(visible&&this.state.open)void this.pollVersions();}
  close() {
    if (this.pending && !this.pending.submitted) this.pending.cancelled = true;
    this.set({open:false, page:'plugins', confirmation:null,combinedConfirmation:null});
    for (const name of [...this.timers.keys()]) this.clearTimer(name);
    this.sequence.list++; this.sequence.update++; this.sequence.removal++;this.sequence.version++;this.sequence.settings++;
    this.invalidateImport();
  }
  dispose() {
    if (!this.alive) return;
    this.close(); this.alive=false; this.unsubscribeLocale?.(); this.listeners.clear();
  }
  async refresh() {
    if (!this.alive || !this.state.open) return;
    if (this.pending) return this.pending.id ? this.checkMutation() : undefined;
    const sequence=++this.sequence.list; this.set({loading:true,listError:''});
    try {
      const reply=await this.rpc('list');
      if (!this.current('list',sequence)) return;
      if (!Array.isArray(reply?.plugins) || reply.plugins.some(p=>!p || typeof p.id!=='string' || !p.id) || new Set(reply.plugins.map(p=>p.id)).size!==reply.plugins.length) throw new Error('Plugin list unavailable');
      this.set({plugins:reply.plugins,listStale:false,localManagement:reply.localManagement??null,githubAvailable:reply.githubManagement?.available===true,
        runtimeVersion:reply.runtimeVersion??'',runtimeSkill:reply.runtimeSkill??null});
    } catch(error) { if(this.current('list',sequence)) this.set({listStale:true,listError:'Plugin state could not be refreshed. Displayed values may be out of date.\n'+(error?.code==='rpc_timeout'?'Plugin list timed out. Refresh to try again.':message(error))}); }
    finally { if(this.current('list',sequence)) this.set({loading:false}); }
  }
  filtered() {
    const terms=this.state.query.trim().toLowerCase().split(/\s+/).filter(Boolean);
    return this.state.plugins.filter(plugin=>{
      if(this.state.filter!=='all'&&plugin.enabled!==(this.state.filter==='enabled'))return false;
      const tags=(plugin.tags??[]).map(tag=>tag.toLowerCase());
      const text=[plugin.id,plugin.name,plugin.description,plugin.i18n?.zh?.name,plugin.i18n?.zh?.description,plugin.i18n?.en?.name,plugin.i18n?.en?.description,...tags].filter(value=>typeof value==='string').join(' ').toLowerCase();
      return terms.every(term=>term.startsWith('#')?tags.includes(term.slice(1)):text.includes(term));
    });
  }
  pluginUpdate(plugin){const result=this.state.pluginUpdates?.plugins[plugin.id];return result?.versionKey===plugin.managedVersionKey?result:null;}
  async checkPluginUpdates(){
    if(!this.available()||!this.state.githubAvailable||this.checkingPlugins()||!this.githubPlugins().length)return;
    this.set({pluginUpdateBusy:true,pluginUpdateError:''});
    try{const reply=await this.rpc('checkPluginUpdates');if(!validPluginUpdates(reply))throw new Error('Plugin update status is unavailable.');if(this.alive)this.set({pluginUpdates:reply});}
    catch(error){if(this.alive)this.set({pluginUpdateError:message(error)});}
    finally{if(this.alive){this.set({pluginUpdateBusy:false});if(this.state.open&&this.visible)void this.pollVersions();}}
  }
  setQuery(query) { this.set({query}); }
  async openRuntimeFolder(location){
    if(!this.alive||!this.state.open||this.state.folderBusy||!['installation','logs'].includes(location))return;
    this.set({folderBusy:location,folderError:''});
    try{const reply=await this.rpc('openRuntimeFolder',{location});if(reply?.opened!==true)throw new Error('The folder open request was not confirmed.');}
    catch(error){if(this.alive)this.set({folderError:message(error)});}
    finally{if(this.alive)this.set({folderBusy:null});}
  }
  setFilter(filter){if(['all','enabled','disabled'].includes(filter))this.set({filter});}
  async mutate(pluginId, action, extra = {}, name) {
    if (!this.available()) return;
    const expected={pluginId,action,name:name||this.messages.name(this.state.plugins.find(p=>p.id===pluginId)??{id:pluginId}),id:null,checking:false,deleteSource:!!extra.remove_source};
    this.pending=expected; this.set({operationError:'',operationStatus:`${expected.name}: preparing...`});
    try {
      const prepared=await this.rpc('prepare',{action,plugin_id:pluginId,...extra});
      if (!this.alive || this.pending!==expected) return;
      if(prepared?.status!=='prepared' || typeof prepared.operation?.operation_id!=='string' || !prepared.operation.operation_id ||
        prepared.operation.request?.plugin_id!==pluginId || prepared.operation.request?.action!==action)
        return this.finishMutation(expected,prepared?.error||'The action could not be prepared.');
      if(expected.cancelled) return this.finishMutation(expected);
      expected.id=prepared.operation.operation_id;
      // Submit this server-issued receipt once. Lost replies can only query the same receipt.
      expected.submitted=true;
      let submitted; try { submitted=await this.rpc('submit',{operationId:expected.id}); } catch {}
      if(!this.alive || this.pending!==expected) return;
      if(['busy','not_ready','stopping','expired','stale_host','invalid_request','not_running'].includes(submitted?.status)) return this.finishMutation(expected,submitted.error||'The action was not submitted. Try again when the runtime is ready.');
      return this.checkMutation(expected);
    } catch(error) { if(this.alive && this.pending===expected) return this.finishMutation(expected,message(error)); }
  }
  async checkMutation(expected=this.pending) {
    if(!expected?.id || this.pending!==expected || expected.checking) return;
    this.clearTimer('mutation'); expected.checking=true;
    try {
      const reply=await this.rpc('operation',{operationId:expected.id});
      if(!this.alive || this.pending!==expected) return;
      const operation=reply?.operation;
      if(operation?.operation_id!==expected.id || operation.request?.plugin_id!==expected.pluginId || operation.request?.action!==expected.action) {
        this.set({operationError:reply?.error||'Action status is no longer available. The action has not been repeated.'}); return;
      }
      if(reply.status==='completed') {
        const result=operation.completion, report=result?.kind==='report'?result.report:null;
        const success=['applied','unchanged'].includes(report?.outcome);
        // Removal's applied report also covers a skipped optional deletion. Keep
        // that actionable explanation, suppress the audited successful receipt.
        const deletionWarning=success && expected.deleteSource && report.message && report.message!==
          'The plugin was unregistered and its confirmed source directory was deleted. Separate plugin data was preserved.' ? report.message : '';
        return this.finishMutation(expected,success?deletionWarning:result?.error?.message||report?.message||'The action finished with an error. Refresh for the current state.');
      }
      if(!['queued','running'].includes(reply.status)) {this.set({operationError:reply?.error||'The action was not confirmed. Refresh checks the same action without repeating it.'});return;}
      this.set({operationStatus:`${expected.name}: ${reply.status==='queued'?'waiting':'updating'}...`});
      if(this.state.open) this.after('mutation',250,()=>this.checkMutation(expected));
    } catch { if(this.alive && this.pending===expected) this.set({operationError:'Action status unavailable. Refresh to check again.'}); }
    finally { expected.checking=false; }
  }
  async finishMutation(expected,error='') {
    if(this.pending!==expected) return;
    this.pending=null; this.clearTimer('mutation'); this.set({operationStatus:'',operationError:error});
    if(this.state.open) await this.refresh();
  }
  disable(plugin) {
    if(!this.available()) return;
    const dependents=(plugin.disableDependents??[]).filter(id=>id!==plugin.id);
    if(!dependents.length && plugin.id!==this.context.pluginId) return this.mutate(plugin.id,'disable');
    this.set({confirmation:{kind:'disable',plugin,dependents,busy:false,error:'',previousPage:this.state.page}});
  }
  cancelConfirmation() { if(this.state.confirmation?.submitting) return; this.sequence.removal++; this.set({confirmation:null}); }
  async requestRemoval(plugin,permission=null) {
    if(!this.available()) return;
    if(!permission&&this.removalRequiresCli(plugin))return;
    const confirmation={kind:permission?'revoke':'remove',permission,plugin,busy:!permission,submitting:false,error:'',source:null,deleteSource:false,previousPage:this.state.page};
    const sequence=++this.sequence.removal; this.set({confirmation});
    if(permission) return;
    try {
      const preview=await this.rpc('sourceRemovalPreview',{pluginId:plugin.id});
      if(!this.current('removal',sequence) || this.state.confirmation!==confirmation) return;
      if(preview?.pluginId!==plugin.id || !['available','missing','blocked'].includes(preview.status)) throw new Error('The source folder could not be checked. You can still remove registration and keep files.');
      this.set({confirmation:{...confirmation,busy:false,source:preview}});
    } catch(error) { if(this.current('removal',sequence)) this.set({confirmation:{...confirmation,busy:false,error:message(error)}}); }
  }
  sourceDeletable() { const s=this.state.confirmation?.source; return s?.status==='available' && digest(s.registrationDigest) && typeof s.sourceIdentity==='string' && !!s.sourceIdentity; }
  setDeleteSource(value) { if(this.sourceDeletable()) this.set({confirmation:{...this.state.confirmation,deleteSource:!!value}}); }
  async confirm() {
    const selected=this.state.confirmation;
    if(!selected || selected.busy || selected.submitting || this.pending) return;
    if(selected.kind==='install') {
      if (!selected.updateIdentity || selected.updateIdentity!==updateIdentity(this.state.update)) {
        this.set({confirmation:{...selected,error:'The update changed. Cancel and review it again before installing.'}});return;
      }
      this.set({confirmation:null,page:'settings'}); return this.loadUpdate('installRuntimeUpdate');
    }
    const plugin=selected.plugin, dependents=(plugin.disableDependents??[]).filter(id=>id!==plugin.id);
    if(selected.kind==='disable' && plugin.id===this.context.pluginId && !dependents.length) {
      this.set({confirmation:{...selected,submitting:true,error:''}});
      try {
        const reply=await this.rpc('disableSelf');
        if(!this.alive) return;
        if(reply?.pluginId!==plugin.id || reply.enabled!==false) throw new Error('Disable was not confirmed');
        this.set({confirmation:{...selected,submitting:true,error:'Codlet is disabled.'}});
      } catch(error) { if(this.alive) this.set({confirmation:{...selected,submitting:false,error:message(error)}}); }
      return;
    }
    const extra=selected.kind==='revoke'?{permission:selected.permission}:{};
    if(dependents.length && ['disable','remove'].includes(selected.kind)) extra.cascade=true;
    if(selected.kind==='remove' && selected.deleteSource && this.sourceDeletable()) extra.remove_source={registrationDigest:selected.source.registrationDigest,sourceIdentity:selected.source.sourceIdentity};
    this.set({confirmation:null,page:'plugins'}); this.sequence.removal++;
    return this.mutate(plugin.id,selected.kind,extra);
  }
  cancelJob() {
    const job=this.job; this.job=null; this.clearJobTimers();
    if(job?.id) void this.rpc('cancelGitHubJob',{jobId:job.id}).catch(()=>{});
  }
  clearJobTimers(){for(const name of ['github','github-slow','github-deadline'])this.clearTimer(name);}
  invalidateImport() {
    this.cancelJob(); this.clearTimer('preview'); this.clearTimer('picker'); this.sequence.page++;
    this.set({preview:null,importBusy:false,importWarning:null,importReviewError:'',grants:[],trusted:false,enableAfter:false,policy:{},jobRetry:false});
  }
  back() {
    if(this.pending) return;
    this.invalidateImport(); this.clearTimer('update'); this.sequence.update++;
    this.set({page:'plugins',details:null,updateBusy:false}); return this.refresh();
  }
  importPage(mode='local',target=null) {
    if(!this.available()) return;
    this.invalidateImport();
    this.set({page:'import',mode,target,importOperation:target?'update':'install',catalog:null,release:'',asset:'',url:target?.managedSource?.repositoryUrl??this.state.url,importStatus:'',importError:''});
    if(mode==='local' && this.state.path.trim()) this.setPath(this.state.path);
    if(mode==='github' && target) return this.readReleases();
  }
  setPath(path,composing=false) {
    this.invalidateImport(); this.set({path,importStatus:'',importError:''});
    if(composing || !path.trim()) return;
    if(!/^(?:[A-Za-z]:[\\/]|\\\\[^\\]+\\[^\\]+|\/)/.test(path.trim())) {this.set({importStatus:'Enter the full path to a plugin folder.'});return;}
    this.set({importStatus:'Checking the selected folder...'});
    const sequence=this.sequence.page;
    this.after('preview',400,()=>{if(this.current('page',sequence,'import')) return this.inspectLocal();});
  }
  validatePreview(preview,managed=false,selection=null) {
    if(preview?.schema!==1 || preview.kind!==(managed?'codlet.managed-preview':'codlet.local-import-preview') ||
      typeof preview.path!=='string' || typeof preview.manifest?.id!=='string' || !preview.manifest.id || typeof preview.manifest?.version!=='string' ||
      !Array.isArray(preview.manifest.permissions) || preview.manifest.permissions.some(p=>!Object.hasOwn(PERMISSION_COPY,p)) || !digest(preview.contentDigest) || !digest(preview.registrationDigest)) throw new Error('The import preview is incomplete.');
    if(managed && (preview.operation!==this.state.importOperation || preview.ownership!=='core-managed-github' || !digest(preview.source?.sha256) ||
      typeof preview.source.repositoryUrl!=='string' || typeof preview.source.tag!=='string' || typeof preview.source.assetName!=='string' ||
      (this.state.target && preview.manifest.id!==this.state.target.id) ||
      (selection && (preview.source.repositoryUrl!==selection.repositoryUrl || preview.source.releaseId!==selection.releaseId || preview.source.assetId!==selection.assetId)))) throw new Error('The managed package preview is incomplete or does not match the selected plugin and release asset.');
  }
  async inspectLocal() {
    if(!this.available() || this.state.page!=='import' || this.state.mode!=='local') return;
    this.invalidateImport(); const sequence=this.sequence.page;
    this.set({importBusy:true,importStatus:'Checking the manifest and JavaScript entries...',importError:''});
    try {
      const preview=await this.rpc('previewLocal',{path:this.state.path.trim()});
      if(!this.current('page',sequence,'import')) return;
      this.validatePreview(preview); this.set({preview,importStatus:'Plugin recognized. Choose permissions to import.'});
    } catch(error) { if(this.current('page',sequence,'import')) this.set({importStatus:'This folder could not be recognized as a plugin. Check the path and codlet.json.',importError:message(error)}); }
    finally {if(this.current('page',sequence,'import')) this.set({importBusy:false});}
  }
  async chooseFolder() {
    if(!this.available() || this.state.importBusy || this.state.page!=='import') return;
    this.invalidateImport(); const sequence=this.sequence.page;
    this.set({importBusy:true,importStatus:'Choose a plugin folder in the Windows dialog.',importError:''});
    const fail=error=>{if(this.current('page',sequence,'import')) this.set({importBusy:false,importStatus:message(error)});};
    const accept=async selection=>{
      if(!this.current('page',sequence,'import')) return;
      if(selection?.status==='selecting' && typeof selection.selectionId==='string') this.after('picker',300,async()=>{try{await accept(await this.rpc('folderSelection',{selectionId:selection.selectionId}));}catch(error){fail(error);}});
      else if(selection?.status==='selected' && typeof selection.path==='string') {this.set({path:selection.path,importBusy:false});await this.inspectLocal();}
      else this.set({importBusy:false,importStatus:selection?.status==='cancelled'?'Folder selection cancelled.':selection?.error||'Folder selection failed. Enter the full path instead.'});
    };
    try {await accept(await this.rpc('chooseLocalFolder',{locale:this.context.i18n?.locale??'en'}));}catch(error){fail(error);}
  }
  grant(permission,value) { if(!this.state.preview?.manifest.permissions.includes(permission)) return; this.set({grants:value?[...new Set([...this.state.grants,permission])]:this.state.grants.filter(p=>p!==permission)}); }
  importReady() {const s=this.state;return this.available() && s.page==='import' && !!s.preview && !s.importBusy && !s.createBusy && s.trusted && s.preview.manifest.permissions.every(p=>s.grants.includes(p));}
  submitImport() {
    if(!this.importReady()||this.state.importWarning) return;
    this.set({importWarning:{preview:this.state.preview,sequence:this.sequence.page},importReviewError:''});
  }
  cancelImportWarning(){this.set({importWarning:null,importReviewError:''});}
  confirmImport(){
    const warning=this.state.importWarning;
    if(!warning||warning.preview!==this.state.preview||warning.sequence!==this.sequence.page||!this.importReady())return;
    this.set({importWarning:null,importReviewError:''});
    const s=this.state,p=s.preview;
    const policyPermissions={readRoots:['host.fs'],writeRoots:['host.fs.write'],watchRoots:['host.fs.watch'],networkOrigins:['host.network'],executables:['host.process','host.process.spawn'],cwdRoots:['host.process.spawn'],envKeys:['host.process.spawn'],shortcuts:['core.shortcuts']};
    const brokerPolicy=Object.fromEntries(Object.entries(s.policy).filter(([key])=>policyPermissions[key]?.some(permission=>s.grants.includes(permission))).map(([key,value])=>[key,value.split(/\r?\n/).map(line=>line.trim()).filter(Boolean)]));
    const local_import={path:p.path,contentDigest:p.contentDigest,registrationDigest:p.registrationDigest,trusted:true,grants:p.manifest.permissions.filter(permission=>s.grants.includes(permission)),brokerPolicy,enable:s.enableAfter,...(s.mode==='github'?{managed:s.importOperation}:{})};
    const action=s.mode==='github' && s.importOperation!=='install'?s.importOperation:'import';
    this.invalidateImport();this.set({page:'plugins'});return this.mutate(p.manifest.id,action,{local_import},this.messages.name(p.manifest));
  }
  setUrl(url) {this.invalidateImport();this.set({url,catalog:null,release:'',asset:'',importStatus:'',importError:''});}
  selectRelease(release) {this.invalidateImport();this.set({release,asset:'',importStatus:'',importError:''});}
  selectAsset(asset) {this.invalidateImport();this.set({asset,importStatus:'',importError:''});}
  selectedRelease() {return this.state.catalog?.releases.find(release=>String(release.id)===this.state.release);}
  selectedAsset() {return this.selectedRelease()?.assets.find(asset=>String(asset.id)===this.state.asset && /\.zip$/i.test(asset.name));}
  readReleases() {
    if(this.state.importBusy || !this.available()) return;
    if(!this.state.url.trim()) {this.set({importStatus:'Enter a GitHub URL.'});return;}
    this.set({catalog:null,release:'',asset:''});
    return this.runJob('githubReleases',{url:this.state.url.trim()},'releases');
  }
  downloadAsset() {
    const release=this.selectedRelease(),asset=this.selectedAsset(); if(!release || !asset) return;
    return this.runJob('githubPrepare',{repositoryUrl:this.state.catalog.repository.url,releaseId:release.id,assetId:asset.id,operation:this.state.importOperation,...(this.state.target?{pluginId:this.state.target.id}:{})},'package');
  }
  async runJob(method,params,kind) {
    if(!this.available() || this.state.importBusy || this.state.page!=='import' || this.state.mode!=='github') return;
    this.invalidateImport(); const job={id:null,kind,sequence:this.sequence.page,selection:kind==='package'?params:null,checking:false};
    this.job=job;this.set({importBusy:true,importError:'',importStatus:kind==='releases'?'Reading GitHub releases...':'Downloading and validating the selected ZIP. No plugin is registered or enabled yet.'});
    this.after('github-slow',8000,()=>{if(this.job===job&&this.current('page',job.sequence,'import')&&!this.state.jobRetry)this.set({importStatus:'GitHub is taking longer than usual. You can cancel and try again.'});});
    // Bound the visible wait even if the initial RPC or a status reply is lost.
    // These jobs only prepare data; the separate installation receipt is never retried.
    this.after('github-deadline',kind==='releases'?30000:135000,()=>{
      if(this.job!==job||!this.current('page',job.sequence,'import'))return;
      this.cancelJob();this.set({importBusy:false,jobRetry:false,importStatus:githubTimeout(kind)});
      this.context.reportDiagnostic?.({code:'github_job_timeout',message:`GitHub ${kind} UI deadline expired`});
    });
    try {
      const reply=await this.rpc(method,params);
      if(this.job!==job || !this.current('page',job.sequence,'import')) {if(reply?.jobId) void this.rpc('cancelGitHubJob',{jobId:reply.jobId}).catch(()=>{});return;}
      if(typeof reply?.jobId!=='string' || !reply.jobId) throw new Error('GitHub task did not return a job ID. No installation was submitted.');
      job.id=reply.jobId;this.acceptJob(job,reply);
    }catch(error){if(this.job===job && this.current('page',job.sequence,'import')) {this.clearJobTimers();this.job=null;this.set({importBusy:false,importStatus:error?.code==='github_timeout'?githubTimeout(kind):message(error)});}}
  }
  acceptJob(job,reply) {
    if(this.job!==job || !this.current('page',job.sequence,'import')) return;
    if(reply?.jobId!==job.id || reply.kind!==job.kind) throw new Error('GitHub task response did not match the requested job.');
    if(reply.status==='running') {this.after('github',300,()=>this.pollJob(job));return;}
    if(reply.status==='completed') {
      if(job.kind==='releases') {
        const catalog=reply.result;
        if(typeof catalog?.repository?.url!=='string' || !Array.isArray(catalog.releases) || catalog.releases.some(r=>!Number.isSafeInteger(r.id) || typeof r.tag!=='string' || !Array.isArray(r.assets) || r.assets.some(a=>!Number.isSafeInteger(a.id) || typeof a.name!=='string' || !Number.isSafeInteger(a.size) || a.size<0))) throw new Error('The GitHub release list is incomplete.');
        this.set({catalog,importStatus:catalog.releases.length?'Choose the exact release and ZIP asset.':'No published releases found. Ask the author for a built plugin ZIP, or download and inspect a local plugin folder.'});
      } else {
        this.validatePreview(reply.result,true,job.selection);
        this.set({preview:reply.result,importStatus:'Review the exact source, compatibility, dependencies and permissions before confirming.'});
      }
    } else if(['cancelled','failed'].includes(reply.status)) this.set({importStatus:reply.error?.code==='github_timeout'?githubTimeout(job.kind):reply.error?.message||'GitHub task cancelled. No installation was submitted; temporary download files may remain.'});
    else throw new Error('GitHub task returned an unknown status.');
    this.clearJobTimers();this.job=null;this.set({importBusy:false,jobRetry:false});
  }
  async pollJob(job=this.job) {
    if(!job?.id || this.job!==job || job.checking) return; job.checking=true;this.clearTimer('github');this.set({jobRetry:false});
    try {this.acceptJob(job,await this.rpc('githubJob',{jobId:job.id}));}
    catch(error){if(this.job===job && this.current('page',job.sequence,'import')) this.set({jobRetry:true,importStatus:`Task status unavailable: ${message(error)}\nCheck the same task again, or cancel. No new download or installation is started by checking.`});}
    finally {job.checking=false;}
  }
  cancelImportJob(){this.invalidateImport();this.set({importStatus:'GitHub task cancelled. Late results will be ignored. No installation was submitted; temporary download files may remain.'});}
  async details(plugin) {
    if(!this.available()) return;
    this.invalidateImport();const sequence=this.sequence.page;
    this.set({page:'details',details:plugin,detailsBusy:true,detailsError:''});
    try{
      const reply=plugin.source==='bundled'?{pluginId:plugin.id,registration:{path:'',grants:plugin.grants??[]}}:await this.rpc('permissions',{pluginId:plugin.id});
      if(!this.current('page',sequence,'details')) return;
      if(reply?.pluginId!==plugin.id || !Array.isArray(reply.registration?.grants) || typeof reply.registration.path!=='string') throw new Error('Permission details are unavailable.');
      this.set({details:{...plugin,...reply.registration,...(reply.ownership?{ownership:reply.ownership}:{}),...(reply.managedSource?{managedSource:reply.managedSource}:{}),metadata:reply.metadata}});
    }catch(error){if(this.current('page',sequence,'details')) this.set({detailsError:message(error)});}
    finally{if(this.current('page',sequence,'details')) this.set({detailsBusy:false});}
  }
  async openFolder() {
    const plugin=this.state.details,sequence=this.sequence.page;if(!plugin || this.state.detailsBusy || !this.available())return;
    this.set({detailsBusy:true,detailsError:''});
    try{const reply=await this.rpc('openFolder',{pluginId:plugin.id});if(this.current('page',sequence,'details') && (reply?.pluginId!==plugin.id || reply.opened!==true))throw new Error('The source folder could not be opened.');}
    catch(error){if(this.current('page',sequence,'details'))this.set({detailsError:message(error)});}
    finally{if(this.current('page',sequence,'details'))this.set({detailsBusy:false});}
  }
  canConfigure(){return this.alive&&this.state.open&&!this.pending&&!this.state.confirmation&&!this.state.combinedConfirmation&&!this.combiningUpdates();}
  combiningUpdates(){return ['downloading','preparing','installing'].includes(this.state.officialUpdate?.combinedPhase);}
  canCombineUpdates(){const s=this.state,o=s.officialUpdate;return !!(o?.available&&o.restartPreserved&&o.isUpdateReady&&o.phase==='ready'&&s.update?.installAvailable&&['available','downloaded'].includes(s.update.phase)&&!s.updateBusy&&!s.updateUncertain&&!this.combiningUpdates());}
  requestCombinedInstall(){if(this.canConfigure()&&this.canCombineUpdates()&&!this.updateCommand)this.set({combinedConfirmation:{identity:updateIdentity(this.state.update),error:''}});}
  cancelCombinedInstall(){if(!this.state.updateBusy)this.set({combinedConfirmation:null});}
  async confirmCombinedInstall(){
    const selected=this.state.combinedConfirmation;
    if(!selected||this.state.updateBusy||this.updateCommand)return;
    if(selected.identity!==updateIdentity(this.state.update)||!this.canCombineUpdates()){this.set({combinedConfirmation:{...selected,error:'The update changed. Cancel and review it again before installing.'}});return;}
    const operation={method:'installCombinedUpdate',inFlight:true};this.updateCommand=operation;
    const sequence=++this.sequence.update;this.sequence.version++;this.clearTimer('version');this.set({updateBusy:true,updateError:''});
    try{const reply=await this.rpc('installCombinedUpdate',{candidateId:this.state.update.candidate.id});operation.inFlight=false;if(!this.current('update',sequence))return;if(!validOfficialUpdate(reply))throw new Error('Update status is unavailable.');this.updateCommand=null;this.set({officialUpdate:reply,combinedConfirmation:null,updateUncertain:false});}
    catch(error){operation.inFlight=false;if(this.current('update',sequence))this.set({combinedConfirmation:null,updateError:message(error),updateUncertain:true});}
    finally{if(this.current('update',sequence)){this.set({updateBusy:false});if(this.visible)this.after('version',1000,()=>this.pollVersions());}}
  }
  settingsPage(jump=false){if(!this.alive||!this.state.open||this.state.confirmation)return;this.invalidateImport();this.set({page:'settings',settingsReady:false,versionJump:this.state.versionJump+(jump?1:0)});return Promise.all([this.loadSettings(),this.refresh()]);}
  pluginsPage(){if(!this.alive||!this.state.open||this.state.confirmation)return;this.invalidateImport();this.sequence.settings++;this.set({page:'plugins',settingsBusy:false});return this.refresh();}
  async loadSettings(keepError=false,allowPlugins=false){
    if(this.settingsWrite){if(this.alive&&this.state.open&&this.state.page==='settings')this.set({settingsBusy:true});return;}
    const page=this.state.page;
    if(!this.alive||!this.state.open||!['settings',...(allowPlugins?['plugins']:[])].includes(page)||this.state.settingsBusy)return;
    const sequence=++this.sequence.settings;this.set({settingsBusy:true,settingsReady:false,...(!keepError?{settingsError:''}:{})});
    try{const reply=validateSettings(await this.rpc('getSettings'));if(this.current('settings',sequence))this.set({settings:reply,settingsUncertain:false});}
    catch(error){if(this.current('settings',sequence))this.set({settingsError:message(error),settingsUncertain:true});}
    finally{if(this.current('settings',sequence))this.set({settingsBusy:false,settingsReady:true});}
  }
  async saveSettings(patch){
    const s=this.state;if(!this.canConfigure()||s.page!=='settings'||!s.settings||s.settingsBusy||s.settingsUncertain||this.settingsWrite)return;
    const values={...s.settings.values,...patch},sequence=++this.sequence.settings;
    const operation={};this.settingsWrite=operation;
    this.set({settingsBusy:true,settingsError:''});let uncertain=false;
    try{const reply=validateSettings(await this.rpc('saveSettings',{expectedRevision:s.settings.revision,values}));if(this.current('settings',sequence,'settings'))this.set({settings:reply,settingsUncertain:false});}
    catch(error){uncertain=true;if(this.current('settings',sequence,'settings'))this.set({settingsError:message(error),settingsUncertain:true});}
    finally{
      if(this.settingsWrite===operation)this.settingsWrite=null;
      if(this.current('settings',sequence,'settings')){
        this.set({settingsBusy:false});
        if(uncertain){await this.loadSettings(true);if(!this.state.settingsUncertain&&Object.entries(values).every(([key,value])=>this.state.settings?.values[key]===value))this.set({settingsError:''});}
        void this.pollVersions();
      }else if(this.alive&&this.state.open&&this.state.page==='settings'){this.set({settingsBusy:false});await this.loadSettings();}
    }
  }
  requestInstall(){if(!this.canConfigure() || this.updateCommand || this.state.updateBusy || this.state.update?.phase!=='downloaded' || !this.state.update.installAvailable)return;this.set({confirmation:{kind:'install',busy:false,error:'',previousPage:this.state.page,updateIdentity:updateIdentity(this.state.update)}});}
  async pollVersions(){
    if(!this.alive||!this.state.open||!this.visible)return;
    this.clearTimer('version');
    if(this.updateCommand?.inFlight){this.after('version',1000,()=>this.pollVersions());return;}
    const sequence=++this.sequence.version;this.set({versionLoading:true});
    try{
      const reply=await this.rpc('versionStatus');
      if(!this.current('version',sequence)||!this.visible)return;
      if(typeof reply?.runtimeVersion!=='string'||!['unknown','matched','unmatched'].includes(reply.clientStatus?.status)||(reply.runtimeUpdate!==null&&!validUpdate(reply.runtimeUpdate))||(reply.pluginUpdates!=null&&!validPluginUpdates(reply.pluginUpdates))||(reply.pluginInstall!=null&&!validPluginInstall(reply.pluginInstall)))throw new Error('Version information is unavailable.');
      if(reply.officialUpdate!=null&&!validOfficialUpdate(reply.officialUpdate))throw new Error('Version information is unavailable.');
      this.updateCommand=null;
      const settled=this.state.pluginInstall?.running&&!reply.pluginInstall?.running;
      this.set({runtimeVersion:reply.runtimeVersion,clientStatus:reply.clientStatus,update:reply.runtimeUpdate,officialUpdate:reply.officialUpdate??null,pluginUpdates:reply.pluginUpdates??null,pluginInstall:reply.pluginInstall??null,...(!this.state.pluginInstallBusy?{pluginInstallUncertain:false}:{}),versionError:reply.runtimeUpdateError?.message??'',updateUncertain:false});
      if(settled)void this.refresh();
    }catch(error){if(this.current('version',sequence)&&this.visible)this.set({versionError:message(error)});}
    finally{if(this.current('version',sequence)&&this.visible){this.set({versionLoading:false});this.after('version',this.combiningUpdates()||this.installingPlugins()||this.updateCommand||this.state.pluginUpdates?.phase==='checking'||busyUpdatePhases.includes(this.state.update?.phase)?1000:5000,()=>this.pollVersions());}}
  }
  async loadUpdate(method='runtimeUpdateStatus'){
    if(method==='runtimeUpdateStatus')return this.pollVersions();
    if(!this.canConfigure()||this.state.updateBusy||this.updateCommand)return;
    if(method==='downloadRuntimeUpdate'&&this.state.update?.phase!=='available'||method==='installRuntimeUpdate'&&(this.state.update?.phase!=='downloaded'||!this.state.update.installAvailable))return;
    const operation={method,inFlight:true};this.updateCommand=operation;
    this.clearTimer('version');this.sequence.version++;const sequence=++this.sequence.update;
    this.set({updateBusy:true,updateError:''});
    try{
      const reply=await this.rpc(method,{});
      operation.inFlight=false;
      if(!this.current('update',sequence))return;
      if(!validUpdate(reply))throw new Error('Update status is unavailable.');
      this.updateCommand=null;this.set({update:reply,updateUncertain:false});
    }catch(error){operation.inFlight=false;if(this.current('update',sequence))this.set({updateError:message(error),updateUncertain:true});}
    finally{
      if(this.current('update',sequence)){
        this.set({updateBusy:false});
        if(this.visible)this.after('version',1000,()=>this.pollVersions());
      }
    }
  }
}
