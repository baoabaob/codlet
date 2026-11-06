# rc.23 publication

Core [v1.0.0-rc.23](https://github.com/baoabaob/codlet/releases/tag/v1.0.0-rc.23)
and GUI [v1.0.0-rc.7](https://github.com/baoabaob/codlet-gui/releases/tag/v1.0.0-rc.7)
were published on 2026-11-06. Core main was verified at
`0eef3f7eabfb4024a69109e3c27e2d5ada6e0598`, plugin source main at
`22c4291388b44599ca504c3d0a03fed7b5c9ed20`, GUI distribution main at
`a8ffb325fdf5a08e227b86eae59d79c7e90c51a7`, and its signed update branch at
`d0ce7334381fa886d75dd99ce070b2799f862e65`.

Anonymous downloads matched the reviewed local artifacts:

| Asset | Bytes | SHA-256 |
| --- | ---: | --- |
| Core Windows setup | 9,013,760 | `3ac2512fa904ff6840922f609b34c519878bcfcb3c458708149eb07180226f0d` |
| Core portable runtime update | 10,032,843 | `e0b5f45deda05709a57db39485d44fb1f88852ca010525b9b54345e57c1413ac` |
| GUI rc.7 | 77,641 | `90d3794e126280fc048195882ddb60a45d928530b10032acbd384c7599dcfe02` |

The GUI feed's Ed25519 signature and archive digest were also verified before
reusing the published GUI package in the subsequent Core distribution.
The [validation record](validation.md) describes the accepted production build.
