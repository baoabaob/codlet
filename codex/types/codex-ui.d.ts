/** Public Target capability from codex.ui.adapter. Works in isolated/main worlds. */
export const composerActionCapability: Readonly<{ name: 'codex.ui.composer.action'; api: 1; scope: 'target' }>;

export interface ComposerActionRegister {
  /** Text displayed on every reviewed native composer utility bar. */
  label: string;
  /** 16–80 ASCII letters, digits or hyphens; unique per owner registration. */
  token: string;
}
export interface ComposerActionRegistration {
  api: 1;
  token: string;
  available: boolean;
  /** False only when the current Desktop build/window has no reviewed outlet. */
  reason?: 'unsupported_build';
  /** True when the adapter accepted the lease before Native finished loading. */
  pending?: boolean;
  /** Current number of mounted composer buttons, possibly zero. */
  mounted?: number;
}
export interface ComposerActionStatus { registered: boolean; mounted: number; pending?: boolean }
export interface ComposerActionMethods {
  register: { params: ComposerActionRegister; result: ComposerActionRegistration };
  unregister: { params: { token: string }; result: { removed: boolean } };
  status: { params: { token: string }; result: ComposerActionStatus };
}
/** `CustomEvent.detail` is a JSON string so isolated and main worlds see the same data. */
export interface ComposerActionClick {
  api: 1;
  token: string;
  /** Native `data-composer-placement`, not a thread ID or proof of selection. */
  placement: string;
  /** Ephemeral DOM anchor: find `[data-codlet-composer-action-instance-id="..."]`. */
  instance: string;
}

/**
 * Consumer setup:
 * 1. Create an empty span and set dataset.codletComposerActionLease, 
 *    dataset.codletComposerActionOwner and dataset.codletGeneration from the
 *    current RendererContext; append it to document.body.
 * 2. Listen for `codlet:composer-action` on the span; JSON.parse(event.detail).
 * 3. Declare codex.ui.composer.action@1 in requires and call register via
 *    context.rpc.request. Remove the span in context.onDeactivate; unregister
 *    first when the user turns off this one action.
 *
 * Core authenticates the RPC caller. The adapter checks the live DOM lease
 * against that caller's ID and generation. It mounts one native action button
 * per reviewed composer, sends no real conversation text, and never submits.
 */
