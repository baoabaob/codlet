# Core rc.15 validation

This candidate corrects workspace view containment, keeps workspace action colors
independent of Native's activity filter, and includes the verified Native
`26.1016.8622.0` acceptance record in the offline compatibility catalog.

Hidden body leases suppress descendants that restore their own visibility while
retaining layout and input state. Each mounted Native transcript contains its
fixed-position descendants and resets inherited window drag-region declarations.

Completed checks:

- 445 embedded adapter regressions passed; two optional cases skipped.
- 57 workspace regressions passed after the final viewport containment change.
- 15 compatibility catalog Rust tests passed, including offline recognition and
  minimum-version enforcement for Native `26.1016.8622.0`.
- Desktop acceptance harness and compatibility coverage catalog checks passed.
- Split Workbench rc.5: 147 consumer regressions passed.

Native interaction verification is in progress. The earlier rc.14 short-history
fixture reproduced pane DOM removal during eight reorder cycles. Its three
caption hit-test points remained draggable. That fixture did not reproduce
attachment loss, empty transcript bodies, or scroll rebound; the extended fixture
uses twelve turns to activate Native's message navigation rail and virtualization.
