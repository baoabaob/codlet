# Native build 22391 adaptation

Core `1.0.0-rc.20` passed isolated Windows x64 acceptance on Native package
`26.1023.6123.0`, app `26.1023.50603`, build `22391`, and regression checks on
package `26.1021.3705.0`, app `26.1021.31345`, build `21828`. Both runs used the
same ordinary production executable. See [rc.20 validation](releases/1.0.0-rc.20/validation.md)
for its hash and exact coverage. Remote rc.20 publication is not recorded.

## Reviewed Native identity

The downloaded x64 MSIX is 979,149,564 bytes and passes Authenticode verification.
Its SHA-256 is
`9890e869a0d40fc00f396ce48ba05dc45ccb8bb36d151dcd1a2ff23d270f2e4d`.
The extracted ASAR SHA-256 is
`773eaad4039291c80217d62c97711bb0e4b941fcf4429aaeeb3b04856c4e83ab`.
The reviewed renderer assets are initial `b0cd131b9dba`, shared `624e1c099f95`
and primary `8eba40dc50b2`.

The final 2026-10-28 release and Microsoft Retail distribution checks still
supply package `26.1023.6123.0`. The Store notification response names
`26.1023.6621.0`, which is absent from the returned installable packages.
The notification does not establish that `.6621.0` was downloaded, reviewed or accepted.

## Sidebar ownership

Both builds retain Native's classic sidebar and navigation rail. Build `22391`
moves the rail tooltip's right-side default from the destination's own property
to that same tooltip component's ancestor `DefaultsProvider`. Discovery follows
the actual component relationship and explicit-property precedence.

Navigation now resolves the currently mounted classic or rail owner after a
layout change. It keeps the existing plugin container, page lease and route,
and waits for a valid insertion location before publishing the replacement
control. Native fixed rows and their lexical groups identify the location;
unrelated navigation elements and competing insertion anchors do not qualify.
An actual contract contradiction remains an error. Owner retirement prevents
late publication.

Workspace action registration resolves the current navigation contract for
each independent preparation. Concurrent preparation may share its pending
work; an earlier failed handle does not become valid after a later layout change.

## Grouping and controlled branch checks

Native's Project/Chat sidebar options expose **Organize sidebar**, with
**By project**, **By connection**, and **In one list** where the current surface
and connections support them. The adapter follows the resulting mounted owner.
Changing the stored mode alone does not prove that a connection layout exists.

The disposable test can exercise the existing classic/rail gate through its
current Native AppScope facade. It must bind the original scope, gate family
and mounted binding, preserve their identities, observe Native's actual render
and restore the original value while that owner is live. This is controlled test
state; no persistent production sidebar gate setting has been established.

## Other mapped interfaces and validation boundary

The candidate maps the current working-state selectors, permission-profile
conversion, exact Windows executable bootstrap data, and official-update state
under the reviewed app/build identity. The permission reader also handles a
current Native picker return that has not populated its final result cache.
It verifies the actual loaded hook, lexical import, thread/configuration/sandbox
objects and picker-consumed fields. Ambiguous override decisions remain unsupported.
Reading the Native send baseline does not write permissions; Full access retains
its confirmation requirement. Source discovery and the update mapping do not
establish an installed official update or authorize replay of an unknown Native operation.

Initial renderer attachment recovery retires the sessions from the failed
initialization transaction. A retry after `Runtime.enable` or `Page.enable`
observation expiry requires confirmed teardown of those exact sessions and the
same live Native process and connection. It does not replay a plugin operation,
change a permission grant, or treat an unconfirmed teardown as reusable ownership.

Ready failures now retain complete terminal metadata and their original source
error. A retired owner cannot start or republish readiness; activation validation
retains its identity and field checks.

The final integrated Node group passed 535 tests, with two opt-in official
AppServer HTTP/WebSocket tests skipped. The generated bridge group passed 29;
72 distinct Rust regressions, SDK type checking, formatting and Clippy passed.
Actual Native runs on both builds verified synthetic conversations/history,
permission reads, shortcut-interface preparation, four rail/classic transitions,
plugin page and thread restoration, and the real By project/In one list menus.
The original group and gate were restored. Both runs exited normally with no
remaining owned processes. The build `22391` run also observed an initial
`Runtime.enable` timeout, retirement of that exact session, and automatic
generation-1 bootstrap without a manual reload.
