# Supplemental crate license texts

`asn1-rs-impl` 0.2.0 declares `MIT/Apache-2.0` but its published crate omits the workspace license files. The copies in `asn1-rs-impl-0.2.0/` are the unchanged root licenses from its published `.cargo_vcs_info.json` revision:

- [LICENSE-MIT](https://github.com/rusticata/asn1-rs/blob/a20e5f7319c896737ad0f2557037817b91ad854f/LICENSE-MIT)
- [LICENSE-APACHE](https://github.com/rusticata/asn1-rs/blob/a20e5f7319c896737ad0f2557037817b91ad854f/LICENSE-APACHE)

`collect-rust-licenses.py` verifies their SHA-256 values and uses them only for that exact crate version. Other missing attribution fails generation instead of silently substituting a generic license.
