import { deferredNavigation } from '../../../../frontend/src/adapter/navigation.js';
import { createWorkspaceDiscovery } from '../../../../frontend/src/adapter/workspace-discovery.js';
import { uniqueExport, componentSource } from '../../../../frontend/src/host-discovery.js';
const capability = { name: 'workspace.shadow.audit', api: 1, scope: 'target' }, symbol = Symbol.for('codlet.workspace.shadow.result');
let audit, workspace, base, discovery;
export function activate(context) {
  audit = { phase: 'idle', inspect: () => ({ available: true, phase: audit.phase, result: audit.result }), run }; globalThis[symbol] = audit;
  async function run({ threadIds = [] } = {}) {
    audit.phase = 'connecting'; const samples = [], phases = [];
    try {
      const access = await context.rpc.request(capability, 'getApi', {}); workspace = globalThis[Symbol.for(access.symbol)].connect(context, access.ticket);
      if (workspace.getSnapshot().auxiliary) { audit.result = { status: 'auxiliary' }; return; }
      base=deferredNavigation(context);discovery=createWorkspaceDiscovery(base.native);const native=await discovery.transcript();
      const slot = workspace.createSlot('workspace.overlay'), holder = document.createElement('div');
      holder.style.cssText = 'position:fixed;left:-17000px;top:0;width:600px;height:800px;display:flex;flex-direction:column;'; slot.container.append(holder);
      if (threadIds.length !== 2 || threadIds.some(id => !/^[-\w]{8,256}$/u.test(id)) || new Set(threadIds).size !== 2) throw Error('Two explicit owned synthetic threadIds required');
      const ids = threadIds;
      for (const id of ids) {
        audit.phase = 'mounting'; const box = document.createElement('div'); box.style.cssText = 'width:600px;height:400px;min-height:400px;'; holder.append(box);
        const start = performance.now(), handle = workspace.mountTranscript(box, { threadId: id, readOnly: false, onState: state => phases.push({ id, phase: state.phase, diagnostic: state.diagnostic }) }); await handle.ready;
        const host = box.firstElementChild, root = host.shadowRoot, scroller = root?.querySelector('.thread-scroll-container'), body = root?.querySelector('[data-thread-find-target="conversation"]');
        if (!scroller || !body) throw Error('An independent shadow transcript and scroller are required');
        handle.setScrollPosition({ top: -31, left: 0 });
        const buttons = [...root.querySelectorAll('button')].slice(0,15).map(button => { const css = getComputedStyle(button), rect = button.getBoundingClientRect(); return { label: button.getAttribute('aria-label'), title: button.getAttribute('title'), popup: button.getAttribute('aria-haspopup'), width: rect.width, height: rect.height, radius: css.borderRadius, color: css.color, background: css.backgroundColor, border: css.borderColor, font: css.fontFamily }; });
        const link = root.querySelector('a[href]'), bodyStyle = getComputedStyle(body);
        const marker = document.createElement('span'), external = new MutationObserver(records => { external.records = (external.records ?? 0) + records.length; }); external.observe(document.body, { childList: true, subtree: true }); body.append(marker); await Promise.resolve(); await Promise.resolve(); const isolatedMutations = external.records ?? 0; marker.remove(); external.disconnect();
        const originalClass = document.documentElement.getAttribute('class'), originalTheme = document.documentElement.getAttribute('data-theme'), originalScheme = document.documentElement.style.getPropertyValue('color-scheme'), schemePriority = document.documentElement.style.getPropertyPriority('color-scheme');
        const primaryBody = document.querySelector('main [data-thread-find-target="conversation"]');
        const theme = { htmlClass: originalClass, htmlAttributes: Object.fromEntries([...document.documentElement.attributes].filter(a => /theme|color|class|style/.test(a.name)).map(a => [a.name, a.value])), before: { shadow: getComputedStyle(body).color, primary: primaryBody && getComputedStyle(primaryBody).color } };
        try {
          if (['light','dark'].includes(originalTheme)) {
            document.documentElement.setAttribute('data-theme',originalTheme==='light'?'dark':'light');
            theme.after={shadow:getComputedStyle(body).color,primary:primaryBody&&getComputedStyle(primaryBody).color};
          } else if (document.documentElement.classList.contains('light') || document.documentElement.classList.contains('dark')) {
            const dark = document.documentElement.classList.contains('dark'); document.documentElement.classList.toggle('dark', !dark); document.documentElement.classList.toggle('light', dark); document.documentElement.style.setProperty('color-scheme', dark ? 'light' : 'dark');
            theme.after = { shadow: getComputedStyle(body).color, primary: primaryBody && getComputedStyle(primaryBody).color };
          }
        } finally { if(originalTheme==null)document.documentElement.removeAttribute('data-theme');else document.documentElement.setAttribute('data-theme',originalTheme);if (originalClass == null) document.documentElement.removeAttribute('class'); else document.documentElement.setAttribute('class', originalClass); if (originalScheme) document.documentElement.style.setProperty('color-scheme', originalScheme, schemePriority); else document.documentElement.style.removeProperty('color-scheme'); }
        const copyButton = [...root.querySelectorAll('button')].find(button => button.getAttribute('aria-label') === '复制消息');
        let copy;
        if (copyButton && navigator.clipboard?.readText && navigator.clipboard?.writeText) {
          let saved;
          try { saved = await navigator.clipboard.readText(); copyButton.click(); await new Promise(resolve => setTimeout(resolve, 100)); const copied = await navigator.clipboard.readText(); copy = { attempted: true, copiedLength: copied.length, changed: copied !== saved }; }
          catch (error) { copy = { attempted: saved != null, error: error.message }; }
          finally { if (saved != null) { await navigator.clipboard.writeText(saved); copy.restored = (await navigator.clipboard.readText()) === saved; } }
        }
        const popupButtons = [...root.querySelectorAll('button[aria-haspopup]')].map(button => ({ label: button.getAttribute('aria-label'), popup: button.getAttribute('aria-haspopup'), title: button.getAttribute('title') }));
        let linkRequest;
        if(link)try{
          const bridge=uniqueExport(native.shared,value=>typeof value?.postMessage==='function'&&componentSource(value.postMessage).includes('codex-message-from-view')&&componentSource(value.postMessage).includes('electronBridge'),'Native message facade');
          const original=bridge.postMessage,requests=[],expected=link.href;
          const capture=function(message,...rest){if(/open|browser|external|url/i.test(message?.type??'')&&JSON.stringify(message).includes(expected)){requests.push({type:message.type,url:message.url??message.browserPanel?.url,conversationId:message.conversationId??message.browserPanel?.conversationId,path:message.path});return;}return Reflect.apply(original,this,[message,...rest]);};
          bridge.postMessage=capture;
          try{link.addEventListener('click',event=>event.preventDefault(),{capture:true,once:true});link.click();await new Promise(resolve=>setTimeout(resolve,80));linkRequest={requests,blockedExternalOpening:true};}
          finally{if(bridge.postMessage===capture)bridge.postMessage=original;}
        }catch(error){linkRequest={error:error.message};}
        const menuBefore=new Set(document.querySelectorAll('[role="menu"]'));
        body.dispatchEvent(new MouseEvent('contextmenu',{bubbles:true,composed:true,cancelable:true,clientX:20,clientY:80,button:2}));await new Promise(resolve=>setTimeout(resolve,80));
        const menus=[...document.querySelectorAll('[role="menu"]')].filter(menu=>!menuBefore.has(menu));const contextMenu={opened:menus.length,items:menus.flatMap(menu=>[...menu.querySelectorAll('[role^="menuitem"]')].map(item=>item.textContent.trim()))};
        if(menus.length){document.dispatchEvent(new KeyboardEvent('keydown',{key:'Escape',bubbles:true,cancelable:true}));await new Promise(resolve=>setTimeout(resolve,30));contextMenu.closed=menus.every(menu=>!menu.isConnected);}
        const scrollBeforeFlags=handle.getScrollPosition();
        handle.update({ readOnly: true }); await new Promise(resolve => setTimeout(resolve, 50)); handle.update({ readOnly: false }); await new Promise(resolve => setTimeout(resolve, 50));
        samples.push({ id, readyMs: performance.now() - start, bodyLength: body.textContent.trim().length, scroll: handle.getScrollPosition(),scrollBeforeFlags, retained: root.querySelector('.thread-scroll-container') === scroller && root.querySelector('[data-thread-find-target="conversation"]') === body, isolatedMutations, lightQuerySeesBody: !!box.querySelector('[data-thread-find-target="conversation"]'), styleCount: root.querySelectorAll('link').length, stylesLoaded: [...root.querySelectorAll('link')].every(link => !!link.sheet), font: bodyStyle.fontFamily, color: bodyStyle.color, buttons, link: link && { href: link.href, color: getComputedStyle(link).color, decoration: getComputedStyle(link).textDecorationLine },linkRequest,contextMenu, theme, copy, popupButtons });
      }
      audit.result = { status: 'passed', samples, phases, route: workspace.getSnapshot().threadId };
    } catch (error) { audit.result = { status: 'failed', phase: audit.phase, code: error.code, message: error.message, samples, phases }; }
    finally { workspace?.dispose(); workspace = null;discovery?.dispose();base?.dispose(); audit.phase = 'done'; }
  }
}
export function deactivate() { workspace?.dispose();discovery?.dispose();base?.dispose(); if (globalThis[symbol] === audit) delete globalThis[symbol]; }
