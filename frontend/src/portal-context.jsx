import { createContext } from 'react';
export const PortalContainer = createContext(null);
// Escape ownership includes a page, its native toolbar, and its body-level overlays.
// The overlay destination must not double as the event scope.
export const PortalScope = createContext(null);
// Radix suppresses its built-in Escape dismissal before the upstream Popover's
// body listener runs. Distinguish that owned suppression from a host-handled key.
export const ownedEscape = new WeakSet();
