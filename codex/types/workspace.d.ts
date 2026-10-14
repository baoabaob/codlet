export type WorkspaceDiagnostic = Readonly<{ code: string; message: string }>;
export interface WorkspaceSnapshot {
  api: 1; revision: number;
  route: Readonly<{ pathname: string; search: string; hash: string }> | null;
  threadId: string | null; hostId: 'local' | null; auxiliary: boolean; available: boolean;
  features: Readonly<{ surface: boolean; activitySlot: boolean; transcript: boolean; shortcuts: boolean; navigation: boolean; navigationInput?: boolean; locationRestore?: boolean; selectionPresentation?: boolean; independentViewport?: boolean; action: boolean; composer: boolean; composerRebind: boolean }>;
  diagnostic: WorkspaceDiagnostic | null;
}
export interface WorkspaceNode { element: HTMLElement; rect: Readonly<{ x: number; y: number; width: number; height: number; top: number; right: number; bottom: number; left: number }> }
export interface WorkspaceSurface {
  available: boolean; main: WorkspaceNode | null; content: WorkspaceNode | null; scroller: WorkspaceNode | null;
  composer: WorkspaceNode | null; footer: WorkspaceNode | null; header: WorkspaceNode | null; rightPanel: WorkspaceNode | null;
  /** Effective region for replacement body UI; leaves Native floating areas intact. */
  bodyViewport?: Readonly<{rect:WorkspaceNode['rect']}>|null;
  floatingContent?: ReadonlyArray<WorkspaceNode & {readonly visible:boolean}>;
}
export interface SurfaceOptions { hideBody?: boolean; hideHeader?: boolean; hideComposer?: boolean; composerEnabled?: boolean; rightPanelEnabled?: boolean }
export interface TranscriptState { phase: 'loading' | 'ready' | 'error' | 'disposed'; threadId: string; hostId: 'local'; diagnostic: WorkspaceDiagnostic | null }
export interface TranscriptOptions { threadId: string; hostId?: 'local'; readOnly?: boolean; trackReadState?: boolean; onState?: (state: TranscriptState) => unknown }
export interface ScrollPosition { top: number; left: number }
export interface TranscriptHandle {
  ready: Promise<void>; update(options: Partial<TranscriptOptions>): void; dispose(): void;
  getScrollPosition(): ScrollPosition; setScrollPosition(position: ScrollPosition): void;
}
export interface ComposerBinding { readonly threadId: string; readonly hostId: 'local'; readonly inputConfirmed: true; readonly submitDisabled: boolean }
export interface ComposerRebindBinding extends ComposerBinding { readonly bindingRevision: number }
export interface ComposerInvocation { signal?: AbortSignal; bindingRevision?: number }
export interface ComposerState { phase: 'preparing' | 'binding' | 'ready' | 'activating' | 'active' | 'inactive' | 'closing' | 'error' | 'disposed'; threadId: string; hostId: 'local'; bindingRevision?: number; diagnostic: WorkspaceDiagnostic | null }
export interface ComposerOptions { threadId: string; hostId?: 'local'; onState?: (state: Readonly<ComposerState>) => unknown }
export interface ComposerHandle {
  readonly threadId: string; readonly hostId: 'local'; readonly ready: Promise<Readonly<ComposerBinding>>;
  /** Confirms the cached owned input; leaves focus to the caller. */
  activate(options?: ComposerInvocation): Promise<Readonly<ComposerBinding>>;
  /** Synchronously blocks editing and cancels pending activation. */
  deactivate(): void;
  focus(options?: { bindingRevision?: number }): boolean; dispose(): void;
  /** Present only on a profile with validated features.composerRebind. */
  bind?(identity: { threadId: string; hostId?: 'local' }, options?: { signal?: AbortSignal }): Promise<Readonly<ComposerRebindBinding>>;
  close?(options?: { signal?: AbortSignal }): Promise<void>;
}
export interface RebindableComposerHandle extends ComposerHandle {
  readonly ready: Promise<Readonly<ComposerRebindBinding>>;
  bind(identity: { threadId: string; hostId?: 'local' }, options?: { signal?: AbortSignal }): Promise<Readonly<ComposerRebindBinding>>;
  activate(options?: ComposerInvocation): Promise<Readonly<ComposerRebindBinding & { submitDisabled: false }>>;
  close(options?: { signal?: AbortSignal }): Promise<void>;
}
export interface ShortcutOptions {
  id: string; label: string; description?: string; accelerator?: string | null; defaultAccelerator?: string | null;
  onInvoke(): unknown; onChange?: (accelerator: string | null) => unknown;
}
export interface ShortcutSnapshot { id: string; accelerator: string | null; defaultAccelerator: string | null; conflict: string | null }
export interface ShortcutHandle { ready: Promise<void>; getSnapshot(): Readonly<ShortcutSnapshot>; update(options: Partial<Omit<ShortcutOptions, 'id'>>): void; dispose(): void }
export interface NativeActionOptions {
  id: string; label: string; icon: { paths: string[]; viewBox?: string };
  shortcut?: string | null; pressed?: boolean; disabled?: boolean; onInvoke(): unknown;
}
export interface NativeActionHandle { ready: Promise<void>; update(options: Partial<NativeActionOptions>): void; dispose(): void }
export interface NavigationReceipt { threadId: string; resumeState: string; streamRole: string; status: 'opened' | 'opening'; alreadySelected: boolean; revision: number; synchronousMs: number }
export interface NavigationCommit { threadId: string; hostId: 'local'; inputConfirmed: true; submitDisabled: boolean; revision: number }
export interface NavigationOperation { executed: Promise<Readonly<NavigationReceipt>>; committed: Promise<Readonly<NavigationCommit>>; dispose(): void }
export interface NavigationSession {
  ready: Promise<void>;
  /** 1 after ready only when strict Native ownership, IME checks and focus are available. Older providers omit it. */
  readonly inputApi?: 0 | 1;
  open(options: { threadId: string }, invocation?: { signal?: AbortSignal }): NavigationOperation;
  /** Explicitly focuses the latest unchanged committed Native main input. False for stale revisions or drift. */
  focus?(options: { revision: number }): boolean;
  dispose(): void;
}
export interface WorkspaceSession {
  api: 1; getSnapshot(): Readonly<WorkspaceSnapshot>; subscribe(listener: (snapshot: Readonly<WorkspaceSnapshot>) => unknown): () => void;
  getSurface(): Readonly<WorkspaceSurface>; resolveThreadReference(element: Element): { threadId: string; hostId: 'local' } | null;
  resolveThreadInteraction(element: Element): { threadId: string; hostId: 'local' } | null;
  hasBlockingOverlay(target?: Element | null): boolean;
  createSlot(name: 'activity.before' | 'workspace.overlay'): { container: HTMLElement; dispose(): void };
  acquireSurface(options: SurfaceOptions): { update(options: SurfaceOptions): void; dispose(): void };
  /** No per-session or per-Target transcript count cap; each accepted handle keeps its own lifecycle. */
  mountTranscript(container: HTMLElement, options: TranscriptOptions): TranscriptHandle;
  mountComposer(container: HTMLElement, options: ComposerOptions): ComposerHandle;
  registerShortcut(options: ShortcutOptions): ShortcutHandle; dispose(): void;
  registerAction(options: NativeActionOptions): NativeActionHandle;
  createNavigation(): NavigationSession;
  captureLocation(options?: {restoreState?:WorkspaceLocationState}): WorkspaceLocationHandle;
  acquireSelectionPresentation(options: SelectionPresentationOptions): SelectionPresentationHandle;
  acquireComposerControl(options: {control:'permissions';threadId:string|null}): ComposerControlHandle;
  /** Optional Native driver; ready rejects if independent nonpolluting state cannot be established. */
  createViewport(options?: IndependentViewportOptions): IndependentViewportHandle;
}
/** Process-local Core resource token; contains no Native router state or draft text. */
export interface WorkspaceLocationState {readonly api:1;readonly token:string}
export interface WorkspaceLocationHandle { readonly ready: Promise<void>; readonly kind: 'thread'|'page'; exportState():Promise<Readonly<WorkspaceLocationState>>; restore(options?: {signal?:AbortSignal}): Promise<Readonly<{restored:true;kind:'thread'|'page'}>>; dispose(options?:{releaseTransfer?:boolean}):void }
export interface SelectionPresentationOptions { threadId: string|null; emptyLabel?: string }
export interface SelectionPresentationHandle { update(options: Partial<SelectionPresentationOptions>):void; dispose():void }
export interface ComposerControlHandle {readonly container:HTMLElement;readonly ready:Promise<void>;updateBinding(options:{threadId:string|null}):Promise<void>;dispose():void}
export interface IndependentViewportOptions { open?:boolean; width?:number }
export interface IndependentViewportSnapshot { readonly independent:true; readonly open:boolean; readonly width:number; readonly threadId:string|null; readonly hostId:'local'|null }
export interface IndependentViewportHandle {
  readonly ready:Promise<void>;
  getSnapshot():Readonly<IndependentViewportSnapshot>;
  /** Pushes Native close/resize changes; lifetime cleanup releases the listener. */
  subscribe(listener:(snapshot:Readonly<IndependentViewportSnapshot>)=>unknown):()=>void;
  /** Requires the current strict Native selection; never selects or sends by itself. */
  bind(identity:{threadId:string;hostId?:'local'}|null, options?:{signal?:AbortSignal}):Promise<Readonly<IndependentViewportSnapshot>>;
  update(options:IndependentViewportOptions, invocation?:{signal?:AbortSignal}):Promise<Readonly<IndependentViewportSnapshot>>;
  /** Restore the captured view state before releasing; awaited teardown is required. */
  close():Promise<void>; dispose():void;
}
export interface WorkspaceOwner { world: 'main'; pluginId: string; generation: number; onDeactivate(dispose: () => void): () => void }
export interface WorkspaceApi { api: 1; connect(context: WorkspaceOwner, ticket: string): WorkspaceSession }
export interface WorkspaceApiDescriptor { api: 1; symbol: 'codlet.codex.ui.workspace.v1'; ticket: string }
export interface LoadedThreadSummary { id: string; title: string | null; cwd: string | null; hostId: 'local'; runtimeStatus: 'running' | 'attention' | 'idle' | 'loading'; /** Native work state including owned child work/publication; null on unsupported or unready mapping. */ working: boolean | null }
export interface LoadedThreadQuery { limit?: number; cursor?: string; threadId?: string }
export interface LoadedThreadPage { threads: LoadedThreadSummary[]; cursor: string | null }
