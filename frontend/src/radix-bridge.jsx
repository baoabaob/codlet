import React, { useContext } from 'react';
import * as Radix from 'radix-original';
import { PortalContainer, ownedEscape } from './portal-context.jsx';
export * from 'radix-original';

// The official components omit Radix's optional container prop. Supply only
// that public prop so their portals stay inside the owning plugin/modal.
const withinOwner = (primitive, customEscape = false) => ({
  ...primitive,
  Portal: function OwnedPortal(props) {
    const container = useContext(PortalContainer);
    return <primitive.Portal {...props} container={props.container ?? container ?? undefined} />;
  },
  ...(customEscape ? { Content: function OwnedContent(props) {
    return <primitive.Content {...props} onEscapeKeyDown={event => {
      const handled = event.defaultPrevented;
      props.onEscapeKeyDown?.(event);
      if (!handled && event.defaultPrevented) ownedEscape.add(event);
    }}/>;
  } } : {}),
});
export const Popover = withinOwner(Radix.Popover, true);
export const Tooltip = withinOwner(Radix.Tooltip);
export const Select = withinOwner(Radix.Select);
export const DropdownMenu = withinOwner(Radix.DropdownMenu, true);
export const Dialog = withinOwner(Radix.Dialog);
