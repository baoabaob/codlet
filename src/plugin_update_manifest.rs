//! Publisher-signed, static plugin update feeds. The same format is used by
//! every plugin; a feed is a file download, never a GitHub REST API response.
use base64::{Engine, engine::general_purpose::STANDARD};
use serde::{Deserialize, Serialize};
use std::collections::BTreeSet;
use std::io::Read;
use std::path::Path;
use url::Url;

use crate::github_distribution::{GitHubLink, GitHubRepository, MAX_ARCHIVE_BYTES};

pub const SOURCE_FILE: &str = "codlet-update.json";
pub const FEED_FILE: &str = "codlet-updates.json";
pub const MAX_FEED_BYTES: u64 = 256 * 1024;
pub const MAX_FEED_ENTRIES: usize = 128;
const SIGNING_CONTEXT: &[u8] = b"Codlet plugin update v1\n";

/// Shipped inside the plugin ZIP and covered by the installation's file receipt.
/// A key obtained only from a remote feed is never an installation trust anchor.
#[derive(Clone, Debug, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
pub struct UpdateManifestSource {
    pub schema: u32,
    pub manifest_url: String,
    pub public_key: String,
}

#[derive(Clone, Debug, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
pub struct UpdateAsset {
    pub name: String,
    pub url: String,
    pub bytes: u64,
    pub sha256: String,
}

#[derive(Clone, Debug, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
pub struct UpdatePayload {
    pub id: String,
    pub version: String,
    pub repository_url: String,
    pub tag: String,
    pub asset: UpdateAsset,
}

#[derive(Clone, Debug, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
pub struct SignedPluginUpdate {
    pub payload: UpdatePayload,
    pub public_key: String,
    pub signature: String,
}

#[derive(Clone, Debug, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
pub struct PluginUpdateManifest {
    pub schema: u32,
    pub kind: String,
    pub plugins: Vec<SignedPluginUpdate>,
}

fn invalid(message: &str) -> String {
    format!("Invalid plugin update manifest: {message}")
}

fn decode_key(value: &str) -> Result<Vec<u8>, String> {
    let bytes = STANDARD
        .decode(value)
        .map_err(|_| invalid("the Ed25519 public key is not base64."))?;
    if bytes.len() != 32 || STANDARD.encode(&bytes) != value {
        return Err(invalid(
            "the Ed25519 public key must contain exactly 32 bytes.",
        ));
    }
    Ok(bytes)
}

pub(crate) fn sha256_is_valid(value: &str) -> bool {
    value.len() == 64
        && value
            .bytes()
            .all(|b| b.is_ascii_digit() || (b'a'..=b'f').contains(&b))
}

pub fn default_manifest_url(repository: &GitHubRepository) -> String {
    format!("{}/releases/latest/download/{FEED_FILE}", repository.url)
}

/// Update sources are public GitHub files in the already selected repository.
/// Redirects may use GitHub's asset CDN, but never its REST API.
pub fn validate_manifest_url(value: &str, repository: &GitHubRepository) -> Result<Url, String> {
    if value.len() > 2048
        || value
            .chars()
            .any(|c| c.is_control() || c == '\\' || c == '%')
    {
        return Err(invalid("the feed URL contains invalid characters."));
    }
    let url = Url::parse(value).map_err(|_| invalid("the feed URL is invalid."))?;
    if url.scheme() != "https"
        || !url.username().is_empty()
        || url.password().is_some()
        || url.port().is_some()
        || url.query().is_some()
        || url.fragment().is_some()
    {
        return Err(invalid("the feed must use a public HTTPS file URL."));
    }
    let parts: Vec<_> = url.path().trim_start_matches('/').split('/').collect();
    if parts.len() < 3
        || !parts[0].eq_ignore_ascii_case(&repository.owner)
        || !parts[1].eq_ignore_ascii_case(&repository.name)
        || parts
            .iter()
            .any(|p| p.is_empty() || *p == "." || *p == "..")
        || !value.ends_with(&format!("/{FEED_FILE}"))
        || value.contains("/../")
        || value.contains("/./")
    {
        return Err(invalid(
            "the feed must belong to the installed plugin's repository.",
        ));
    }
    let allowed = match url.host_str() {
        Some("github.com") => {
            parts.len() >= 6
                && parts[2] == "releases"
                && (parts[3] == "download"
                    || parts[3] == "latest" && parts.len() == 6 && parts[4] == "download")
        }
        Some("raw.githubusercontent.com") => parts.len() >= 4,
        _ => false,
    };
    if !allowed {
        return Err(invalid(
            "use a GitHub Release file or raw repository file URL.",
        ));
    }
    Ok(url)
}

impl UpdateManifestSource {
    pub fn validate(&self, repository: &GitHubRepository) -> Result<(), String> {
        if self.schema != 1 {
            return Err(invalid("unsupported source schema."));
        }
        decode_key(&self.public_key)?;
        validate_manifest_url(&self.manifest_url, repository)?;
        Ok(())
    }

    pub(crate) fn read(
        package: &Path,
        repository: &GitHubRepository,
    ) -> Result<Option<Self>, String> {
        let path = package.join(SOURCE_FILE);
        let metadata = match std::fs::symlink_metadata(&path) {
            Ok(metadata) => metadata,
            Err(error) if error.kind() == std::io::ErrorKind::NotFound => return Ok(None),
            Err(error) => return Err(error.to_string()),
        };
        #[cfg(windows)]
        {
            use std::os::windows::fs::MetadataExt;
            if metadata.file_attributes() & 0x400 != 0 {
                return Err(invalid("the update source must not be a filesystem link."));
            }
        }
        if !metadata.is_file() || metadata.file_type().is_symlink() || metadata.len() > 4096 {
            return Err(invalid(
                "the update source must be a regular file of at most 4 KiB.",
            ));
        }
        let mut data = Vec::new();
        std::fs::File::open(&path)
            .map_err(|error| error.to_string())?
            .take(4097)
            .read_to_end(&mut data)
            .map_err(|error| error.to_string())?;
        if data.len() > 4096 {
            return Err(invalid("the update source exceeds 4 KiB."));
        }
        let source: Self = serde_json::from_slice(&data)
            .map_err(|_| invalid("the update source is malformed."))?;
        source.validate(repository)?;
        Ok(Some(source))
    }
}

impl SignedPluginUpdate {
    pub fn verify(
        &self,
        repository: &GitHubRepository,
        trusted_key: Option<&str>,
    ) -> Result<(), String> {
        let payload = &self.payload;
        if !crate::plugins::valid_plugin_id(&payload.id)
            || payload.version.len() > 64
            || crate::runtime_update::newer_version(&payload.version, &payload.version).is_err()
            || payload.version.starts_with('v')
            || payload.tag != format!("v{}", payload.version)
            || payload.repository_url != repository.url
            || payload.asset.bytes == 0
            || payload.asset.bytes > MAX_ARCHIVE_BYTES
            || !sha256_is_valid(&payload.asset.sha256)
        {
            return Err(invalid(
                "the plugin, version, repository or archive identity is invalid.",
            ));
        }
        let link = GitHubLink::parse(&payload.asset.url)
            .map_err(|_| invalid("the archive must use a direct GitHub Release ZIP URL."))?;
        if link.repository != *repository
            || link.tag.as_deref() != Some(payload.tag.as_str())
            || link.asset_name.as_deref() != Some(payload.asset.name.as_str())
            || link.latest
        {
            return Err(invalid(
                "the archive URL does not match its repository, tag and filename.",
            ));
        }
        if trusted_key.is_some_and(|key| key != self.public_key) {
            return Err("The plugin update signing key changed. Review the publisher's source before updating.".into());
        }
        let public_key = decode_key(&self.public_key)?;
        let signature = STANDARD
            .decode(&self.signature)
            .map_err(|_| invalid("the signature is not base64."))?;
        if signature.len() != 64 || STANDARD.encode(&signature) != self.signature {
            return Err(invalid(
                "the Ed25519 signature must contain exactly 64 bytes.",
            ));
        }
        // serde_json::Value uses a sorted map. The publisher uses the same
        // recursive ASCII-key ordering; this schema has no floating-point data.
        let value = serde_json::to_value(payload).map_err(|error| error.to_string())?;
        let canonical = serde_json::to_vec(&value).map_err(|error| error.to_string())?;
        let mut message = Vec::with_capacity(SIGNING_CONTEXT.len() + canonical.len());
        message.extend_from_slice(SIGNING_CONTEXT);
        message.extend_from_slice(&canonical);
        ring::signature::UnparsedPublicKey::new(&ring::signature::ED25519, public_key)
            .verify(&message, &signature)
            .map_err(|_| "The plugin update manifest signature is invalid.".to_string())
    }

    pub fn release_url(&self) -> String {
        format!(
            "{}/releases/tag/{}",
            self.payload.repository_url, self.payload.tag
        )
    }
}

impl PluginUpdateManifest {
    pub fn parse(data: &[u8], repository: &GitHubRepository) -> Result<Self, String> {
        if data.len() as u64 > MAX_FEED_BYTES {
            return Err(invalid("the feed exceeds 256 KiB."));
        }
        let manifest: Self =
            serde_json::from_slice(data).map_err(|_| invalid("the feed is malformed."))?;
        if manifest.schema != 1
            || manifest.kind != "codlet-plugin-updates"
            || manifest.plugins.is_empty()
            || manifest.plugins.len() > MAX_FEED_ENTRIES
        {
            return Err(invalid("unsupported schema, kind or entry count."));
        }
        let mut identities = BTreeSet::new();
        for entry in &manifest.plugins {
            if !identities.insert((&entry.payload.id, &entry.payload.version)) {
                return Err(invalid("duplicate plugin/version entries."));
            }
            entry.verify(repository, None)?;
        }
        Ok(manifest)
    }

    pub(crate) fn latest<'a>(
        &'a self,
        id: &str,
        current: &str,
        repository: &GitHubRepository,
        trusted_key: Option<&str>,
    ) -> Result<Option<&'a SignedPluginUpdate>, String> {
        crate::runtime_update::newer_version(current, current)
            .map_err(|_| "The installed plugin version cannot be compared.".to_string())?;
        let accepts_prerelease = current.split('+').next().unwrap_or(current).contains('-');
        let mut found = false;
        let mut candidate: Option<&SignedPluginUpdate> = None;
        for entry in self.plugins.iter().filter(|entry| entry.payload.id == id) {
            found = true;
            entry.verify(repository, trusted_key)?;
            if !accepts_prerelease
                && entry
                    .payload
                    .version
                    .split('+')
                    .next()
                    .unwrap_or("")
                    .contains('-')
            {
                continue;
            }
            if crate::runtime_update::newer_version(&entry.payload.version, current)
                .unwrap_or(false)
                && candidate.is_none_or(|old| {
                    crate::runtime_update::newer_version(
                        &entry.payload.version,
                        &old.payload.version,
                    )
                    .unwrap_or(false)
                })
            {
                candidate = Some(entry);
            }
        }
        if !found {
            return Err("The publisher's update manifest does not contain this plugin.".into());
        }
        Ok(candidate)
    }
}

#[cfg(test)]
pub(crate) mod tests {
    use super::*;
    use ring::signature::KeyPair;

    pub(crate) fn key() -> ring::signature::Ed25519KeyPair {
        ring::signature::Ed25519KeyPair::from_seed_unchecked(&[7; 32]).unwrap()
    }
    pub(crate) fn sign(payload: UpdatePayload) -> SignedPluginUpdate {
        let key = key();
        let canonical = serde_json::to_vec(&serde_json::to_value(&payload).unwrap()).unwrap();
        let signature = key.sign(&[SIGNING_CONTEXT, canonical.as_slice()].concat());
        SignedPluginUpdate {
            payload,
            public_key: STANDARD.encode(key.public_key().as_ref()),
            signature: STANDARD.encode(signature.as_ref()),
        }
    }
    pub(crate) fn entry(id: &str, version: &str) -> SignedPluginUpdate {
        sign(UpdatePayload {
            id: id.into(),
            version: version.into(),
            repository_url: "https://github.com/example/plugins".into(),
            tag: format!("v{version}"),
            asset: UpdateAsset {
                name: format!("{id}-{version}.zip"),
                url: format!(
                    "https://github.com/example/plugins/releases/download/v{version}/{id}-{version}.zip"
                ),
                bytes: 100,
                sha256: "a".repeat(64),
            },
        })
    }
    pub(crate) fn feed(entries: Vec<SignedPluginUpdate>) -> PluginUpdateManifest {
        PluginUpdateManifest {
            schema: 1,
            kind: "codlet-plugin-updates".into(),
            plugins: entries,
        }
    }
    #[test]
    fn signature_binds_version_hash_size_url_and_installed_publisher_key() {
        let repository = GitHubRepository::parse("https://github.com/example/plugins").unwrap();
        let original = entry("community.notes", "1.2.0");
        original
            .verify(&repository, Some(&original.public_key))
            .unwrap();
        for change in 0..5 {
            let mut changed = original.clone();
            match change {
                0 => changed.payload.asset.sha256 = "b".repeat(64),
                1 => changed.payload.asset.bytes += 1,
                2 => changed.payload.id = "another.plugin".into(),
                3 => changed.payload.version = "1.3.0".into(),
                _ => {
                    changed.payload.asset.url =
                        "https://api.github.com/repos/example/plugins/releases/assets/7".into()
                }
            }
            assert!(
                changed
                    .verify(&repository, Some(&original.public_key))
                    .is_err()
            );
        }
        assert!(
            original
                .verify(&repository, Some(&STANDARD.encode([9; 32])))
                .is_err()
        );
    }
    #[test]
    fn signed_feeds_support_community_monorepos_and_preserve_prerelease_selection() {
        let repository = GitHubRepository::parse("https://github.com/example/plugins").unwrap();
        let manifest = feed(vec![
            entry("community.notes", "1.1.0"),
            entry("community.notes", "2.0.0-rc.1"),
            entry("another.tool", "3.0.0"),
        ]);
        let parsed =
            PluginUpdateManifest::parse(&serde_json::to_vec(&manifest).unwrap(), &repository)
                .unwrap();
        assert_eq!(
            parsed
                .latest("community.notes", "1.0.0", &repository, None)
                .unwrap()
                .unwrap()
                .payload
                .version,
            "1.1.0"
        );
        assert_eq!(
            parsed
                .latest("community.notes", "1.0.0-rc.1", &repository, None)
                .unwrap()
                .unwrap()
                .payload
                .version,
            "2.0.0-rc.1"
        );
        assert!(
            parsed
                .latest("missing.tool", "1.0.0", &repository, None)
                .is_err()
        );
        let duplicate = feed(vec![
            entry("another.tool", "3.0.0"),
            entry("another.tool", "3.0.0"),
        ]);
        assert!(
            PluginUpdateManifest::parse(&serde_json::to_vec(&duplicate).unwrap(), &repository)
                .is_err()
        );
    }
    #[test]
    fn feed_sources_cannot_query_the_api_or_redirect_to_another_repository() {
        let repository = GitHubRepository::parse("https://github.com/example/plugins").unwrap();
        for url in [
            default_manifest_url(&repository),
            "https://raw.githubusercontent.com/example/plugins/main/codlet-updates.json".into(),
            "https://github.com/example/plugins/releases/download/update-channel/codlet-updates.json".into(),
        ] {
            assert!(validate_manifest_url(&url, &repository).is_ok(), "{url}");
        }
        for url in [
            "https://api.github.com/repos/example/plugins/contents/codlet-updates.json",
            "http://github.com/example/plugins/releases/latest/download/codlet-updates.json",
            "https://github.com/another/plugins/releases/latest/download/codlet-updates.json",
            "https://raw.githubusercontent.com/example/plugins/../other/main/codlet-updates.json",
            "https://github.com/example/plugins/releases/latest/download/codlet-updates.json?token=secret",
            "https://github.com@example.net/example/plugins/releases/latest/download/codlet-updates.json",
        ] {
            assert!(validate_manifest_url(url, &repository).is_err(), "{url}");
        }
    }
    #[test]
    fn verifies_the_node_publisher_fixture_without_reencoding_differences() {
        let repository = GitHubRepository::parse("https://github.com/example/plugins").unwrap();
        let manifest = PluginUpdateManifest::parse(
            include_bytes!("../tests/fixtures/plugin-update-manifest.json"),
            &repository,
        )
        .unwrap();
        assert_eq!(manifest.plugins[0].payload.version, "1.2.0");
        assert_eq!(
            manifest.plugins[0].public_key,
            STANDARD.encode(key().public_key().as_ref())
        );
    }
}
