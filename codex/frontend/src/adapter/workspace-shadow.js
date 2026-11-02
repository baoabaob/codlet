import { workspaceError } from './workspace-dom.js';

// The viewport owns one no-drag rectangle. Descendant Native controls must not
// contribute offscreen app-region boxes when they scroll beyond that viewport.
export const TRANSCRIPT_APP_REGION_STYLE = '[data-codlet-workspace-transcript-root],[data-codlet-workspace-transcript-root] *,[data-codlet-workspace-transcript-root]::before,[data-codlet-workspace-transcript-root]::after,[data-codlet-workspace-transcript-root] *::before,[data-codlet-workspace-transcript-root] *::after{-webkit-app-region:initial!important;app-region:initial!important}';
export function createTranscriptContainer(document, parent) {
  const container = document.createElement('div'), style = document.createElement('style');
  container.dataset.codletWorkspaceTranscriptRoot = '';
  container.style.cssText = 'display:flex;flex-direction:column;min-width:0;min-height:0;width:100%;height:100%;overflow:hidden;position:relative;';
  style.dataset.codletWorkspaceTranscriptStyle = ''; style.textContent = TRANSCRIPT_APP_REGION_STYLE;
  parent.append(style, container);
  return container;
}

// Reuse loaded Native resources without importing consumer or Core UI styles.
export function createTranscriptIsolation({ document, report }) {
  const records = new Set(); let observer;
  const links = () => [...document.head.querySelectorAll('link[rel~="stylesheet"]')].filter(link =>
    /^app:\/\/-\/assets\/[A-Za-z0-9_-]+\.css$/.test(link.href));
  function sync(record) {
    const sources = new Set(links());
    for (const [source, entry] of record.links) if (!sources.has(source)) { entry.dispose(); record.links.delete(source); }
    for (const source of sources) {
      let entry = record.links.get(source);
      if (!entry) {
        const clone = source.cloneNode(false); let resolve, reject;
        const ready = new Promise((yes, no) => { resolve = yes; reject = no; }); ready.catch(() => {});
        function finish(error) { clone.removeEventListener('load', loaded); clone.removeEventListener('error', failed); if (error) reject(error); else resolve(); }
        const loaded = () => finish(), failed = () => finish(workspaceError('workspace_transcript_styles_unavailable', 'A loaded Native stylesheet could not be reused'));
        clone.addEventListener('load', loaded, { once: true }); clone.addEventListener('error', failed, { once: true });
        record.shadow.insertBefore(clone, record.container);
        entry = { clone, ready, dispose() { finish(workspaceError('workspace_retired', 'Native transcript styles retired')); clone.remove(); } };
        record.links.set(source, entry);
      }
      for (const attr of [...entry.clone.attributes]) if (!source.hasAttribute(attr.name)) entry.clone.removeAttribute(attr.name);
      for (const attr of source.attributes) if (entry.clone.getAttribute(attr.name) !== attr.value) entry.clone.setAttribute(attr.name, attr.value);
      entry.clone.disabled = source.disabled;
    }
    if (document.adoptedStyleSheets) record.shadow.adoptedStyleSheets = document.adoptedStyleSheets;
  }
  function refresh() { for (const record of records) try { sync(record); } catch (error) { report(error); } }
  function create(wrapper) {
    const shadow = wrapper.attachShadow({ mode: 'open' }), container = createTranscriptContainer(document, shadow);
    const record = { shadow, container, links: new Map() }; records.add(record);
    function release() { if (!records.delete(record)) return; for (const entry of record.links.values()) entry.dispose(); record.links.clear(); if (!records.size) { observer?.disconnect(); observer = null; } }
    try {
      sync(record);
      if (!record.links.size && !shadow.adoptedStyleSheets?.length) throw workspaceError('workspace_transcript_styles_unavailable', 'Native transcript styles are not loaded');
      if (!observer) {
        observer = new document.defaultView.MutationObserver(refresh);
        observer.observe(document.head, { childList: true, subtree: true, attributes: true, attributeFilter: ['href', 'rel', 'media', 'disabled', 'integrity', 'crossorigin', 'nonce'] });
      }
    } catch (error) { release(); throw error; }
    return { container, ready: Promise.all([...record.links.values()].map(entry => entry.ready)), dispose: release };
  }
  return { create, dispose() { observer?.disconnect(); observer = null; for (const record of records) for (const entry of record.links.values()) entry.dispose(); records.clear(); } };
}
