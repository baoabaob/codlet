# Contributing

Start with the [development guide](docs/development.md) and the
[architecture](docs/architecture.md). Public contracts live in [docs/spec](docs/README.md);
update the applicable contract and regression tests when behavior changes.

Keep changes focused. Do not commit local profiles, account files, credentials,
heap snapshots, build output, copied official application code, or dated progress
reports. Git preserves previous implementations and investigations; the working
tree should describe what is supported now. Keep reusable tests and fixtures when
they protect a real contract.

Use the configured Rust and Node versions. Run the checks relevant to the change;
the CI pipeline verifies the broader supported platform matrix. Rebuild generated
SDK bundles when their sources change. Official plugins are developed in the
separate [codlet-plugins repository](https://github.com/baoabaob/codlet-plugins).

Describe the behavior before and after the change, the checks actually run, and
any limits or untested platform behavior. A mock protocol test is not real desktop
acceptance. Do not start, terminate or mutate someone's normal client to run tests.

Contributions intentionally submitted for inclusion are under Apache-2.0 unless
explicitly stated otherwise, as described by section 5 of [LICENSE](LICENSE).
Keep third-party attribution and licenses with imported material.

For vulnerabilities, follow [SECURITY.md](SECURITY.md).
