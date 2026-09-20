'use strict';

// Audited 26.908.40834 / 8881: app-initial xBa ($M) renders the aside/h3;
// app-primary's upsell banner supplies codex.upsellBanner.merged.* titles.
// Match the complete title and a quota action inside that card only.
const CARD = 'aside.relative.isolate.bg-surface';
const ATTRIBUTE = 'data-codlet-hide-usage-banner';
const TITLES = [
    "you're out of codex and work usage",
    "you've used all codex and work usage",
    '你的 codex 和工作使用额度已用完',
    'codex 和工作使用额度已用完',
    'codex 和工作用量均已用完',
    '你的 codex 和工作用量均已用完',
    '你的 codex 和工作使用量已用完',
    '你已用完 codex 和工作的所有使用量',
    'codex 及「工作」用量已用盡',
    '你已用盡 codex 和「工作」用量',
];
const ACTIONS = new Set(['add credits', 'reset usage', '增加额度', '添加额度', '重置使用量', '新增積分', '重設使用量']);
let dispose = null;

function normalize(value) {
    return String(value || '').replace(/[\u2018\u2019]/g, "'").replace(/\s+/g, ' ').trim().toLowerCase();
}

function isUsageCard(card) {
    if (!card.matches(CARD)) return false;
    const heading = card.querySelector('h3');
    if (!heading || heading.closest('aside') !== card) return false;
    // Native has both a title-only h3 and a title/description wrapper. Localized
    // titles may themselves be spans. Never match the whole card by substring.
    const titles = [heading, ...heading.querySelectorAll('div, span')];
    if (!titles.some(node => TITLES.includes(normalize(node.textContent)) ||
        TITLES.includes(normalize([...node.childNodes].filter(child => child.nodeType === 3).map(child => child.textContent).join(''))))) return false;
    return [...card.querySelectorAll('button')].some(button =>
        button.closest('aside') === card && ACTIONS.has(normalize(button.textContent)));
}

module.exports = {
    activate(context) {
        dispose?.();
        const token = 'g' + context.generation + '-' + Math.random().toString(36).slice(2);
        const marked = new Set();
        const style = document.createElement('style');
        style.textContent = `aside[${ATTRIBUTE}="${token}"] { display: none !important; }`;
        let closed = false;
        let frame = null;

        function restore(card) {
            if (card.getAttribute(ATTRIBUTE) === token) card.removeAttribute(ATTRIBUTE);
            marked.delete(card);
        }

        function reconcile() {
            frame = null;
            if (closed) return;
            if (!style.isConnected) (document.head || document.documentElement).appendChild(style);
            for (const card of marked) {
                if (!card.isConnected || !isUsageCard(card)) restore(card);
            }
            for (const card of document.querySelectorAll(CARD)) {
                if (!isUsageCard(card) || marked.has(card) || card.hasAttribute(ATTRIBUTE)) continue;
                card.setAttribute(ATTRIBUTE, token);
                marked.add(card);
            }
        }

        const observer = new MutationObserver(() => {
            if (!closed && frame === null) frame = requestAnimationFrame(reconcile);
        });
        observer.observe(document, {
            childList: true, characterData: true, subtree: true,
            attributes: true, attributeFilter: ['class'],
        });
        dispose = () => {
            closed = true;
            observer.disconnect();
            if (frame !== null) cancelAnimationFrame(frame);
            frame = null;
            for (const card of marked) restore(card);
            style.remove();
        };
        reconcile();
    },
    deactivate() {
        dispose?.();
        dispose = null;
    },
};
