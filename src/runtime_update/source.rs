use std::collections::BTreeSet;
use std::io::Write;
use std::path::Path;
use std::time::Duration;

use serde::{Deserialize, Serialize};
use sha2::{Digest, Sha256};
use url::Url;

use super::{
    CURRENT_VERSION, MAX_DOWNLOAD_BYTES, PLATFORM, Result, RuntimePayloadProfile,
    RuntimeUpdateCandidate, RuntimeUpdateChannel, RuntimeUpdateSource, error, io_error, package,
};

const MAX_MANIFEST: u64 = 256 * 1024;
const GITHUB_ORIGINS: [&str; 4] = [
    "https://api.github.com",
    "https://github.com",
    "https://release-assets.githubusercontent.com",
    "https://objects.githubusercontent.com",
];

#[derive(Debug, Clone, Serialize, Deserialize)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
pub(super) struct ChannelManifest {
    pub schema: u32,
    pub kind: String,
    pub channel: String,
    pub version: String,
    pub artifacts: Vec<ChannelArtifact>,
}
#[derive(Debug, Clone, Serialize, Deserialize)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
pub(super) struct ChannelArtifact {
    pub platform: String,
    pub profile: RuntimePayloadProfile,
    pub bytes: u64,
    pub sha256: String,
    pub url: Option<String>,
    pub asset_name: Option<String>,
}
#[derive(Debug, Clone)]
pub(super) struct Candidate {
    pub public: RuntimeUpdateCandidate,
    pub profile: RuntimePayloadProfile,
    pub url: Url,
    pub origins: BTreeSet<String>,
}
pub(super) struct UpdateClient {
    client: reqwest::Client,
    #[cfg(test)]
    pub fixture_origin: Option<Url>,
}
impl UpdateClient {
    pub fn new(channel: &RuntimeUpdateChannel) -> Result<Self> {
        validate_channel_source(channel.source.as_ref())?;
        let client = reqwest::Client::builder()
            .redirect(reqwest::redirect::Policy::none())
            .connect_timeout(Duration::from_secs(15))
            .timeout(Duration::from_secs(600))
            .user_agent("Codlet-runtime-update/1")
            .build()
            .map_err(|e| error("runtime_update_network", e.without_url().to_string()))?;
        Ok(Self {
            client,
            #[cfg(test)]
            fixture_origin: None,
        })
    }
    pub async fn check(
        &self,
        channel: &RuntimeUpdateChannel,
        profile: Option<RuntimePayloadProfile>,
    ) -> Result<Option<Candidate>> {
        let selected_profile = profile.unwrap_or_else(|| {
            if std::env::current_exe()
                .ok()
                .and_then(|p| p.file_name().map(|n| n.to_owned()))
                .is_some_and(|n| n.eq_ignore_ascii_case("codlet-lab.exe"))
            {
                RuntimePayloadProfile::IsolatedClient
            } else {
                RuntimePayloadProfile::Portable
            }
        });
        match channel.source.as_ref().ok_or_else(|| {
            error(
                "runtime_update_unconfigured",
                "This development build has no release source.",
            )
        })? {
            RuntimeUpdateSource::Https {
                manifest_url,
                allowed_asset_origins,
            } => {
                let url = https_url(manifest_url)?;
                let manifest = self
                    .manifest(
                        url.clone(),
                        &BTreeSet::from([url.origin().ascii_serialization()]),
                        None,
                    )
                    .await?;
                let artifact = select_artifact(&manifest, channel, selected_profile)?;
                if !newer(&manifest.version, CURRENT_VERSION)? {
                    return Ok(None);
                }
                let url = https_url(artifact.url.as_deref().ok_or_else(|| {
                    error(
                        "runtime_update_manifest_invalid",
                        "HTTPS releases require a fixed artifact URL.",
                    )
                })?)?;
                let origins: BTreeSet<_> = allowed_asset_origins.iter().cloned().collect();
                check_origin(&url, &origins)?;
                Ok(Some(candidate(
                    manifest.version,
                    artifact,
                    url,
                    origins,
                    None,
                )?))
            }
            RuntimeUpdateSource::Github {
                repository_url,
                manifest_asset,
            } => {
                let repo = crate::github_distribution::GitHubRepository::parse(repository_url)
                    .map_err(|e| error("runtime_update_channel_invalid", e.message))?;
                let api = format!(
                    "https://api.github.com/repos/{}/{}/releases/latest",
                    repo.owner, repo.name
                );
                let origins = BTreeSet::from(["https://api.github.com".into()]);
                let bytes = self
                    .small(https_url(&api)?, &origins, false, MAX_MANIFEST)
                    .await?;
                let release: GitHubRelease = serde_json::from_slice(&bytes)
                    .map_err(|e| error("runtime_update_manifest_invalid", e.to_string()))?;
                if release.id == 0
                    || release.draft
                    || (channel.channel == "stable" && release.prerelease)
                    || release.assets.len() > 128
                {
                    return Err(error(
                        "runtime_update_manifest_invalid",
                        "GitHub did not return a valid public release.",
                    ));
                }
                let link = crate::github_distribution::GitHubLink::parse(&release.html_url)
                    .map_err(|_| {
                        error(
                            "runtime_update_manifest_invalid",
                            "Invalid GitHub release URL.",
                        )
                    })?;
                if link.repository != repo || link.tag.as_deref() != Some(release.tag_name.as_str())
                {
                    return Err(error(
                        "runtime_update_manifest_invalid",
                        "Release repository/tag mismatch.",
                    ));
                }
                let asset = release
                    .assets
                    .iter()
                    .find(|a| a.name == *manifest_asset)
                    .ok_or_else(|| {
                        error(
                            "runtime_update_manifest_missing",
                            "This release has no Codlet update manifest.",
                        )
                    })?;
                check_github_asset(asset)?;
                let origins: BTreeSet<_> = GITHUB_ORIGINS.iter().map(|s| (*s).into()).collect();
                let url = https_url(&format!(
                    "https://api.github.com/repos/{}/{}/releases/assets/{}",
                    repo.owner, repo.name, asset.id
                ))?;
                let manifest = self.manifest(url, &origins, Some(asset)).await?;
                if release
                    .tag_name
                    .strip_prefix('v')
                    .unwrap_or(&release.tag_name)
                    != manifest.version
                {
                    return Err(error(
                        "runtime_update_manifest_invalid",
                        "Release tag and update manifest version differ.",
                    ));
                }
                let artifact = select_artifact(&manifest, channel, selected_profile)?;
                if !newer(&manifest.version, CURRENT_VERSION)? {
                    return Ok(None);
                }
                let named = artifact.asset_name.as_deref().ok_or_else(|| {
                    error(
                        "runtime_update_manifest_invalid",
                        "GitHub updates require an assetName in the same release.",
                    )
                })?;
                let asset = release
                    .assets
                    .iter()
                    .find(|a| a.name == named)
                    .ok_or_else(|| {
                        error(
                            "runtime_update_asset_missing",
                            "The update ZIP is missing from this release.",
                        )
                    })?;
                check_github_asset(asset)?;
                if asset.size != artifact.bytes
                    || asset
                        .digest
                        .as_ref()
                        .is_some_and(|d| d != &format!("sha256:{}", artifact.sha256))
                {
                    return Err(error(
                        "runtime_update_digest_mismatch",
                        "GitHub asset metadata differs from the update manifest.",
                    ));
                }
                let url = https_url(&format!(
                    "https://api.github.com/repos/{}/{}/releases/assets/{}",
                    repo.owner, repo.name, asset.id
                ))?;
                Ok(Some(candidate(
                    manifest.version,
                    artifact,
                    url,
                    origins,
                    Some(release.html_url),
                )?))
            }
        }
    }
    async fn manifest(
        &self,
        url: Url,
        origins: &BTreeSet<String>,
        asset: Option<&GitHubAsset>,
    ) -> Result<ChannelManifest> {
        if asset.is_some_and(|a| a.size > MAX_MANIFEST) {
            return Err(error(
                "runtime_update_manifest_invalid",
                "Release manifest exceeds 256 KiB.",
            ));
        }
        let bytes = self
            .small(url, origins, asset.is_some(), MAX_MANIFEST)
            .await?;
        if let Some(asset) = asset
            && (bytes.len() as u64 != asset.size
                || asset
                    .digest
                    .as_ref()
                    .is_some_and(|d| d != &format!("sha256:{:x}", Sha256::digest(&bytes))))
        {
            return Err(error(
                "runtime_update_digest_mismatch",
                "Release manifest differs from GitHub's size or digest.",
            ));
        }
        serde_json::from_slice(&bytes)
            .map_err(|e| error("runtime_update_manifest_invalid", e.to_string()))
    }
    async fn small(
        &self,
        url: Url,
        origins: &BTreeSet<String>,
        binary: bool,
        limit: u64,
    ) -> Result<Vec<u8>> {
        tokio::time::timeout(Duration::from_secs(30), async {
            let mut response = self.response(url, origins, binary, limit).await?;
            let mut bytes = Vec::new();
            while let Some(chunk) = response.chunk().await.map_err(network_error)? {
                if chunk.len() as u64 > limit.saturating_sub(bytes.len() as u64) {
                    return Err(error(
                        "runtime_update_size_limit",
                        "Update response exceeded its byte limit.",
                    ));
                }
                bytes.extend_from_slice(&chunk);
            }
            Ok(bytes)
        })
        .await
        .map_err(|_| {
            error(
                "runtime_update_timeout",
                "Update check exceeded its 30-second deadline.",
            )
        })?
    }
    pub async fn download(
        &self,
        selected: &Candidate,
        state_root: &Path,
        mut progress: impl FnMut(u64),
    ) -> Result<package::StagedRuntime> {
        tokio::time::timeout(
            Duration::from_secs(600),
            self.download_inner(selected, state_root, &mut progress),
        )
        .await
        .map_err(|_| {
            error(
                "runtime_update_timeout",
                "Runtime download exceeded its ten-minute deadline.",
            )
        })?
    }
    async fn download_inner(
        &self,
        selected: &Candidate,
        state_root: &Path,
        mut progress: impl FnMut(u64),
    ) -> Result<package::StagedRuntime> {
        let root = package::ensure_state_root(state_root)?;
        let mut temporary = tempfile::NamedTempFile::new_in(&root).map_err(io_error)?;
        let mut response = self
            .response(
                selected.url.clone(),
                &selected.origins,
                true,
                selected.public.size,
            )
            .await?;
        let mut count = 0u64;
        let mut digest = Sha256::new();
        while let Some(chunk) = response.chunk().await.map_err(network_error)? {
            count = count
                .checked_add(chunk.len() as u64)
                .ok_or_else(|| error("runtime_update_size_limit", "Download size overflow."))?;
            if count > selected.public.size || count > MAX_DOWNLOAD_BYTES {
                return Err(error(
                    "runtime_update_size_limit",
                    "Runtime ZIP exceeded its expected size.",
                ));
            }
            temporary.write_all(&chunk).map_err(io_error)?;
            digest.update(&chunk);
            progress(count);
        }
        if count != selected.public.size
            || format!("{:x}", digest.finalize()) != selected.public.sha256
        {
            return Err(error(
                "runtime_update_digest_mismatch",
                "Runtime ZIP size or SHA-256 differs from the selected release.",
            ));
        }
        temporary.as_file().sync_all().map_err(io_error)?;
        package::stage_archive(temporary.path(), selected, &root)
    }
    async fn response(
        &self,
        mut url: Url,
        origins: &BTreeSet<String>,
        binary: bool,
        limit: u64,
    ) -> Result<reqwest::Response> {
        for hop in 0..=5 {
            check_origin(&url, origins)?;
            #[allow(unused_mut)]
            let mut request_url = url.clone();
            #[cfg(test)]
            if let Some(origin) = &self.fixture_origin {
                request_url.set_scheme(origin.scheme()).unwrap();
                request_url.set_host(origin.host_str()).unwrap();
                request_url.set_port(origin.port()).unwrap();
            }
            let response = self
                .client
                .get(request_url)
                .header(
                    "Accept",
                    if binary {
                        "application/octet-stream"
                    } else {
                        "application/vnd.github+json"
                    },
                )
                .header("X-GitHub-Api-Version", "2026-03-10")
                .header("Accept-Encoding", "identity")
                .send()
                .await
                .map_err(network_error)?;
            if response.status().is_redirection() {
                if hop == 5 {
                    return Err(error(
                        "runtime_update_redirect_limit",
                        "Too many update redirects.",
                    ));
                }
                let location = response
                    .headers()
                    .get(reqwest::header::LOCATION)
                    .and_then(|h| h.to_str().ok())
                    .ok_or_else(|| {
                        error(
                            "runtime_update_redirect_rejected",
                            "Update redirect has no valid Location.",
                        )
                    })?;
                url = url.join(location).map_err(|_| {
                    error(
                        "runtime_update_redirect_rejected",
                        "Invalid update redirect.",
                    )
                })?;
                continue;
            }
            if response.status().as_u16() != 200 {
                return Err(match response.status().as_u16() {
                    403 | 429 => error(
                        "runtime_update_rate_limited",
                        "The release server denied or rate-limited the check. It will be retried with backoff.",
                    ),
                    404 => error(
                        "runtime_update_not_published",
                        "No public update release is available at the configured source.",
                    ),
                    status => error(
                        "runtime_update_http",
                        format!("Release server returned HTTP {status}."),
                    ),
                });
            }
            if response
                .headers()
                .get(reqwest::header::CONTENT_ENCODING)
                .is_some_and(|h| h != "identity")
                || response.content_length().is_some_and(|n| n > limit)
            {
                return Err(error(
                    "runtime_update_size_limit",
                    "Unexpected encoding or oversized update response.",
                ));
            }
            return Ok(response);
        }
        unreachable!()
    }
}
fn network_error(e: reqwest::Error) -> super::RuntimeUpdateError {
    error("runtime_update_network", e.without_url().to_string())
}
fn validate_channel_source(source: Option<&RuntimeUpdateSource>) -> Result<()> {
    match source {
        None => (),
        Some(RuntimeUpdateSource::Github {
            repository_url,
            manifest_asset,
        }) => {
            crate::github_distribution::GitHubRepository::parse(repository_url)
                .map_err(|e| error("runtime_update_channel_invalid", e.message))?;
            if manifest_asset.len() > 128
                || !manifest_asset.ends_with(".json")
                || !manifest_asset
                    .bytes()
                    .all(|b| b.is_ascii_alphanumeric() || b"._-".contains(&b))
            {
                return Err(error(
                    "runtime_update_channel_invalid",
                    "Invalid release-manifest asset name.",
                ));
            }
        }
        Some(RuntimeUpdateSource::Https {
            manifest_url,
            allowed_asset_origins,
        }) => {
            https_url(manifest_url)?;
            if allowed_asset_origins.is_empty() || allowed_asset_origins.len() > 8 {
                return Err(error(
                    "runtime_update_channel_invalid",
                    "Pin between one and eight HTTPS asset origins.",
                ));
            }
            for origin in allowed_asset_origins {
                let url = https_url(origin)?;
                if url.origin().ascii_serialization() != *origin {
                    return Err(error(
                        "runtime_update_channel_invalid",
                        "Asset origins must be normalized HTTPS origins without paths.",
                    ));
                }
            }
        }
    }
    Ok(())
}
fn https_url(value: &str) -> Result<Url> {
    if value.len() > 4096 || value.chars().any(char::is_control) || value.contains('\\') {
        return Err(error("runtime_update_url_invalid", "Invalid update URL."));
    }
    let url = Url::parse(value)
        .map_err(|_| error("runtime_update_url_invalid", "Invalid update URL."))?;
    if url.scheme() != "https"
        || url.host_str().is_none()
        || !url.username().is_empty()
        || url.password().is_some()
        || url.fragment().is_some()
    {
        return Err(error(
            "runtime_update_url_invalid",
            "Update URLs must use HTTPS without credentials or fragments.",
        ));
    }
    Ok(url)
}
fn check_origin(url: &Url, origins: &BTreeSet<String>) -> Result<()> {
    https_url(url.as_str())?;
    if !origins.contains(&url.origin().ascii_serialization()) {
        return Err(error(
            "runtime_update_redirect_rejected",
            "Update origin is not pinned by this installation.",
        ));
    }
    Ok(())
}
fn select_artifact(
    manifest: &ChannelManifest,
    channel: &RuntimeUpdateChannel,
    profile: RuntimePayloadProfile,
) -> Result<ChannelArtifact> {
    if manifest.schema != 1
        || manifest.kind != "codlet-runtime-channel"
        || manifest.channel != channel.channel
        || manifest.artifacts.len() > 8
    {
        return Err(error(
            "runtime_update_manifest_invalid",
            "Update channel manifest does not match this installation.",
        ));
    }
    parse_version(&manifest.version)?;
    if channel.channel == "stable" && manifest.version.split('+').next().unwrap().contains('-') {
        return Err(error(
            "runtime_update_manifest_invalid",
            "A stable channel cannot offer a prerelease.",
        ));
    }
    let mut matched = manifest
        .artifacts
        .iter()
        .filter(|a| a.platform == PLATFORM && a.profile == profile);
    let artifact = matched.next().ok_or_else(|| {
        error(
            "runtime_update_platform_unavailable",
            "This release has no package for this runtime profile/platform.",
        )
    })?;
    if matched.next().is_some()
        || artifact.bytes == 0
        || artifact.bytes > MAX_DOWNLOAD_BYTES
        || !package::valid_sha(&artifact.sha256)
    {
        return Err(error(
            "runtime_update_manifest_invalid",
            "Ambiguous or invalid runtime asset size/digest.",
        ));
    }
    Ok(artifact.clone())
}
fn candidate(
    version: String,
    artifact: ChannelArtifact,
    url: Url,
    origins: BTreeSet<String>,
    release_url: Option<String>,
) -> Result<Candidate> {
    let id = format!(
        "{:x}",
        Sha256::digest(
            serde_json::to_vec(&(&version, &artifact, url.as_str()))
                .expect("candidate serializable")
        )
    );
    Ok(Candidate {
        public: RuntimeUpdateCandidate {
            id,
            version,
            platform: artifact.platform,
            size: artifact.bytes,
            sha256: artifact.sha256,
            release_url,
        },
        profile: artifact.profile,
        url,
        origins,
    })
}
#[derive(Deserialize)]
struct GitHubRelease {
    id: u64,
    tag_name: String,
    html_url: String,
    draft: bool,
    prerelease: bool,
    assets: Vec<GitHubAsset>,
}
#[derive(Deserialize)]
struct GitHubAsset {
    id: u64,
    name: String,
    size: u64,
    state: String,
    digest: Option<String>,
}
fn check_github_asset(asset: &GitHubAsset) -> Result<()> {
    if asset.id == 0
        || asset.state != "uploaded"
        || asset.size == 0
        || asset
            .digest
            .as_ref()
            .is_some_and(|d| !d.strip_prefix("sha256:").is_some_and(package::valid_sha))
    {
        return Err(error(
            "runtime_update_manifest_invalid",
            "Invalid GitHub release asset metadata.",
        ));
    }
    Ok(())
}

#[derive(PartialEq, Eq)]
struct Version {
    numbers: [u64; 3],
    pre: Option<Vec<String>>,
}
fn parse_version(value: &str) -> Result<Version> {
    let invalid = || {
        error(
            "runtime_update_version_invalid",
            "Release version must be a valid semantic version.",
        )
    };
    if value.len() > 96 || !value.is_ascii() {
        return Err(invalid());
    }
    let (precedence, build) = value
        .split_once('+')
        .map_or((value, None), |(a, b)| (a, Some(b)));
    let (core, pre) = precedence
        .split_once('-')
        .map_or((precedence, None), |(a, b)| (a, Some(b)));
    for text in [pre, build].into_iter().flatten() {
        if text
            .split('.')
            .any(|s| s.is_empty() || !s.bytes().all(|b| b.is_ascii_alphanumeric() || b == b'-'))
        {
            return Err(invalid());
        }
    }
    let parts: Vec<_> = core.split('.').collect();
    if parts.len() != 3 {
        return Err(invalid());
    }
    let mut numbers = [0u64; 3];
    for (i, part) in parts.iter().enumerate() {
        if part.is_empty()
            || (part.len() > 1 && part.starts_with('0'))
            || !part.bytes().all(|b| b.is_ascii_digit())
        {
            return Err(invalid());
        }
        numbers[i] = part.parse().map_err(|_| invalid())?;
    }
    let pre = pre.map(|p| p.split('.').map(String::from).collect::<Vec<_>>());
    if pre.as_ref().is_some_and(|p| {
        p.iter()
            .any(|s| s.len() > 1 && s.starts_with('0') && s.bytes().all(|b| b.is_ascii_digit()))
    }) {
        return Err(invalid());
    }
    Ok(Version { numbers, pre })
}
pub(super) fn newer(candidate: &str, current: &str) -> Result<bool> {
    use std::cmp::Ordering;
    let (a, b) = (parse_version(candidate)?, parse_version(current)?);
    match a.numbers.cmp(&b.numbers) {
        Ordering::Greater => return Ok(true),
        Ordering::Less => return Ok(false),
        Ordering::Equal => (),
    }
    match (a.pre, b.pre) {
        (None, Some(_)) => Ok(true),
        (Some(_), None) | (None, None) => Ok(false),
        (Some(a), Some(b)) => {
            for (left, right) in a.iter().zip(&b) {
                let numeric_left = left.bytes().all(|c| c.is_ascii_digit());
                let numeric_right = right.bytes().all(|c| c.is_ascii_digit());
                let comparison = match (numeric_left, numeric_right) {
                    (true, true) => left.len().cmp(&right.len()).then_with(|| left.cmp(right)),
                    (true, false) => Ordering::Less,
                    (false, true) => Ordering::Greater,
                    (false, false) => left.cmp(right),
                };
                if comparison != Ordering::Equal {
                    return Ok(comparison == Ordering::Greater);
                }
            }
            Ok(a.len() > b.len())
        }
    }
}
