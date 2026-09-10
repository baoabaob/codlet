'use strict';

// Codex Desktop 26.903.8094.0: the usage card is an aside with an h3
// containing a title and description. Match that card, not arbitrary page text.
const CARD = 'aside.relative.isolate.bg-surface';
const ATTRIBUTE = 'data-codlet-hide-usage-banner';
const TITLES = [
    "you're out of codex and work usage",
    "you've used all codex and work usage",
];
const ACTIONS = new Set(['add credits', 'reset usage']);
let dispose = null;

function normalize(value) {
    return String(value || '').replace(/[\u2018\u2019]/g, "'").replace(/\s+/g, ' ').trim().toLowerCase();
}

function isUsageCard(card) {
    if (!card.matches(CARD)) return false;
    const heading = card.querySelector('h3');
    if (!heading || heading.closest('aside') !== card) return false;
    const carrier = heading.firstElementChild?.tagName === 'DIV' ? heading.firstElementChild : heading;
    // The description is a sibling span inside h3; textContent joins the title
    // and description without a space. Select only the direct title text nodes.
    const text = normalize([...carrier.childNodes].filter(node => node.nodeType === 3).map(node => node.textContent).join(''));
    if (!TITLES.includes(text)) return false;
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
