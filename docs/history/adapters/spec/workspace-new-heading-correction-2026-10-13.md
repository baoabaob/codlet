# Empty Native home and visible disabled heading actions

This correction applies to the Adapter. Selection, layout and entry/exit policy remain the consumer's responsibility.

## Native home ownership

The consumer's read-only report `dev.split-workbench.inspect-8dda7604-215d-4f16-b5ff-bc82156eb3cc/report.json` confirms the actual untouched Native home input has two EditorProvider owners for one controller. Both keys match the Native draft formatter; one provider receives the controller externally. The prior requirement of exactly one provider incorrectly rejected this supported Native nesting with `workspace_host_pending`.

Draft confirmation now requires at least one current-controller owner and agreement of every such owner's key with the formatter. Distinct controllers for the same editable remain an ownership error. A conflicting key remains unconfirmed. No text, document, attachment, setter or draft recovery method is accessed. The home regression covers nested providers, a conflicting key and two distinct controllers. Location restoration continues to use Native semantic draft identity; its IME check remains before route or navigation-pin changes.

## Native home surface

The consumer's further read-only `inspect-49ba3cd9-c580-4229-a7af-9d38e8d1cc47` and `inspect-e17c088b-ec75-412f-8356-105bccb2ca5d` reports expose a second home-specific mismatch: the Native home has a main composer but no thread scroll container. Its body and input keep their original home layout. The initial `2f3e754` six-file package fixes draft ownership and heading actions only and is superseded for home entry by this surface correction.

The surface now recognizes Native's explicit `data-composer-placement="home"` marker without treating an incomplete thread layout as home. It uses the nearest main content layout, falling back to the Native main surface, and publishes a null scroller. The actual composer root includes its controls/banners and serves as the home footer region; no footer DOM is manufactured. Body viewport falls back to the real content/main bounds.

A body lease masks only siblings along the bounded composer-to-content ancestry, preserving the original composer, attachments, controllers, header, resource panel and protected floating regions. It never reparents the input. A malformed thread composer still rejects and cannot borrow a nearby unrelated scroller. Regressions cover public home geometry, body/disable/hide leases and exact release restoration. Native entry and unsent-draft acceptance remain the consumer's next checks.

## Heading presentation

The prior whole-child mask hid Native actions. The lease now masks only the Native title leaf, retains its layout space for the unselected label and disables visible heading actions. The title role uses the typography emitted by the current Native Title component (`min-w-0`, `text-base`, `font-medium`), independent of minified names and translated title strings. Generic button/link/custom-action discovery stays within the main Native heading; consumer-owned elements are excluded.

Each changed style/attribute has a compare-before-restore journal. Native disabled state, `aria-disabled`, `inert`, pointer blocking and capture listeners cover mouse, keyboard and synthetic activation without moving focus. Cleanup removes listeners and the label and restores only still-owned field values. The outer drag region is untouched.

Offline checks cover visibility/disabled state, custom activation blocking, consumer-owned controls, pre-existing disabled controls, header replacement and later Native field changes. They do not establish real-client visual acceptance. The consumer owns the next Native validation of home entry, unsent draft return and visible disabled actions. Existing ordinary-thread acceptance remains valid for its earlier frozen sample; independent sidebar and pinned summary acceptance remain pending.
