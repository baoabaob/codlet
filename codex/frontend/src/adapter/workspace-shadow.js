import { workspaceError } from './workspace-dom.js';

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
    const shadow = wrapper.attachShadow({ mode: 'open' }), container = document.createElement('div');
    container.dataset.codletWorkspaceTranscriptRoot = '';
    container.style.cssText = 'display:flex;flex-direction:column;min-width:0;min-height:0;width:100%;height:100%;overflow:hidden;position:relative;';
    shadow.append(container);
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
