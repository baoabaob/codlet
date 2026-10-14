export type PermissionSelection = Readonly<
  {kind:'agent-mode';mode:string}|{kind:'profile';profileId:string}|{kind:'server-default'}
>;
export interface PermissionConfirmation {
  readonly kind:'native-full-access'; readonly title:string; readonly body:string;
  readonly capabilities:readonly string[]; readonly risk:string; readonly modelWarning:string|null;
  readonly confirmLabel:string; readonly cancelLabel:string;
}
export interface PermissionOption {
  readonly selection:PermissionSelection; readonly label:string; readonly enabled:boolean;
  readonly reason:string|null; readonly requiresConfirmation:boolean; readonly confirmation:PermissionConfirmation|null;
}
export interface PermissionSnapshot {
  readonly threadId:string; readonly hostId:'local'; readonly revision:number;
  readonly phase:'loading'|'ready'|'unsupported'|'error'; readonly selection:PermissionSelection|null;
  readonly source:'thread'|'host-default'|'unknown'; readonly options:readonly PermissionOption[];
  readonly diagnostic:Readonly<{code:string;message:string}>|null;
}
export interface PermissionUpdate {
  readonly threadId:string; readonly hostId?:'local'; readonly selection:PermissionSelection;
  readonly expectedRevision:number; readonly confirmed?:boolean;
}
export interface PermissionReceipt {
  readonly threadId:string; readonly hostId:'local'; readonly selection:PermissionSelection;
  readonly status:'confirmed'|'staged'; readonly revision:number;
}
export interface PermissionChangedEvent {readonly type:'permissions.changed';readonly threadId:string;readonly hostId:'local';readonly revision:number}
export interface PermissionOwner {readonly world:'main';readonly pluginId:string;readonly generation:number;onDeactivate(dispose:()=>void):()=>void}
export interface DesktopPermissionRegistration {
  /** Uses a fresh codex.backend.write getApi ticket. Keep for the plugin generation, independently of UI leases. */
  registerPermissions(context:PermissionOwner,ticket:string):()=>void;
}
