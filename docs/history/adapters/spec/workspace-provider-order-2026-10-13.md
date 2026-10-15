# Current Native provider order correction

The 57098b2 candidate's transcript roots produced `Missing parent scope` before the independent viewport was enabled. The failed sample is retained. Ordinary route restoration did succeed in that sample, but eight error-placeholder bodies are not successful transcript readiness or overall Native acceptance.

`currentAncestry` constructs a root-to-host Set while proving current parent/child links; `currentElementAncestry` already reverses it into nearest-first order. The new `providersFor` incorrectly reversed it again. Because only the first value for each repeated React Context is selected, the outer empty/upstream chain could replace the inner Native AppScope chain, causing Native ScopeProvider `ult` to fail. The corrected code walks the already proven nearest-first order directly, preserving the old ancestry fallback for synthetic/unproven fixtures.

New real-React regressions cover a repeated Context with an outer empty chain and inner AppScope, the new inner value on a reused DOM node, and an actual transcript Content requiring that inner AppScope. Earlier tests had only one provider value per Context and did not expose the ordering error. No Core, draft, route, backend or viewport strategy change is needed.

The corrected package retains the draft namespace restoration, independent viewport candidate and floating/body geometry contract. Source/offline success is separate from the consumer-owned Native body/new-draft/sidebar/summary retest.
