# rc.24 publication

[Core v1.0.0-rc.24](https://github.com/baoabaob/codlet/releases/tag/v1.0.0-rc.24)
is published as a Windows x64 preview. The release tag points to
`2a6fe2ad1847d9e5eaad4a037e44434b0580ebfb`, matching the production build and
release plan. GitHub reports five assets and `draft: false`.

All five assets were downloaded anonymously and matched their reviewed byte
lengths, local SHA-256 values and GitHub asset digests:

| Asset | Bytes | SHA-256 |
| --- | ---: | --- |
| Windows setup EXE | 9,038,336 | `6013ab396505ee8f53b59bc60e4e2f280d20cecd5ea8f8b0d0b9aa35557717fa` |
| Portable runtime ZIP | 10,057,514 | `933357223b34a636897b49dd2cc79102543878da5fae1bd221f83af41a6856b9` |
| Schema 1 update catalog | 562 | `131b9dc83130b221643780dca970bab18ffc61ca566906edebea9dfa0dd2f6e3` |
| Schema 2 update catalog | 562 | `7b4a80ad6c89866c1b74707d3e04a1c40bde6ac2c9da0d620e82bf357d26195f` |
| SHA256SUMS.txt | 410 | `b26a240dc1d292c314513d37abcd31cf8ce707f86bbb9ae50eeb544d1031566b` |

The installer includes the already published, signed GUI rc.7 package.
The [validation record](validation.md) gives its production identities,
independent Native acceptance and limitations. The public advisory compatibility
catalog is updated separately to revision `2026110701`, requiring Core rc.24,
Desktop 0.2.23 and UI 0.1.21 for Native package `26.1103.3517.0`.
