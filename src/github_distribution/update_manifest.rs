use super::{GitHubClient, GitHubRepository, error, network_error};
use crate::plugin_update_manifest::{MAX_FEED_BYTES, PluginUpdateManifest, validate_manifest_url};
use serde::{Deserialize, Serialize};
use sha2::{Digest, Sha256};
use std::io::{Read, Write};
use std::path::{Path, PathBuf};
use std::time::{Duration, SystemTime, UNIX_EPOCH};
use url::Url;
#[cfg(test)]
mod tests;

const CACHE_LIFETIME_MS: u64 = 6 * 60 * 60 * 1000;
const MIN_CHECK_INTERVAL_MS: u64 = 60 * 1000;
const MAX_CACHE_BYTES: u64 = MAX_FEED_BYTES * 6;
pub(crate) const MISSING_MANIFEST: &str = "The publisher has not provided an update manifest. Open the plugin's releases to update manually.";

#[derive(Clone)]
pub(crate) struct CachedManifest {
    pub manifest: PluginUpdateManifest,
    pub checked_at: u64,
    pub next_check_at: u64,
    pub cached: bool,
    pub error: Option<String>,
}
#[derive(Clone, Debug, thiserror::Error)]
#[error("{message}")]
pub(crate) struct ManifestFetchError {
    pub message: String,
    pub next_check_at: Option<u64>,
}
impl From<String> for ManifestFetchError {
    fn from(message: String) -> Self {
        Self {
            message,
            next_check_at: None,
        }
    }
}
impl From<&str> for ManifestFetchError {
    fn from(message: &str) -> Self {
        message.to_string().into()
    }
}

#[derive(Default, Serialize, Deserialize)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
struct Cache {
    schema: u32,
    url: String,
    checked_at: Option<u64>,
    attempted_at: u64,
    next_check_at: u64,
    etag: Option<String>,
    body: Option<String>,
    error: Option<String>,
}

#[derive(Serialize, Deserialize)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
struct Cooldown {
    until: u64,
    message: String,
}

struct Response {
    body: Option<Vec<u8>>,
    etag: Option<String>,
}
struct Failure {
    error: super::GitHubDistributionError,
    retry_at: Option<u64>,
}

fn now_ms() -> u64 {
    SystemTime::now()
        .duration_since(UNIX_EPOCH)
        .unwrap_or_default()
        .as_millis() as u64
}

fn retry_time(headers: &reqwest::header::HeaderMap, status: u16, now: u64) -> Option<u64> {
    let after = headers
        .get(reqwest::header::RETRY_AFTER)
        .and_then(|value| value.to_str().ok())
        .and_then(|value| {
            value
                .parse::<u64>()
                .ok()
                .and_then(|seconds| seconds.checked_mul(1000))
                .and_then(|delay| now.checked_add(delay))
                .or_else(|| {
                    httpdate::parse_http_date(value)
                        .ok()
                        .and_then(|date| date.duration_since(UNIX_EPOCH).ok())
                        .and_then(|duration| u64::try_from(duration.as_millis()).ok())
                })
        });
    let exhausted = headers
        .get("x-ratelimit-remaining")
        .is_some_and(|value| value == "0");
    if status != 429
        && !(status == 403 && (after.is_some() || exhausted) || status == 503 && after.is_some())
    {
        return None;
    }
    let reset = headers
        .get("x-ratelimit-reset")
        .filter(|_| exhausted)
        .and_then(|value| value.to_str().ok())
        .and_then(|value| value.parse::<u64>().ok())
        .and_then(|seconds| seconds.checked_mul(1000));
    let required = match (after, reset) {
        (Some(after), Some(reset)) => Some(after.max(reset)),
        (after, reset) => after.or(reset),
    };
    Some(
        required
            .unwrap_or(now.saturating_add(MIN_CHECK_INTERVAL_MS))
            .max(now.saturating_add(MIN_CHECK_INTERVAL_MS)),
    )
}

fn static_origin(url: &Url) -> bool {
    url.scheme() == "https"
        && url.username().is_empty()
        && url.password().is_none()
        && url.port().is_none()
        && url.fragment().is_none()
        && matches!(
            url.host_str(),
            Some(
                "github.com"
                    | "raw.githubusercontent.com"
                    | "release-assets.githubusercontent.com"
                    | "objects.githubusercontent.com"
            )
        )
}

fn plain(path: &Path, directory: bool) -> std::io::Result<()> {
    let metadata = std::fs::symlink_metadata(path)?;
    #[cfg(windows)]
    {
        use std::os::windows::fs::MetadataExt;
        if metadata.file_attributes() & 0x400 != 0 {
            return Err(std::io::Error::other(
                "Update cache paths must not be links.",
            ));
        }
    }
    if metadata.file_type().is_symlink()
        || if directory {
            !metadata.is_dir()
        } else {
            !metadata.is_file()
        }
    {
        return Err(std::io::Error::other("Invalid update cache file type."));
    }
    Ok(())
}

fn cache_path(registry: &Path, key: &str) -> std::io::Result<PathBuf> {
    let home = registry
        .parent()
        .ok_or_else(|| std::io::Error::other("Registry has no parent."))?
        .canonicalize()?;
    let root = home.join(".plugin-update-cache");
    match std::fs::create_dir(&root) {
        Ok(()) => (),
        Err(error) if error.kind() == std::io::ErrorKind::AlreadyExists => (),
        Err(error) => return Err(error),
    }
    plain(&root, true)?;
    if root.canonicalize()? != root {
        return Err(std::io::Error::other("Update cache directory redirected."));
    }
    Ok(root.join(format!("{:x}.json", Sha256::digest(key.as_bytes()))))
}

fn read_cache<T: serde::de::DeserializeOwned>(path: Option<&Path>) -> Option<T> {
    let path = path?;
    plain(path, false).ok()?;
    let file = std::fs::File::open(path).ok()?;
    if file.metadata().ok()?.len() > MAX_CACHE_BYTES {
        return None;
    }
    let mut bytes = Vec::new();
    file.take(MAX_CACHE_BYTES + 1)
        .read_to_end(&mut bytes)
        .ok()?;
    if bytes.len() as u64 > MAX_CACHE_BYTES {
        return None;
    }
    serde_json::from_slice(&bytes).ok()
}

fn write_cache(path: Option<&Path>, value: &impl Serialize) -> std::io::Result<()> {
    let Some(path) = path else { return Ok(()) };
    let parent = path
        .parent()
        .ok_or_else(|| std::io::Error::other("Cache has no parent."))?;
    plain(parent, true)?;
    if path.exists() {
        plain(path, false)?;
    }
    let bytes = serde_json::to_vec(value).map_err(std::io::Error::other)?;
    if bytes.len() as u64 > MAX_CACHE_BYTES {
        return Err(std::io::Error::other(
            "Update cache exceeds its size limit.",
        ));
    }
    let mut file = tempfile::NamedTempFile::new_in(parent)?;
    file.write_all(&bytes)?;
    file.as_file().sync_all()?;
    file.persist(path).map_err(|error| error.error)?;
    Ok(())
}

fn cached_result(
    cache: &Cache,
    repository: &GitHubRepository,
) -> Result<CachedManifest, ManifestFetchError> {
    let body = cache.body.as_deref().ok_or_else(|| ManifestFetchError {
        message: cache
            .error
            .clone()
            .unwrap_or_else(|| "Plugin update manifest is unavailable.".into()),
        next_check_at: Some(cache.next_check_at),
    })?;
    let manifest = PluginUpdateManifest::parse(body.as_bytes(), repository)?;
    Ok(CachedManifest {
        manifest,
        checked_at: cache.checked_at.unwrap_or(0),
        next_check_at: cache.next_check_at,
        cached: true,
        error: cache.error.clone(),
    })
}

impl GitHubClient {
    /// Persistent public-file cache shared by automatic, manual and install
    /// checks. Force refresh bypasses the six-hour TTL, never server cooldowns
    /// or the one-minute minimum between attempts.
    pub(crate) async fn plugin_update_manifest(
        &self,
        registry: &Path,
        repository: &GitHubRepository,
        manifest_url: &str,
        force: bool,
    ) -> Result<CachedManifest, ManifestFetchError> {
        let url = validate_manifest_url(manifest_url, repository)?;
        let now = now_ms();
        let path = cache_path(registry, manifest_url).ok();
        let mut cache: Cache = read_cache(path.as_deref()).unwrap_or_default();
        if cache.schema != 1
            || cache.url != manifest_url
            || cache.attempted_at > now.saturating_add(MIN_CHECK_INTERVAL_MS)
            || cache
                .checked_at
                .is_some_and(|checked| checked > now.saturating_add(MIN_CHECK_INTERVAL_MS))
            || cache.body.as_ref().is_some_and(|body| {
                PluginUpdateManifest::parse(body.as_bytes(), repository).is_err()
            })
        {
            cache = Cache {
                schema: 1,
                url: manifest_url.into(),
                ..Default::default()
            };
        }
        let cooldown_path = cache_path(
            registry,
            &format!("origin:{}", url.origin().ascii_serialization()),
        )
        .ok();
        if let Some(cooldown) = read_cache::<Cooldown>(cooldown_path.as_deref())
            && cooldown.until > now
        {
            cache.next_check_at = cooldown.until;
            cache.error = Some(cooldown.message);
            return cached_result(&cache, repository);
        }
        if now < cache.next_check_at
            || now.saturating_sub(cache.attempted_at) < MIN_CHECK_INTERVAL_MS
            || !force
                && cache.error.is_none()
                && cache
                    .checked_at
                    .is_some_and(|checked| now.saturating_sub(checked) < CACHE_LIFETIME_MS)
        {
            return cached_result(&cache, repository);
        }
        cache.attempted_at = now;
        let result = tokio::time::timeout(Duration::from_secs(20), async {
            let first = self
                .static_file_response(url.clone(), cache.etag.as_deref(), MAX_FEED_BYTES)
                .await;
            if first.as_ref().err().is_some_and(|failure| {
                matches!(
                    failure.error.code.as_str(),
                    "github_network" | "github_timeout" | "github_tls"
                )
            }) {
                tokio::time::sleep(Duration::from_millis(500)).await;
                self.static_file_response(url, cache.etag.as_deref(), MAX_FEED_BYTES)
                    .await
            } else {
                first
            }
        })
        .await
        .unwrap_or_else(|_| {
            Err(Failure {
                error: error(
                    "github_timeout",
                    "Plugin update manifest download timed out.",
                ),
                retry_at: None,
            })
        });
        let result = result.and_then(|response| {
            let bytes = match &response.body {
                Some(body) => body.as_slice(),
                None => cache
                    .body
                    .as_deref()
                    .map(str::as_bytes)
                    .ok_or_else(|| Failure {
                        error: error(
                            "update_manifest_invalid",
                            "The update source returned 304 without a cached manifest.",
                        ),
                        retry_at: None,
                    })?,
            };
            PluginUpdateManifest::parse(bytes, repository).map_err(|message| Failure {
                error: error("update_manifest_invalid", message),
                retry_at: None,
            })?;
            Ok(response)
        });
        match result {
            Ok(response) => {
                if let Some(body) = response.body {
                    cache.body = Some(
                        String::from_utf8(body)
                            .map_err(|_| "Plugin update manifest is not UTF-8.")?,
                    );
                    cache.etag = response.etag;
                }
                cache.checked_at = Some(now_ms());
                cache.next_check_at = cache.attempted_at.saturating_add(MIN_CHECK_INTERVAL_MS);
                cache.error = None;
                let _ = write_cache(path.as_deref(), &cache);
                let mut result = cached_result(&cache, repository)?;
                result.cached = false;
                Ok(result)
            }
            Err(failure) => {
                cache.next_check_at = failure
                    .retry_at
                    .unwrap_or_else(|| now_ms().saturating_add(MIN_CHECK_INTERVAL_MS));
                cache.error = Some(failure.error.to_string());
                if let Some(until) = failure.retry_at {
                    let _ = write_cache(
                        cooldown_path.as_deref(),
                        &Cooldown {
                            until,
                            message: failure.error.to_string(),
                        },
                    );
                }
                let _ = write_cache(path.as_deref(), &cache);
                cached_result(&cache, repository)
            }
        }
    }

    /// Separate transport so no redirect or fallback can accidentally turn a
    /// static update check or archive download into a REST API request.
    async fn static_file_response(
        &self,
        mut url: Url,
        etag: Option<&str>,
        limit: u64,
    ) -> Result<Response, Failure> {
        let fail = |code: &str, message: &str| Failure {
            error: error(code, message),
            retry_at: None,
        };
        for hop in 0..=5 {
            if !static_origin(&url) {
                return Err(fail(
                    "update_manifest_redirect_rejected",
                    "Plugin updates must use direct public file downloads; API and unrelated redirects are not allowed.",
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
            let mut request = self
                .client
                .get(request_url)
                .header("Accept", "application/octet-stream")
                .header("Accept-Encoding", "identity");
            if let Some(etag) = etag.filter(|value| value.len() <= 512)
                && let Ok(value) = reqwest::header::HeaderValue::from_str(etag)
            {
                request = request.header(reqwest::header::IF_NONE_MATCH, value);
            }
            let mut response = request.send().await.map_err(|error| Failure {
                error: network_error(error),
                retry_at: None,
            })?;
            let status = response.status().as_u16();
            let response_etag = response
                .headers()
                .get(reqwest::header::ETAG)
                .and_then(|value| value.to_str().ok())
                .filter(|value| value.len() <= 512)
                .map(str::to_owned);
            if status == 304 {
                return Ok(Response {
                    body: None,
                    etag: response_etag,
                });
            }
            if response.status().is_redirection() {
                if hop == 5 {
                    return Err(fail(
                        "update_manifest_redirect_limit",
                        "Too many plugin file redirects.",
                    ));
                }
                let location = response
                    .headers()
                    .get(reqwest::header::LOCATION)
                    .and_then(|value| value.to_str().ok())
                    .ok_or_else(|| {
                        fail(
                            "update_manifest_redirect_rejected",
                            "Plugin file redirect has no valid location.",
                        )
                    })?;
                url = url.join(location).map_err(|_| {
                    fail(
                        "update_manifest_redirect_rejected",
                        "Invalid plugin file redirect.",
                    )
                })?;
                continue;
            }
            if status != 200 {
                let retry_at = retry_time(response.headers(), status, now_ms());
                return Err(Failure {
                    error: match status {
                        404 => error("update_manifest_missing", MISSING_MANIFEST),
                        403 if retry_at.is_none() => error(
                            "update_manifest_forbidden",
                            "The plugin file host denied access to this public download.",
                        ),
                        403 | 429 => error(
                            "update_manifest_rate_limited",
                            "The plugin file host is limiting requests. The next check will respect its retry time.",
                        ),
                        _ => error(
                            "update_manifest_http",
                            format!("Plugin file download returned HTTP {status}."),
                        ),
                    },
                    retry_at,
                });
            }
            if response
                .headers()
                .get(reqwest::header::CONTENT_ENCODING)
                .is_some_and(|value| value != "identity")
                || response.content_length().is_some_and(|bytes| bytes > limit)
            {
                return Err(fail(
                    "update_manifest_response_limit",
                    "Plugin file response exceeded its size or encoding limit.",
                ));
            }
            let mut bytes = Vec::new();
            while let Some(chunk) = response.chunk().await.map_err(|error| Failure {
                error: network_error(error),
                retry_at: None,
            })? {
                if chunk.len() as u64 > limit.saturating_sub(bytes.len() as u64) {
                    return Err(fail(
                        "update_manifest_response_limit",
                        "Plugin file response exceeded its byte limit.",
                    ));
                }
                bytes.extend_from_slice(&chunk);
            }
            return Ok(Response {
                body: Some(bytes),
                etag: response_etag,
            });
        }
        unreachable!("bounded redirect loop")
    }

    pub(crate) async fn plugin_update_archive(
        &self,
        url: Url,
        bytes: u64,
    ) -> super::Result<Vec<u8>> {
        tokio::time::timeout(
            Duration::from_secs(90),
            self.static_file_response(url, None, bytes),
        )
        .await
        .map_err(|_| error("github_timeout", "Plugin archive download timed out."))?
        .map_err(|failure| failure.error)?
        .body
        .ok_or_else(|| {
            error(
                "update_archive_invalid",
                "Plugin archive download returned no file.",
            )
        })
    }
}
