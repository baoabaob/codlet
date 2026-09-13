import { createContext } from 'react';
export const PortalContainer = createContext(null);
// Radix suppresses its built-in Escape dismissal before the upstream Popover's
// body listener runs. Distinguish that owned suppression from a host-handled key.
export const ownedEscape = new WeakSet();
