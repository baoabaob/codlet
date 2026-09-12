/** Optional local UI helpers supplied by the managed renderer runtime. */
export type UiRole = 'button' | 'switch' | 'section' | 'row' | 'copy' | 'label' | 'description' | 'actions' | 'dialog' | 'dialogHeader' | 'dialogBody' | 'dialogActions' | 'heading' | 'status';
export interface UiAppearance {
  api: 1;
  available: boolean;
  themeToken: string;
  roles: Record<UiRole, string[]>;
  nativeLayout?: string | null;
  nativeTokensAvailable?: boolean;
}
export type UiTag = 'div' | 'span' | 'p' | 'section' | 'h1' | 'h2' | 'label' | 'button' | 'input' | 'dialog' | 'textarea' | 'select' | 'option';
export interface UiElementOptions { role?: UiRole; variant?: string; text?: string; className?: string }
export interface UiDialog {
  readonly element: HTMLDialogElement;
  readonly header: HTMLDivElement;
  readonly title: HTMLHeadingElement;
  readonly body: HTMLDivElement;
  readonly actions: HTMLDivElement;
  readonly closeButton: HTMLButtonElement;
  show(options?: { trigger?: HTMLElement | null; initialFocus?: HTMLElement | null }): boolean;
  close(reason?: string): boolean;
  dispose(): void;
}
export interface RendererUi {
  readonly api: 1;
  /** Aborted on dispose; asynchronous consumer work must observe this signal. */
  readonly signal: AbortSignal;
  element<K extends UiTag>(tag: K, options?: UiElementOptions): HTMLElementTagNameMap[K];
  /** Listener lifetime belongs to this owner; DOM control listeners also retire on remove(). */
  on(target: EventTarget, type: string, handler: (event: Event, signal: AbortSignal) => unknown, options?: boolean | AddEventListenerOptions): () => void;
  remove(node: HTMLElement): void;
  button(options: { text?: string; label?: string; variant?: 'default' | 'primary' | 'danger' | 'icon' | 'close' | 'menu'; disabled?: boolean; onClick?: (event: Event, signal: AbortSignal) => unknown }): HTMLButtonElement;
  /** Owned standard link, HTTPS only, without credentials; opens with noopener/noreferrer. */
  externalLink(options: { text: string; href: string; label?: string }): HTMLAnchorElement;
  switch(options: { label: string; checked?: boolean; disabled?: boolean; onChange?: (checked: boolean, event: Event, signal: AbortSignal) => unknown }): HTMLInputElement;
  row(options: { label: string; description?: string }): Readonly<{ element: HTMLDivElement; copy: HTMLDivElement; label: HTMLDivElement; description: HTMLDivElement; controls: HTMLDivElement }>;
  status(options?: { text?: string; tone?: 'default' | 'error' | 'success' }): HTMLDivElement;
  dialog(options: { title: string; variant?: 'settings' | 'confirmation'; closeLabel?: string; onClose?: (reason: string) => void; /** Return false to keep the dialog open. */ onRequestClose?: (reason: string) => boolean | void }): UiDialog;
  /** Retains the control's prior disabled value across a busy cycle. */
  busy(node: HTMLElement, value: boolean): void;
  after(delayMs: number, callback: (signal: AbortSignal) => void): () => void;
  dispose(): void;
}
export interface RendererUiFactory { readonly api: 1; create(appearance: UiAppearance): RendererUi }
