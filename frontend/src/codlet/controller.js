import { createMessages, PERMISSION_COPY } from './messages.js';
const capability = { name: 'codlet.runtime.manage', api: 1, scope: 'target' };
const digest = value => typeof value === 'string' && /^[a-f0-9]{64}$/.test(value);
const message = error => String(error?.message ?? error);
const phases = ['development', 'checking', 'upToDate', 'available', 'downloading', 'downloaded', 'installRequested', 'failed'];
const busyPhases = ['checking', 'downloading', 'installRequested'];
const updateIdentity = value => value?.candidate?.id && value?.candidate?.version ? `${value.candidate.id}:${value.candidate.version}` : null;

export class Manager {
  constructor(context) {
    this.context = context; this.messages = createMessages(context);
    this.listeners = new Set(); this.timers = new Map(); this.sequence = { list:0, page:0, removal:0, update:0 };
    this.alive = true; this.job = null; this.pending = null; this.updateCommand = null;
    this.state = { open:false, page:'plugins', plugins:[], query:'', loading:false, error:'', operationStatus:'',
      runtimeVersion:'', clientStatus:null, localManagement:null, githubAvailable:false, confirmation:null,
      mode:'local', importOperation:'install', target:null, path:'', url:'', catalog:null, release:'', asset:'',
      preview:null, importBusy:false, importStatus:'', importError:'', grants:[], trusted:false, enableAfter:false, policy:{},
      details:null, detailsBusy:false, detailsError:'', history:[], historyCursor:0, historyVersion:undefined, historyBusy:false, historyError:'',
      update:null, updateBusy:false, updateUncertain:false, updateError:'', jobRetry:false, locale:context.i18n?.locale ?? 'en' };
    this.unsubscribeLocale = context.i18n?.onChange?.(() => this.set({locale:context.i18n.locale}));
  }
  subscribe = fn => { this.listeners.add(fn); return () => this.listeners.delete(fn); };
  snapshot = () => this.state;
  set(patch) { if (!this.alive) return; this.state = {...this.state,...patch}; for (const fn of this.listeners) fn(); }
  rpc(method, params = null) { return this.context.rpc.request(capability, method, params); }
  clearTimer(name) { clearTimeout(this.timers.get(name)); this.timers.delete(name); }
  after(name, delay, fn) { this.clearTimer(name); this.timers.set(name,setTimeout(()=>{this.timers.delete(name); if(this.alive) void fn();},delay)); }
  current(channel, sequence, page) { return this.alive && this.state.open && this.sequence[channel] === sequence && (!page || this.state.page === page); }
  available() { return this.alive && this.state.open && !this.pending && !this.state.confirmation; }
  async open() { if (this.state.open) return; this.set({open:true}); return this.pending?.id ? this.checkMutation() : this.refresh(); }
  close() {
    if (this.pending && !this.pending.submitted) this.pending.cancelled = true;
    this.set({open:false, page:'plugins', confirmation:null});
    for (const name of [...this.timers.keys()]) this.clearTimer(name);
    this.sequence.list++; this.sequence.update++; this.sequence.removal++;
    this.invalidateImport();
  }
  dispose() {
    if (!this.alive) return;
    this.close(); this.alive=false; this.unsubscribeLocale?.(); this.listeners.clear();
  }
  async refresh() {
    if (!this.alive || !this.state.open) return;
    if (this.pending) return this.pending.id ? this.checkMutation() : undefined;
    const sequence=++this.sequence.list; this.set({loading:true,error:''});
    try {
      const reply=await this.rpc('list');
      if (!this.current('list',sequence)) return;
      if (!Array.isArray(reply?.plugins) || reply.plugins.some(p=>!p || typeof p.id!=='string' || !p.id) || new Set(reply.plugins.map(p=>p.id)).size!==reply.plugins.length) throw new Error('Plugin list unavailable');
      this.set({plugins:reply.plugins,localManagement:reply.localManagement??null,githubAvailable:reply.githubManagement?.available===true,
        runtimeVersion:reply.runtimeVersion??'',clientStatus:reply.clientStatus??null});
      if (typeof reply.runtimeVersion==='string') void this.loadUpdate();
    } catch(error) { if(this.current('list',sequence)) this.set({error:error?.code==='rpc_timeout'?'Plugin list timed out. Refresh to try again.':message(error)}); }
    finally { if(this.current('list',sequence)) this.set({loading:false}); }
  }
  filtered() {
    const terms=this.state.query.trim().toLowerCase().split(/\s+/).filter(Boolean);
    return this.state.plugins.filter(plugin=>terms.every(term=>[plugin.id,plugin.name,plugin.description,plugin.i18n?.zh?.name,plugin.i18n?.zh?.description,plugin.i18n?.en?.name,plugin.i18n?.en?.description].filter(value=>typeof value==='string').join(' ').toLowerCase().includes(term)));
  }
  setQuery(query) { this.set({query}); }
  async mutate(pluginId, action, extra = {}, name) {
    if (!this.available()) return;
    const expected={pluginId,action,name:name||this.messages.name(this.state.plugins.find(p=>p.id===pluginId)??{id:pluginId}),id:null,checking:false,deleteSource:!!extra.remove_source};
    this.pending=expected; this.set({error:'',operationStatus:`${expected.name}: preparing...`});
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
        this.set({error:reply?.error||'Action status is no longer available. The action has not been repeated.'}); return;
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
      if(!['queued','running'].includes(reply.status)) {this.set({error:reply?.error||'The action was not confirmed. Refresh checks the same action without repeating it.'});return;}
      this.set({operationStatus:`${expected.name}: ${reply.status==='queued'?'waiting':'updating'}...`});
      if(this.state.open) this.after('mutation',250,()=>this.checkMutation(expected));
    } catch { if(this.alive && this.pending===expected) this.set({error:'Action status unavailable. Refresh to check again.'}); }
    finally { expected.checking=false; }
  }
  async finishMutation(expected,error='') {
    if(this.pending!==expected) return;
    this.pending=null; this.clearTimer('mutation'); this.set({operationStatus:''});
    if(this.state.open) await this.refresh();
    if(this.alive && !this.pending) this.set({error});
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
      this.set({confirmation:null,page:'updates'}); return this.loadUpdate('installRuntimeUpdate');
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
    const job=this.job; this.job=null; this.clearTimer('github');
    if(job?.id) void this.rpc('cancelGitHubJob',{jobId:job.id}).catch(()=>{});
  }
  invalidateImport() {
    this.cancelJob(); this.clearTimer('preview'); this.clearTimer('picker'); this.sequence.page++;
    this.set({preview:null,importBusy:false,grants:[],trusted:false,enableAfter:false,policy:{},jobRetry:false});
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
  importReady() {const s=this.state;return this.available() && s.page==='import' && !!s.preview && !s.importBusy && s.trusted && s.preview.manifest.permissions.every(p=>s.grants.includes(p));}
  submitImport() {
    if(!this.importReady()) return;
    const s=this.state,p=s.preview;
    const brokerPolicy=Object.fromEntries(Object.entries(s.policy).filter(([key])=>({readRoots:'host.fs',networkOrigins:'host.network',executables:'host.process'}[key]) && s.grants.includes({readRoots:'host.fs',networkOrigins:'host.network',executables:'host.process'}[key])).map(([key,value])=>[key,value.split(/\r?\n/).map(line=>line.trim()).filter(Boolean)]));
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
    try {
      const reply=await this.rpc(method,params);
      if(this.job!==job || !this.current('page',job.sequence,'import')) {if(reply?.jobId) void this.rpc('cancelGitHubJob',{jobId:reply.jobId}).catch(()=>{});return;}
      if(typeof reply?.jobId!=='string' || !reply.jobId) throw new Error('GitHub task did not return a job ID. No installation was submitted.');
      job.id=reply.jobId;this.acceptJob(job,reply);
    }catch(error){if(this.job===job && this.current('page',job.sequence,'import')) {this.job=null;this.set({importBusy:false,importStatus:message(error)});}}
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
    } else if(['cancelled','failed'].includes(reply.status)) this.set({importStatus:reply.error?.message||'GitHub task cancelled. No installation was submitted; temporary download files may remain.'});
    else throw new Error('GitHub task returned an unknown status.');
    this.job=null;this.set({importBusy:false,jobRetry:false});
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
    this.set({page:'details',details:plugin,detailsBusy:true,detailsError:'',history:[],historyCursor:0,historyVersion:undefined,historyError:'',historyBusy:false});
    try{
      const reply=plugin.source==='bundled'?{pluginId:plugin.id,registration:{path:'',grants:plugin.grants??[]}}:await this.rpc('permissions',{pluginId:plugin.id});
      if(!this.current('page',sequence,'details')) return;
      if(reply?.pluginId!==plugin.id || !Array.isArray(reply.registration?.grants) || typeof reply.registration.path!=='string') throw new Error('Permission details are unavailable.');
      this.set({details:{...plugin,...reply.registration,...(reply.ownership?{ownership:reply.ownership}:{}),...(reply.managedSource?{managedSource:reply.managedSource}:{}),metadata:reply.metadata}});
      if(this.state.details.ownership==='core-managed-github') void this.loadHistory();
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
  async loadHistory() {
    const s=this.state,plugin=s.details,sequence=this.sequence.page,cursor=s.historyCursor;
    if(!plugin || s.historyBusy || cursor===null || !this.available() || s.page!=='details')return;
    this.set({historyBusy:true,historyError:''});
    try{
      const reply=await this.rpc('managedHistory',{pluginId:plugin.id,...(cursor?{cursor}:{})});
      if(!this.current('page',sequence,'details'))return;
      const next=reply?.nextCursor??null;
      if(reply?.pluginId!==plugin.id || !Array.isArray(reply.history) || reply.history.length>8 || (reply.currentVersion!==null && typeof reply.currentVersion!=='string') ||
        (next!==null && (!Number.isSafeInteger(next) || next<=cursor || !reply.history.length)))throw new Error('Managed version history is unavailable or its cursor is invalid.');
      if(s.historyVersion!==undefined && s.historyVersion!==reply.currentVersion)throw new Error('The installed version changed. Reopen details to refresh the history.');
      if(reply.history.some(v=>typeof v.versionKey!=='string' || typeof v.manifest?.version!=='string' || typeof v.source?.tag!=='string'))throw new Error('Managed version history is incomplete.');
      const history=[...s.history],seen=new Set(history.map(v=>v.versionKey));
      for(const v of reply.history)if(!seen.has(v.versionKey)){seen.add(v.versionKey);history.push(v);}
      this.set({history,historyCursor:next,historyVersion:reply.currentVersion});
    }catch(error){if(this.current('page',sequence,'details'))this.set({historyError:message(error)});}
    finally{if(this.current('page',sequence,'details'))this.set({historyBusy:false});}
  }
  async rollback(plugin,versionKey){
    if(!this.available())return;
    this.invalidateImport();const sequence=this.sequence.page;
    this.set({page:'import',mode:'github',target:plugin,importOperation:'rollback',importBusy:true,importStatus:'Validating the retained package and comparing permissions...',importError:''});
    try{const preview=await this.rpc('previewRollback',{pluginId:plugin.id,versionKey});if(!this.current('page',sequence,'import'))return;this.validatePreview(preview,true);this.set({preview,importStatus:'Review the exact source, compatibility, dependencies and permissions before confirming.'});}
    catch(error){if(this.current('page',sequence,'import'))this.set({importStatus:message(error)});}
    finally{if(this.current('page',sequence,'import'))this.set({importBusy:false});}
  }
  updates(){if(!this.available())return;this.invalidateImport();this.set({page:'updates'});return this.loadUpdate();}
  requestInstall(){if(!this.available() || this.updateCommand || this.state.updateBusy || this.state.update?.phase!=='downloaded' || !this.state.update.installAvailable)return;this.set({confirmation:{kind:'install',busy:false,error:'',previousPage:this.state.page,updateIdentity:updateIdentity(this.state.update)}});}
  async loadUpdate(method='runtimeUpdateStatus'){
    const command=method!=='runtimeUpdateStatus';
    if(!this.alive || !this.state.open || (command && (!this.available() || this.state.updateBusy || this.updateCommand)))return;
    if(command && (method==='downloadRuntimeUpdate' && this.state.update?.phase!=='available' || method==='installRuntimeUpdate' && (this.state.update?.phase!=='downloaded' || !this.state.update.installAvailable)))return;
    const operation=command?{method,inFlight:true}:null;
    if(operation)this.updateCommand=operation;
    this.clearTimer('update');const sequence=++this.sequence.update;
    this.set({updateBusy:true,updateError:''});
    try{
      const reply=await this.rpc(method,{});
      if(operation)operation.inFlight=false;
      if(!this.current('update',sequence))return;
      if(typeof reply?.currentVersion!=='string' || typeof reply.configured!=='boolean' || !phases.includes(reply.phase))throw new Error('Update status is unavailable.');
      if(!this.updateCommand?.inFlight)this.updateCommand=null;
      this.set({update:reply,updateUncertain:!!this.updateCommand});
    }catch(error){if(operation)operation.inFlight=false;if(this.current('update',sequence))this.set({updateError:message(error),updateUncertain:!!this.updateCommand});}
    finally{
      if(this.current('update',sequence)){
        this.set({updateBusy:false});
        if(this.updateCommand || this.state.update?.configured)this.after('update',this.updateCommand || busyPhases.includes(this.state.update.phase)?1000:5000,()=>this.loadUpdate());
      }
    }
  }
}
