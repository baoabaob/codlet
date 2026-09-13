import type * as React from 'react';

/** Direct upstream components. Install the pinned peer packages for type checking. */
export interface OfficialComponents {
  readonly Button: typeof import('@openai/apps-sdk-ui/components/Button').Button;
  readonly ButtonLink: typeof import('@openai/apps-sdk-ui/components/Button').ButtonLink;
  readonly Input: typeof import('@openai/apps-sdk-ui/components/Input').Input;
  readonly Textarea: typeof import('@openai/apps-sdk-ui/components/Textarea').Textarea;
  readonly Switch: typeof import('@openai/apps-sdk-ui/components/Switch').Switch;
  readonly Checkbox: typeof import('@openai/apps-sdk-ui/components/Checkbox').Checkbox;
  readonly Popover: typeof import('@openai/apps-sdk-ui/components/Popover').Popover;
  readonly Tooltip: typeof import('@openai/apps-sdk-ui/components/Tooltip').Tooltip;
  readonly SegmentedControl: typeof import('@openai/apps-sdk-ui/components/SegmentedControl').SegmentedControl;
  readonly Select: typeof import('@openai/apps-sdk-ui/components/Select').Select;
  readonly TextLink: typeof import('@openai/apps-sdk-ui/components/TextLink').TextLink;
  readonly LoadingIndicator: typeof import('@openai/apps-sdk-ui/components/Indicator').LoadingIndicator;
}
export type OfficialIcons = Pick<typeof import('@openai/apps-sdk-ui/components/Icon'),
  'ArrowLeft' | 'ArrowRotateCw' | 'Download' | 'ExternalLink' | 'FolderOpen' | 'InfoCircle' | 'Regenerate' | 'Search' | 'X'>;
export interface RendererUiMount {
  render(content: React.ReactNode): void;
  /** Synchronously runs React cleanups; a later mount may reuse the container. */
  unmount(): void;
}
export interface RendererUiPageOptions {
  label: string;
  icon?: 'Cube' | 'CodeSquareSlash';
  /** Called on each native route entry; the React tree is unmounted on exit. */
  render(): React.ReactNode;
  onActivate?(): void;
  onDeactivate?(): void;
}
export interface RendererUi {
  readonly api: 2;
  readonly React: typeof React;
  readonly components: OfficialComponents;
  readonly icons: OfficialIcons;
  readonly PortalContainer: React.Context<Element | null>;
  readonly signal: AbortSignal;
  useEscCloseStack(listening: boolean, callback: () => void): void;
  createPortal(children: React.ReactNode, container: Element | DocumentFragment, key?: string | null): React.ReactPortal;
  flushSync(callback: () => void): void;
  container(parent?: Element): HTMLDivElement;
  mount(container: HTMLDivElement, content: React.ReactNode): RendererUiMount;
  /** Requires codex.ui.navigation.page@1. One page per plugin and generation. */
  page(options: RendererUiPageOptions): Promise<Readonly<{ path: string; dispose(): void }>>;
  /** Aborts the owner, unregisters pages and synchronously unmounts every root. */
  dispose(): void;
}
export interface RendererUiFactory { readonly api: 2; create(): RendererUi }
