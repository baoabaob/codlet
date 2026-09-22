# Security

Codlet executes explicitly trusted extension code. Renderer worlds share the
page DOM; main-world and raw CDP access are powerful. Host JavaScript runs with
the current user's operating-system privileges. Broker permissions constrain
managed calls and are not an OS sandbox for arbitrary Node code.

Report reproducible defects in authorization, ownership, lifecycle cleanup,
archive validation or other managed boundaries through the repository's
[issue tracker](https://github.com/baoabaob/codlet/issues). Use a minimal synthetic
example. Do not post access tokens, account files, private conversations, full
process command lines or memory dumps. This tracker is not promised to be a
confidential reporting channel; arrange a suitable channel with the maintainer
before sharing sensitive details.

Only the current development branch is maintained during Preview. There is no
guaranteed response time. See [known issues](docs/known-issues.md) for boundaries
and [troubleshooting](docs/troubleshooting.md) for the contents of local diagnostics.
