# Plugin update manifests

Published plugins use a static, signed update manifest. Core downloads this file
and compares versions locally. Automatic and manual update checks do not query
GitHub's repository or Release APIs. The format and verification rules apply to
every plugin.

## Required publication files

A new public plugin release contains:

- An installable ZIP named `<plugin-id>-<version>.zip`, with `codlet.json`, built
  entrypoints, resources, licenses and `codlet-update.json` at its root.
- A `codlet-updates.json` Release asset declaring the actual ZIP bytes and signed
  by the publisher.
- A `codlet-release.json` declaration when publishing through Codlet's release
  tool. This existing discovery declaration contains the package metadata and
  ZIP identity; it is separate from the signed update manifest.

Use semantic versions and a `v<version>` tag. Keep each version's ZIP and
declarations immutable. Upload all assets before publishing the Release.
Dependencies and expanded permissions continue through the usual installation
review; an update signature does not grant permissions.

## Publisher tool

The [publisher tool](../../scripts/plugin-release.mjs) uses Node.js built-ins.
The running Codlet skill also supplies it as `scripts/plugin-release.mjs`.
Generate a signing key once, outside the plugin package and source repository:

```sh
node scripts/plugin-release.mjs keygen --private-key /private/plugin.ed25519.pem
```

Keep and back up that private key for later releases. The public key is safe to
publish; the private key must not enter a ZIP, Git repository or release asset.
A lost key requires an explicit source migration by existing installations.

Build a clean package directory, then generate the release files:

```sh
node scripts/plugin-release.mjs pack \
  --package /build/plugin \
  --repository author/plugin \
  --private-key /private/plugin.ed25519.pem \
  --output /build/releases/1.2.0
```

The output directory must be new or empty and outside the package directory.
The tool inserts `codlet-update.json` into the ZIP, signs the ZIP's actual
SHA-256 and size, and writes the ZIP, both JSON assets and `SHA256SUMS.txt`.
It does not upload files or publish a Release.

Verify the resulting manifest with:

```sh
node scripts/plugin-release.mjs verify \
  --manifest /build/releases/1.2.0/codlet-updates.json \
  --repository author/plugin
```

Use `--previous /path/codlet-updates.json` when updating a feed containing
multiple plugins. The tool preserves other plugins and retains the highest
stable and prerelease version for each ID. It rejects changed bytes for the
same ID/version and a different signing key for an existing ID.

## Update source inside the ZIP

`codlet-update.json` is a UTF-8 JSON file of at most 4 KiB:

```json
{
  "schema": 1,
  "manifestUrl": "https://github.com/author/plugin/releases/latest/download/codlet-updates.json",
  "publicKey": "<base64 Ed25519 public key>"
}
```

The public key contains 32 bytes in standard padded base64. Core records this
source with the verified installation receipt. A key found only in a remote
manifest cannot authorize a package replacement.

The default address is the direct `releases/latest/download/codlet-updates.json`
link. GitHub's `latest` route selects a non-prerelease. Each subsequent stable
Release must carry the feed, including entries for other plugins that still
use that repository.

For a preview channel or a separately maintained monorepo feed, pass
`--manifest-url` with a fixed public file in the same repository, for example:

```text
https://raw.githubusercontent.com/author/plugin/main/codlet-updates.json
```

The pack command rejects a prerelease using the default `latest` route. A
dedicated `codlet-updates` branch can keep a stable feed URL separate from source
commits. Publish referenced ZIP assets before committing a new raw feed. Stable
installations ignore prerelease versions; an installation already on a
prerelease can select a newer prerelease or stable version.

To combine a newly published release with the current channel without exposing
the private key again, merge their already signed entries:

```sh
node scripts/plugin-release.mjs merge \
  --incoming /build/release/codlet-updates.json \
  --previous /build/current-channel.json \
  --repository author/plugin \
  --output /build/next-channel.json
```

Upload or commit the resulting file to the fixed feed address only after every
referenced ZIP is publicly available. A draft Release must not advance that
channel. Keep versioned Release assets unchanged.

Core currently accepts HTTPS Release-file and raw-file feed addresses in the
installed repository. Credentials, query parameters, API URLs and unrelated
repositories are rejected. Keep the feed address and signing key stable;
changing either requires explicit source review.

## Signed feed format

`codlet-updates.json` is at most 256 KiB and contains 1–128 entries. A feed may
contain multiple plugins, each with its own signing key. Each ID/version pair
must be unique. See the [JSON schema](../../schemas/plugin-updates.schema.json).

```json
{
  "schema": 1,
  "kind": "codlet-plugin-updates",
  "plugins": [
    {
      "payload": {
        "id": "example.notes",
        "version": "1.2.0",
        "repositoryUrl": "https://github.com/author/plugin",
        "tag": "v1.2.0",
        "asset": {
          "name": "example.notes-1.2.0.zip",
          "url": "https://github.com/author/plugin/releases/download/v1.2.0/example.notes-1.2.0.zip",
          "bytes": 12345,
          "sha256": "<64 lowercase hexadecimal characters>"
        }
      },
      "publicKey": "<base64 Ed25519 public key>",
      "signature": "<base64 Ed25519 signature>"
    }
  ]
}
```

The example uses placeholders; generate the real file with the publisher tool.
The archive URL must be the exact repository/tag/filename direct download
address. API asset URLs, source-code archives and mutable `latest` ZIP links
are not accepted. ZIP size is limited to 32 MiB.

For another publishing implementation, sign these bytes with Ed25519:

```text
UTF8("Codlet plugin update v1\n") || canonicalJSON(payload)
```

Canonical JSON recursively sorts object keys in ascending ASCII order, keeps
array order, uses standard JSON string escaping and UTF-8, and contains no
insignificant whitespace. This schema's numeric data is bounded to exact
integers. The signature contains 64 bytes in standard padded base64. Unknown
fields are rejected. Node and Rust share a verification fixture to check their
encodings.

## Client behavior and existing installations

Core coalesces plugins using the same feed and allows at most four concurrent
feed downloads. Successful feeds persist across restarts for six hours.
Manual refresh bypasses that lifetime but retains a one-minute minimum between
attempts and any server `Retry-After` or exhausted-quota reset time. HTTP ETags
allow conditional refresh. A failed refresh preserves the last verified result
and its original timestamp; it is not recorded as a new successful check.

After a signing key is installed, checking and downloading updates use public
file URLs exclusively. Core verifies the signature, pinned key, repository,
plugin ID, semantic version, ZIP hash and size, extracted package, permissions
and installation receipt. Redirects to the REST API or unrelated origins fail
closed.

For an older installation without `codlet-update.json`, discovery reads the
repository's default static feed. Its key is advisory until an explicit update
verifies the package against the previously pinned GitHub repository and owner.
That first migration can use the REST API; subsequent signed updates do not.
An explicit update of a legacy plugin whose feed is missing can still use the
existing GitHub import path. Missing or invalid feeds never trigger a REST
fallback during background or manual **checks**.

Older releases without a feed remain installable through the explicit Release
picker. Their update status explains that the publisher has not yet provided a
manifest. Local author directories are not enrolled in remote updates.
