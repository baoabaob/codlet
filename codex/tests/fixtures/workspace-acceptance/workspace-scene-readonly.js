// Evaluate only through the execution owner's verified Core CDP session.
// Pure bounded DOM/style/geometry reads; no text, drafts, events or private JS.
export function readWorkspaceScene(document) {
  const selectors = {
    main: 'main[data-app-shell-main-surface]', header: '[data-app-shell-main-titlebar]',
    footer: '[data-thread-scroll-footer]', composer: '[data-codex-composer-root]',
    scroller: '.thread-scroll-container', rightPanel: 'aside[data-app-shell-focus-area="right-panel"]',
    actions: '[data-codlet-workspace-action]', owned: '[data-codlet-workspace-owned]',
    titlebar: '[data-app-shell-titlebar]', summary: '[data-thread-summary-panel],[data-testid*="summary"]'
  };
  const aliases = new WeakMap(); let sequence = 0;
  const describe = element => {
    if (!aliases.has(element)) aliases.set(element, ++sequence);
    const style = document.defaultView.getComputedStyle(element), rect = element.getBoundingClientRect();
    return { alias: aliases.get(element), tag: element.tagName, connected: element.isConnected,
      owned: !!element.closest('[data-codlet-workspace-owned]'), inactive: !!element.closest('[data-app-shell-active-page="false"]'),
      inert: !!element.closest('[inert]'), ariaHidden: !!element.closest('[aria-hidden="true"]'), hidden: !!element.closest('[hidden]'),
      display: style.display, visibility: style.visibility, pointerEvents: style.pointerEvents, position: style.position,
      zIndex: style.zIndex, appRegion: style.getPropertyValue('-webkit-app-region'), transform: style.transform,
      rect: { x: rect.x, y: rect.y, w: rect.width, h: rect.height }, parentAlias: aliases.get(element.parentElement) ?? null };
  };
  const roles = {};
  for (const [role, selector] of Object.entries(selectors)) {
    const elements = [...document.querySelectorAll(selector)];
    roles[role] = { total: elements.length, truncated: elements.length > 32, nodes: elements.slice(0, 32).map(describe) };
  }
  const hitTests = [];
  for (const role of ['header', 'actions', 'titlebar']) for (const node of roles[role].nodes.slice(0, 6)) {
    if (!node.rect.w || !node.rect.h) continue;
    const x = Math.max(0, Math.min(document.documentElement.clientWidth - 1, node.rect.x + node.rect.w / 2));
    const y = Math.max(0, Math.min(document.documentElement.clientHeight - 1, node.rect.y + node.rect.h / 2));
    hitTests.push({ role, alias: node.alias, x, y, stack: document.elementsFromPoint(x, y).slice(0, 8).map(describe) });
  }
  return { schema: 1, readOnly: true, textRecorded: false, privateNativeObjectsRead: false, visibility: document.visibilityState, roles, hitTests };
}
