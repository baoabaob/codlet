//! Read-only public GitHub Releases transport and bounded, non-executing packages.
//! Call async methods on a distribution worker, never the Core RPC event loop.
//! Production origins are fixed; only unit tests can inject a loopback transport.
use std::collections::BTreeSet;
use std::io::Read;
use std::path::{Path, PathBuf};
use std::time::Duration;

use serde::{Deserialize, Serialize};
use sha2::{Digest, Sha256};
use url::Url;

use crate::local_plugins::inspect_local_plugin;
use crate::plugins::PluginManifest;

mod archive;

pub const MAX_ARCHIVE_BYTES: u64 = 32 * 1024 * 1024;
pub const MAX_EXTRACTED_BYTES: u64 = 64 * 1024 * 1024;
pub const MAX_PACKAGE_FILES: usize = 2048;
const MAX_API_BYTES: u64 = 4 * 1024 * 1024;
const MAX_METADATA_BYTES: u64 = 64 * 1024;
const RECEIPT: &str = ".codlet-source.json";
const API_VERSION: &str = "2026-03-10";

#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
pub struct GitHubRepository {
    pub owner: String,
    pub name: String,
    pub url: String,
}

#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
pub struct GitHubLink {
    pub repository: GitHubRepository,
    pub tag: Option<String>,
    pub asset_name: Option<String>,
    pub latest: bool,
}

#[derive(Debug, Clone, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct GitHubAsset {
    pub id: u64,
    pub name: String,
    pub size: u64,
    pub content_type: String,
    pub download_url: String,
    pub digest: Option<String>,
}

#[derive(Debug, Clone, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct GitHubRelease {
    pub id: u64,
    pub tag: String,
    pub name: String,
    pub url: String,
    pub prerelease: bool,
    pub published_at: Option<String>,
    pub assets: Vec<GitHubAsset>,
}

#[derive(Debug, Clone, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct ReleaseCatalog {
    pub repository: GitHubRepository,
    pub releases: Vec<GitHubRelease>,
    pub truncated: bool,
    pub requested_tag: Option<String>,
    pub requested_asset: Option<String>,
}

#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
pub struct GitHubSource {
    pub repository_url: String,
    pub owner: String,
    pub repository: String,
    pub release_id: u64,
    pub tag: String,
    pub asset_id: u64,
    pub asset_name: String,
    pub asset_url: String,
    pub asset_size: u64,
    pub sha256: String,
    pub upstream_digest_verified: bool,
}

/// Optional publishing metadata, independent of the runtime's codlet.json schema.
/// Missing compatibility declarations are unknown; adapters are opaque data.
#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
pub struct PackageMetadata {
    pub schema: u32,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub runtime_api: Option<u32>,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub platforms: Option<Vec<String>>,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub author: Option<String>,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub adapters: Option<serde_json::Value>,
}

#[derive(Debug, Clone, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct PreparedGitHubPackage {
    pub package_path: PathBuf,
    pub archive_sha256: String,
    pub source: GitHubSource,
    pub manifest: PluginManifest,
    pub metadata: Option<PackageMetadata>,
}

#[derive(Debug, Clone, Serialize, thiserror::Error)]
#[error("{message}")]
#[serde(rename_all = "camelCase")]
pub struct GitHubDistributionError {
    pub code: String,
    pub message: String,
}
type Result<T> = std::result::Result<T, GitHubDistributionError>;
fn error(code: &str, message: impl Into<String>) -> GitHubDistributionError {
    GitHubDistributionError {
        code: code.into(),
        message: message.into(),
    }
}
fn io_error(e: std::io::Error) -> GitHubDistributionError {
    error("github_package_io", e.to_string())
}

impl GitHubRepository {
    pub fn parse(input: &str) -> Result<Self> {
        let link = GitHubLink::parse(input)?;
        if link.tag.is_some() || link.asset_name.is_some() || link.latest {
            return Err(error(
                "invalid_github_url",
                "Expected a GitHub repository URL.",
            ));
        }
        Ok(link.repository)
    }
    fn validate(&self) -> Result<()> {
        if Self::parse(&self.url)? != *self {
            return Err(error(
                "invalid_github_repository",
                "Repository fields do not match its canonical URL.",
            ));
        }
        Ok(())
    }
    fn endpoint(&self, suffix: &[&str]) -> Url {
        let mut url = Url::parse("https://api.github.com").expect("constant URL");
        url.path_segments_mut()
            .expect("base URL")
            .extend(["repos", &self.owner, &self.name])
            .extend(suffix);
        url
    }
}

impl GitHubLink {
    pub fn parse(input: &str) -> Result<Self> {
        let invalid = || {
            error(
                "invalid_github_url",
                "Use an HTTPS github.com repository, release, tag, or ZIP release-asset URL.",
            )
        };
        if input.len() > 2048 || input.bytes().any(|b| b.is_ascii_control() || b == b'\\') {
            return Err(invalid());
        }
        let tail = input.strip_prefix("https://").ok_or_else(invalid)?;
        let (authority, raw_path) = tail.split_once('/').ok_or_else(invalid)?;
        if !authority.eq_ignore_ascii_case("github.com") || raw_path.contains(['?', '#']) {
            return Err(invalid());
        }
        // Inspect original components before URL's dot-segment normalization.
        let parts: Vec<String> = raw_path
            .trim_end_matches('/')
            .split('/')
            .map(decode_segment)
            .collect::<Result<_>>()?;
        if parts.len() < 2 || parts.iter().any(|p| p.is_empty() || p == "." || p == "..") {
            return Err(invalid());
        }
        let owner = &parts[0];
        let name = &parts[1];
        if owner.len() > 39
            || !owner
                .bytes()
                .all(|b| b.is_ascii_alphanumeric() || b == b'-')
            || owner.starts_with('-')
            || owner.ends_with('-')
            || name.len() > 100
            || !name
                .bytes()
                .all(|b| b.is_ascii_alphanumeric() || b"._-".contains(&b))
            || name.ends_with('.')
            || name.ends_with(".git")
        {
            return Err(invalid());
        }
        // GitHub repository names and owners are case-insensitive; normalize
        // before checking API HTML URLs, whose casing may differ from the input.
        let (owner, name) = (owner.to_ascii_lowercase(), name.to_ascii_lowercase());
        let repository = GitHubRepository {
            url: format!("https://github.com/{owner}/{name}"),
            owner,
            name,
        };
        let (tag, asset_name, latest) = match parts[2..]
            .iter()
            .map(String::as_str)
            .collect::<Vec<_>>()
            .as_slice()
        {
            [] | ["releases"] => (None, None, false),
            ["releases", "latest"] => (None, None, true),
            ["releases", "tag", tag] if valid_tag(tag) => (Some((*tag).into()), None, false),
            ["releases", "download", tag, asset] if valid_tag(tag) && valid_asset_name(asset) => {
                (Some((*tag).into()), Some((*asset).into()), false)
            }
            ["releases", "latest", "download", asset] if valid_asset_name(asset) => {
                (None, Some((*asset).into()), true)
            }
            _ => return Err(invalid()),
        };
        Ok(Self {
            repository,
            tag,
            asset_name,
            latest,
        })
    }
}

fn decode_segment(raw: &str) -> Result<String> {
    let mut bytes = Vec::with_capacity(raw.len());
    let mut source = raw.bytes();
    while let Some(byte) = source.next() {
        if byte == b'%' {
            let hi = source.next().and_then(|b| (b as char).to_digit(16));
            let lo = source.next().and_then(|b| (b as char).to_digit(16));
            bytes.push(match (hi, lo) {
                (Some(a), Some(b)) => (a * 16 + b) as u8,
                _ => return Err(error("invalid_github_url", "Invalid percent encoding.")),
            });
        } else {
            bytes.push(byte);
        }
    }
    let decoded = String::from_utf8(bytes)
        .map_err(|_| error("invalid_github_url", "URL components must be UTF-8."))?;
    if decoded.chars().any(|c| c.is_control() || c == '\\') {
        return Err(error("invalid_github_url", "Invalid URL component."));
    }
    Ok(decoded)
}
fn valid_tag(tag: &str) -> bool {
    !tag.is_empty()
        && tag.len() <= 256
        && !tag.chars().any(char::is_control)
        && !tag.contains(['\\', '?', '#'])
        && tag
            .split('/')
            .all(|s| !s.is_empty() && s != "." && s != "..")
}
fn valid_asset_name(name: &str) -> bool {
    !name.is_empty()
        && name.len() <= 255
        && name.to_ascii_lowercase().ends_with(".zip")
        && !name.chars().any(char::is_control)
        && !name.contains(['/', '\\', ':'])
}
fn valid_sha256(value: &str) -> bool {
    value.len() == 64
        && value
            .bytes()
            .all(|b| b.is_ascii_digit() || (b'a'..=b'f').contains(&b))
}
fn trusted_url(url: &Url, asset: bool) -> bool {
    url.scheme() == "https"
        && url.username().is_empty()
        && url.password().is_none()
        && url.port().is_none()
        && url.fragment().is_none()
        && match url.host_str() {
            Some("api.github.com") => true,
            Some(
                "github.com"
                | "release-assets.githubusercontent.com"
                | "objects.githubusercontent.com",
            ) => asset,
            _ => false,
        }
}

#[derive(Clone)]
pub struct GitHubClient {
    client: reqwest::Client,
    #[cfg(test)]
    fixture_origin: Option<Url>,
}

impl GitHubClient {
    pub fn new() -> Result<Self> {
        let client = reqwest::Client::builder()
            .redirect(reqwest::redirect::Policy::none())
            .connect_timeout(Duration::from_secs(15))
            .timeout(Duration::from_secs(90))
            .user_agent("Codlet-public-release-import/1")
            .build()
            .map_err(|e| error("github_network", e.without_url().to_string()))?;
        Ok(Self {
            client,
            #[cfg(test)]
            fixture_origin: None,
        })
    }

    /// Lists at most 100 releases. `truncated` asks the user to use a tag URL.
    /// Only uploaded ZIP assets are offered; GitHub source archives are excluded.
    pub async fn list_releases(&self, link: &GitHubLink) -> Result<ReleaseCatalog> {
        link.repository.validate()?;
        if link.tag.as_deref().is_some_and(|s| !valid_tag(s))
            || link
                .asset_name
                .as_deref()
                .is_some_and(|s| !valid_asset_name(s))
        {
            return Err(error("invalid_github_url", "Invalid release selection."));
        }
        let (releases, truncated) = if let Some(tag) = &link.tag {
            let release: ApiRelease = self
                .json(link.repository.endpoint(&["releases", "tags", tag]))
                .await?;
            if release.tag_name != *tag {
                return Err(error(
                    "github_release_changed",
                    "The API returned a different release tag.",
                ));
            }
            (vec![release], false)
        } else if link.latest {
            (
                vec![
                    self.json(link.repository.endpoint(&["releases", "latest"]))
                        .await?,
                ],
                false,
            )
        } else {
            let mut endpoint = link.repository.endpoint(&["releases"]);
            endpoint.set_query(Some("per_page=100&page=1"));
            let releases: Vec<ApiRelease> = self.json(endpoint).await?;
            if releases.len() > 100 {
                return Err(error(
                    "github_response_limit",
                    "The release list exceeded its limit.",
                ));
            }
            let truncated = releases.len() == 100;
            (releases, truncated)
        };
        let mut seen = BTreeSet::new();
        let mut output = Vec::new();
        for release in releases {
            if release.draft {
                continue;
            }
            let release = release.checked(&link.repository)?;
            if !seen.insert(release.id) {
                return Err(error("github_response_invalid", "Duplicate release ID."));
            }
            output.push(release);
        }
        Ok(ReleaseCatalog {
            repository: link.repository.clone(),
            releases: output,
            truncated,
            requested_tag: link.tag.clone(),
            requested_asset: link.asset_name.clone(),
        })
    }

    /// Fetches fresh release metadata and exact asset bytes before creating a
    /// package. No registration, JavaScript evaluation, dependency install or build.
    pub async fn prepare_asset(
        &self,
        repository: &GitHubRepository,
        release_id: u64,
        asset_id: u64,
        registry_path: &Path,
    ) -> Result<PreparedGitHubPackage> {
        repository.validate()?;
        if release_id == 0 || asset_id == 0 {
            return Err(error(
                "invalid_github_selection",
                "Select release and asset IDs returned by GitHub.",
            ));
        }
        let release: ApiRelease = self
            .json(repository.endpoint(&["releases", &release_id.to_string()]))
            .await?;
        let release = release.checked(repository)?;
        if release.id != release_id {
            return Err(error(
                "github_release_changed",
                "The API returned a different release.",
            ));
        }
        let asset = release
            .assets
            .iter()
            .find(|a| a.id == asset_id)
            .ok_or_else(|| {
                error(
                    "github_asset_missing",
                    "The selected ZIP asset is not in this public release.",
                )
            })?;
        if asset.size == 0 || asset.size > MAX_ARCHIVE_BYTES {
            return Err(error(
                "github_archive_limit",
                "ZIP asset must be between 1 byte and 32 MiB.",
            ));
        }
        let bytes = self
            .get(
                repository.endpoint(&["releases", "assets", &asset_id.to_string()]),
                true,
                asset.size,
            )
            .await?;
        prepare_bytes(repository, &release, asset, &bytes, registry_path)
    }

    async fn json<T: serde::de::DeserializeOwned>(&self, url: Url) -> Result<T> {
        let bytes = self.get(url, false, MAX_API_BYTES).await?;
        serde_json::from_slice(&bytes).map_err(|e| {
            error(
                "github_response_invalid",
                format!("Invalid GitHub API response: {e}"),
            )
        })
    }

    async fn get(&self, mut url: Url, asset: bool, limit: u64) -> Result<Vec<u8>> {
        for hop in 0..=5 {
            if !trusted_url(&url, asset) {
                return Err(error(
                    "github_redirect_rejected",
                    "GitHub redirected outside the permitted HTTPS origins.",
                ));
            }
            #[allow(unused_mut)]
            let mut request_url = url.clone();
            #[cfg(test)]
            if let Some(origin) = &self.fixture_origin {
                request_url.set_scheme(origin.scheme()).unwrap();
                request_url.set_host(origin.host_str()).unwrap();
                request_url.set_port(origin.port()).unwrap();
            }
            // No Authorization, cookies, credential store, .netrc or gh invocation.
            let mut response = self
                .client
                .get(request_url)
                .header(
                    "Accept",
                    if asset {
                        "application/octet-stream"
                    } else {
                        "application/vnd.github+json"
                    },
                )
                .header("X-GitHub-Api-Version", API_VERSION)
                .header("Accept-Encoding", "identity")
                .send()
                .await
                .map_err(|e| error("github_network", e.without_url().to_string()))?;
            if response.status().is_redirection() {
                if hop == 5 {
                    return Err(error("github_redirect_limit", "Too many GitHub redirects."));
                }
                let location = response
                    .headers()
                    .get(reqwest::header::LOCATION)
                    .and_then(|v| v.to_str().ok())
                    .ok_or_else(|| {
                        error(
                            "github_redirect_rejected",
                            "GitHub redirect has no valid Location.",
                        )
                    })?;
                url = url.join(location).map_err(|_| {
                    error("github_redirect_rejected", "Invalid GitHub redirect URL.")
                })?;
                continue;
            }
            let status = response.status().as_u16();
            if status != 200 {
                return Err(match status {
                    403 | 429 => error(
                        "github_rate_limited",
                        "GitHub denied the request or its unauthenticated rate limit was reached. Try again later.",
                    ),
                    404 => error(
                        "github_not_found",
                        "Public repository, release or asset was not found. Private repositories are not supported.",
                    ),
                    _ => error(
                        "github_http_error",
                        format!("GitHub returned HTTP {status}."),
                    ),
                });
            }
            if response
                .headers()
                .get(reqwest::header::CONTENT_ENCODING)
                .is_some_and(|v| v != "identity")
            {
                return Err(error(
                    "github_response_invalid",
                    "Unexpected HTTP content encoding.",
                ));
            }
            if response.content_length().is_some_and(|size| size > limit) {
                return Err(error(
                    "github_response_limit",
                    "GitHub response exceeded the byte limit.",
                ));
            }
            let mut bytes = Vec::new();
            while let Some(chunk) = response
                .chunk()
                .await
                .map_err(|e| error("github_network", e.without_url().to_string()))?
            {
                if chunk.len() as u64 > limit.saturating_sub(bytes.len() as u64) {
                    return Err(error(
                        "github_response_limit",
                        "GitHub response exceeded the byte limit.",
                    ));
                }
                bytes.extend_from_slice(&chunk);
            }
            return Ok(bytes);
        }
        unreachable!("bounded redirect loop returns")
    }
}

#[derive(Deserialize)]
struct ApiAsset {
    id: u64,
    name: String,
    size: u64,
    content_type: String,
    browser_download_url: String,
    state: String,
    #[serde(default)]
    digest: Option<String>,
}
#[derive(Deserialize)]
struct ApiRelease {
    id: u64,
    tag_name: String,
    name: Option<String>,
    html_url: String,
    draft: bool,
    prerelease: bool,
    published_at: Option<String>,
    assets: Vec<ApiAsset>,
}
impl ApiRelease {
    fn checked(self, repository: &GitHubRepository) -> Result<GitHubRelease> {
        let invalid = || {
            error(
                "github_response_invalid",
                "GitHub release metadata is invalid or does not match the selected repository.",
            )
        };
        let release_link = GitHubLink::parse(&self.html_url).map_err(|_| invalid())?;
        if self.id == 0
            || self.draft
            || !valid_tag(&self.tag_name)
            || release_link.repository != *repository
            || release_link.tag.as_deref() != Some(self.tag_name.as_str())
            || release_link.asset_name.is_some()
            || self.assets.len() > 100
            || self.name.as_ref().is_some_and(|n| n.len() > 1024)
        {
            return Err(invalid());
        }
        let mut assets = Vec::new();
        let mut ids = BTreeSet::new();
        let mut names = BTreeSet::new();
        for asset in self.assets {
            if asset.state != "uploaded" || !asset.name.to_ascii_lowercase().ends_with(".zip") {
                continue;
            }
            if !valid_asset_name(&asset.name)
                || asset.id == 0
                || !ids.insert(asset.id)
                || !names.insert(asset.name.to_ascii_lowercase())
            {
                return Err(invalid());
            }
            let link = GitHubLink::parse(&asset.browser_download_url).map_err(|_| invalid())?;
            if link.repository != *repository
                || link.tag.as_deref() != Some(self.tag_name.as_str())
                || link.asset_name.as_deref() != Some(asset.name.as_str())
            {
                return Err(invalid());
            }
            if asset
                .digest
                .as_ref()
                .is_some_and(|d| !d.strip_prefix("sha256:").is_some_and(valid_sha256))
            {
                return Err(error(
                    "github_digest_unsupported",
                    "The release asset digest is not a valid SHA-256 digest.",
                ));
            }
            assets.push(GitHubAsset {
                id: asset.id,
                name: asset.name,
                size: asset.size,
                content_type: asset.content_type,
                download_url: asset.browser_download_url,
                digest: asset.digest,
            });
        }
        Ok(GitHubRelease {
            id: self.id,
            name: self.name.unwrap_or_else(|| self.tag_name.clone()),
            tag: self.tag_name,
            url: self.html_url,
            prerelease: self.prerelease,
            published_at: self.published_at,
            assets,
        })
    }
}

#[derive(Serialize, Deserialize)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
struct Receipt {
    schema: u32,
    package_path: PathBuf,
    source: GitHubSource,
    tree_sha256: String,
}

fn prepare_bytes(
    repository: &GitHubRepository,
    release: &GitHubRelease,
    asset: &GitHubAsset,
    bytes: &[u8],
    registry_path: &Path,
) -> Result<PreparedGitHubPackage> {
    if bytes.len() as u64 != asset.size {
        return Err(error(
            "github_size_mismatch",
            "Downloaded ZIP size does not match GitHub's asset metadata.",
        ));
    }
    let sha256 = format!("{:x}", Sha256::digest(bytes));
    if asset
        .digest
        .as_ref()
        .is_some_and(|digest| digest != &format!("sha256:{sha256}"))
    {
        return Err(error(
            "github_digest_mismatch",
            "Downloaded ZIP SHA-256 does not match GitHub's asset digest.",
        ));
    }
    let root = managed_root(registry_path, true)?;
    let staging = tempfile::Builder::new()
        .prefix(&format!("{sha256}-"))
        .tempdir_in(&root)
        .map_err(io_error)?;
    archive::extract(bytes, staging.path())?;
    let package_path = staging.path().canonicalize().map_err(io_error)?;
    let candidate = inspect_local_plugin(&package_path)
        .map_err(|e| error("github_package_invalid", e.to_string()))?;
    let metadata = read_metadata(&package_path)?;
    let source = GitHubSource {
        repository_url: repository.url.clone(),
        owner: repository.owner.clone(),
        repository: repository.name.clone(),
        release_id: release.id,
        tag: release.tag.clone(),
        asset_id: asset.id,
        asset_name: asset.name.clone(),
        asset_url: asset.download_url.clone(),
        asset_size: asset.size,
        sha256: sha256.clone(),
        upstream_digest_verified: asset.digest.is_some(),
    };
    let receipt = Receipt {
        schema: 1,
        package_path: package_path.clone(),
        source: source.clone(),
        tree_sha256: tree_digest(&package_path)?,
    };
    let data = serde_json::to_vec(&receipt).expect("receipt serializable");
    use std::io::Write;
    let mut file = std::fs::OpenOptions::new()
        .write(true)
        .create_new(true)
        .open(package_path.join(RECEIPT))
        .map_err(io_error)?;
    file.write_all(&data).map_err(io_error)?;
    file.sync_all().map_err(io_error)?;
    drop(file);
    let _ = staging.keep();
    Ok(PreparedGitHubPackage {
        package_path,
        archive_sha256: sha256,
        source,
        manifest: candidate.manifest,
        metadata,
    })
}

/// Recheck a Core-created package before preview/registration. Caller-supplied
/// source records or ownership flags are deliberately not accepted.
pub fn inspect_prepared_package(
    registry_path: &Path,
    package_path: &Path,
) -> Result<PreparedGitHubPackage> {
    let root = managed_root(registry_path, false)?;
    if !package_path.is_absolute() || package_path.parent() != Some(root.as_path()) {
        return Err(error(
            "github_package_unowned",
            "Package is not a direct child of this registry's GitHub package directory.",
        ));
    }
    check_regular(package_path, true)?;
    if package_path.canonicalize().map_err(io_error)? != package_path {
        return Err(error(
            "github_package_unowned",
            "Package path must be its canonical path.",
        ));
    }
    let receipt: Receipt = serde_json::from_slice(&read_bounded(
        &package_path.join(RECEIPT),
        MAX_METADATA_BYTES,
    )?)
    .map_err(|_| {
        error(
            "github_package_unowned",
            "Missing or invalid Core package receipt.",
        )
    })?;
    let name = package_path
        .file_name()
        .and_then(|n| n.to_str())
        .unwrap_or("");
    if receipt.schema != 1
        || receipt.package_path != package_path
        || !valid_sha256(&receipt.source.sha256)
        || !name.starts_with(&format!("{}-", receipt.source.sha256))
        || !valid_sha256(&receipt.tree_sha256)
    {
        return Err(error(
            "github_package_unowned",
            "Core package receipt does not match the managed directory.",
        ));
    }
    validate_source(&receipt.source)?;
    if tree_digest(package_path)? != receipt.tree_sha256 {
        return Err(error(
            "github_package_changed",
            "Prepared package contents changed. Download the asset again.",
        ));
    }
    let candidate = inspect_local_plugin(package_path)
        .map_err(|e| error("github_package_invalid", e.to_string()))?;
    let metadata = read_metadata(package_path)?;
    Ok(PreparedGitHubPackage {
        package_path: package_path.into(),
        archive_sha256: receipt.source.sha256.clone(),
        source: receipt.source,
        manifest: candidate.manifest,
        metadata,
    })
}

fn validate_source(source: &GitHubSource) -> Result<()> {
    let repo = GitHubRepository::parse(&source.repository_url)?;
    let asset = GitHubLink::parse(&source.asset_url)?;
    if repo.owner != source.owner
        || repo.name != source.repository
        || asset.repository != repo
        || asset.tag.as_deref() != Some(source.tag.as_str())
        || asset.asset_name.as_deref() != Some(source.asset_name.as_str())
        || source.release_id == 0
        || source.asset_id == 0
        || source.asset_size == 0
        || source.asset_size > MAX_ARCHIVE_BYTES
    {
        return Err(error(
            "github_package_unowned",
            "Invalid Core package source receipt.",
        ));
    }
    Ok(())
}

fn managed_root(registry_path: &Path, create: bool) -> Result<PathBuf> {
    let parent = registry_path.parent().ok_or_else(|| {
        error(
            "github_package_unowned",
            "Registry has no parent directory.",
        )
    })?;
    if create {
        std::fs::create_dir_all(parent).map_err(io_error)?;
    }
    let mut root = parent.canonicalize().map_err(io_error)?;
    for segment in ["packages", "github"] {
        root.push(segment);
        if create {
            match std::fs::create_dir(&root) {
                Ok(()) => (),
                Err(e) if e.kind() == std::io::ErrorKind::AlreadyExists => (),
                Err(e) => return Err(io_error(e)),
            }
        }
        check_regular(&root, true)?;
        if root.canonicalize().map_err(io_error)? != root {
            return Err(error(
                "github_package_unowned",
                "Managed package directories must not redirect.",
            ));
        }
    }
    Ok(root)
}

fn check_regular(path: &Path, directory: bool) -> Result<std::fs::Metadata> {
    let metadata = std::fs::symlink_metadata(path).map_err(io_error)?;
    let mut forbidden = metadata.file_type().is_symlink();
    #[cfg(windows)]
    {
        use std::os::windows::fs::MetadataExt;
        forbidden |= metadata.file_attributes() & 0x400 != 0;
        if !directory {
            // std Metadata cannot report link count on stable Windows. A handle
            // query makes receipt/tree reads reject hard links as the loader does.
            use std::os::windows::io::AsRawHandle;
            use windows_sys::Win32::Storage::FileSystem::{
                BY_HANDLE_FILE_INFORMATION, GetFileInformationByHandle,
            };
            let file = std::fs::File::open(path).map_err(io_error)?;
            let mut info: BY_HANDLE_FILE_INFORMATION = unsafe { std::mem::zeroed() };
            if unsafe { GetFileInformationByHandle(file.as_raw_handle(), &mut info) } == 0 {
                return Err(io_error(std::io::Error::last_os_error()));
            }
            forbidden |= info.nNumberOfLinks != 1;
        }
    }
    #[cfg(unix)]
    if !directory {
        use std::os::unix::fs::MetadataExt;
        forbidden |= metadata.nlink() != 1;
    }
    if forbidden || (directory && !metadata.is_dir()) || (!directory && !metadata.is_file()) {
        return Err(error(
            "github_package_unowned",
            "Package contains a link, redirect or special file.",
        ));
    }
    Ok(metadata)
}

fn read_bounded(path: &Path, limit: u64) -> Result<Vec<u8>> {
    let before = check_regular(path, false)?;
    if before.len() > limit {
        return Err(error(
            "github_package_limit",
            "Package file exceeds its byte limit.",
        ));
    }
    let mut bytes = Vec::new();
    std::fs::File::open(path)
        .map_err(io_error)?
        .take(limit + 1)
        .read_to_end(&mut bytes)
        .map_err(io_error)?;
    let after = check_regular(path, false)?;
    if bytes.len() as u64 > limit
        || before.len() != bytes.len() as u64
        || before.len() != after.len()
        || before.modified().ok() != after.modified().ok()
    {
        return Err(error(
            "github_package_changed",
            "Package changed while it was being checked.",
        ));
    }
    Ok(bytes)
}

fn read_metadata(root: &Path) -> Result<Option<PackageMetadata>> {
    let path = root.join("codlet-package.json");
    match std::fs::symlink_metadata(&path) {
        Err(e) if e.kind() == std::io::ErrorKind::NotFound => return Ok(None),
        Err(e) => return Err(io_error(e)),
        Ok(_) => (),
    }
    let metadata: PackageMetadata =
        serde_json::from_slice(&read_bounded(&path, MAX_METADATA_BYTES)?).map_err(|e| {
            error(
                "github_metadata_invalid",
                format!("Invalid codlet-package.json: {e}"),
            )
        })?;
    if metadata.schema != 1
        || metadata.author.as_ref().is_some_and(|s| s.len() > 512)
        || metadata.platforms.as_ref().is_some_and(|v| {
            v.is_empty()
                || v.len() > 16
                || v.iter().any(|s| {
                    s.len() > 64
                        || !s
                            .bytes()
                            .all(|b| b.is_ascii_alphanumeric() || b == b'-' || b == b'_')
                })
        })
    {
        return Err(error(
            "github_metadata_invalid",
            "Invalid package metadata schema, author or platforms.",
        ));
    }
    if metadata.runtime_api.is_some_and(|api| api != 1) {
        return Err(error(
            "github_runtime_incompatible",
            "Package declares an unsupported runtime API (this runtime supports API 1).",
        ));
    }
    let target = format!("{}-{}", std::env::consts::OS, std::env::consts::ARCH);
    if metadata.platforms.as_ref().is_some_and(|v| {
        !v.iter()
            .any(|s| s == "any" || s == std::env::consts::OS || s == &target)
    }) {
        return Err(error(
            "github_platform_incompatible",
            format!("Package does not declare support for {target}."),
        ));
    }
    Ok(Some(metadata))
}

fn tree_digest(root: &Path) -> Result<String> {
    let mut pending = vec![PathBuf::new()];
    let mut files = Vec::new();
    let mut count = 0usize;
    let mut total = 0u64;
    let mut names = BTreeSet::new();
    while let Some(relative) = pending.pop() {
        check_regular(&root.join(&relative), true)?;
        for entry in std::fs::read_dir(root.join(&relative)).map_err(io_error)? {
            let entry = entry.map_err(io_error)?;
            let path = relative.join(entry.file_name());
            let name = path
                .to_str()
                .ok_or_else(|| error("github_package_invalid", "Non-UTF-8 package path."))?
                .replace('\\', "/");
            if name == RECEIPT {
                continue;
            }
            let directory = entry.file_type().map_err(io_error)?.is_dir();
            archive::validate_name(&name)?;
            if !names.insert(name.to_ascii_lowercase()) {
                return Err(error(
                    "github_package_invalid",
                    "Duplicate case-insensitive package path.",
                ));
            }
            count += 1;
            if count > MAX_PACKAGE_FILES {
                return Err(error("github_package_limit", "Too many package entries."));
            }
            let metadata = check_regular(&entry.path(), directory)?;
            if directory {
                pending.push(path);
                files.push((name, None));
            } else {
                total = total
                    .checked_add(metadata.len())
                    .ok_or_else(|| error("github_package_limit", "Package size overflow."))?;
                if total > MAX_EXTRACTED_BYTES {
                    return Err(error("github_package_limit", "Package exceeds 64 MiB."));
                }
                files.push((name, Some(entry.path())));
            }
        }
    }
    files.sort_by(|a, b| a.0.cmp(&b.0));
    let mut digest = Sha256::new();
    for (name, path) in files {
        digest.update([u8::from(path.is_some())]);
        digest.update((name.len() as u64).to_le_bytes());
        digest.update(name.as_bytes());
        if let Some(path) = path {
            let bytes = read_bounded(&path, MAX_EXTRACTED_BYTES)?;
            digest.update((bytes.len() as u64).to_le_bytes());
            digest.update(&bytes);
        }
    }
    Ok(format!("{:x}", digest.finalize()))
}

#[cfg(test)]
pub(crate) fn test_prepare_archive(
    registry_path: &Path,
    bytes: &[u8],
) -> Result<PreparedGitHubPackage> {
    let repository = GitHubRepository::parse("https://github.com/dev-owner/dev-repo")?;
    let asset = GitHubAsset {
        id: 2,
        name: "plugin.zip".into(),
        size: bytes.len() as u64,
        content_type: "application/zip".into(),
        download_url: "https://github.com/dev-owner/dev-repo/releases/download/v1.0.0/plugin.zip"
            .into(),
        digest: Some(format!("sha256:{:x}", Sha256::digest(bytes))),
    };
    let release = GitHubRelease {
        id: 1,
        tag: "v1.0.0".into(),
        name: "Fixture".into(),
        url: "https://github.com/dev-owner/dev-repo/releases/tag/v1.0.0".into(),
        prerelease: false,
        published_at: None,
        assets: vec![asset.clone()],
    };
    prepare_bytes(&repository, &release, &asset, bytes, registry_path)
}

#[cfg(test)]
mod tests;
