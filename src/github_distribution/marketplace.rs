//! Bounded public topic discovery. Search results are repository candidates;
//! only package preparation establishes a plugin manifest and trusted receipt.
use serde::{Deserialize, Serialize};
use serde_json::Value;
use sha2::Digest;
use std::collections::BTreeSet;
use std::time::{SystemTime, UNIX_EPOCH};
use url::Url;

use super::{
    ApiRelease, GitHubAsset, GitHubClient, GitHubRelease, GitHubRepository, MAX_ARCHIVE_BYTES,
    PackageMetadata, Result, error, valid_asset_name, valid_sha256, validate_metadata,
};
use crate::plugins::PluginManifest;

const PAGE_SIZE: usize = 10;
const MAX_PAGE: u32 = 10;
const RELEASE_PAGE_SIZE: usize = 100;
const MAX_DECLARATIONS_PER_REPOSITORY: usize = 4;
const MAX_DECLARATION_BYTES: u64 = 16 * 1024;

#[derive(Debug, Clone, Deserialize)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
pub struct MarketQuery {
    #[serde(default)]
    pub query: String,
    #[serde(default = "first_page")]
    pub page: u32,
    #[serde(default)]
    pub refresh: bool,
}
fn first_page() -> u32 {
    1
}
impl MarketQuery {
    pub fn validate(&self) -> Result<()> {
        let parts: Vec<_> = self.query.split_whitespace().collect();
        if self.page == 0
            || self.page > MAX_PAGE
            || self.query.len() > 80
            || self.query.chars().any(char::is_control)
            || parts.len() > 8
            || parts.iter().any(|part| {
                if *part == "#" {
                    return false;
                }
                let token = part.strip_prefix('#').unwrap_or(part);
                token.is_empty()
                    || !token
                        .chars()
                        .all(|c| c.is_alphanumeric() || c == '-' || c == '_' || c == '.')
            })
        {
            return Err(error(
                "invalid_market_query",
                "Use a short name or #tag and a page between 1 and 10.",
            ));
        }
        Ok(())
    }
    pub fn cache_key(&self) -> String {
        format!("{}:{}", self.page, self.query.trim().to_lowercase())
    }
    fn search_term(&self) -> String {
        let mut terms = vec!["topic:codlet-plugin".to_owned()];
        for part in self.query.split_whitespace() {
            if part == "#" {
                continue;
            }
            terms.push(if let Some(tag) = part.strip_prefix('#') {
                format!("topic:{}", tag.to_lowercase())
            } else {
                part.to_owned()
            });
        }
        terms.join(" ")
    }
}

#[derive(Debug, Clone, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct MarketItem {
    pub plugin_id: Option<String>,
    pub repository_id: u64,
    pub owner_id: u64,
    pub repository_url: String,
    pub full_name: String,
    pub owner: String,
    pub name: String,
    pub description: Option<String>,
    pub topics: Vec<String>,
    pub author: String,
    pub latest_release: GitHubRelease,
    pub latest_release_verified: bool,
    pub latest_installable_published_at: Option<String>,
    pub total_downloads: Option<u64>,
    pub declaration_status: &'static str,
    pub declared_package: Option<MarketDeclaredPackage>,
}
#[derive(Debug, Clone, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct MarketDeclaredPackage {
    pub manifest: PluginManifest,
    pub metadata: PackageMetadata,
    pub asset: MarketDeclaredAsset,
    pub release_id: u64,
    pub published_at: Option<String>,
    pub device_compatibility: super::DeviceCompatibility,
    pub basis: &'static str,
}
#[derive(Debug, Clone, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct MarketDeclaredAsset {
    pub id: u64,
    pub name: String,
    pub bytes: u64,
    pub sha256: String,
    pub download_count: Option<u64>,
}
#[derive(Debug, Clone, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct MarketPage {
    pub items: Vec<MarketItem>,
    pub page: u32,
    pub has_more: bool,
    pub fetched_at_unix_ms: u64,
    pub cache_until_unix_ms: u64,
}

#[derive(Deserialize)]
struct SearchResponse {
    total_count: u64,
    items: Vec<SearchRepository>,
    #[serde(default)]
    incomplete_results: bool,
}
#[derive(Deserialize)]
struct SearchRepository {
    id: u64,
    full_name: String,
    html_url: String,
    name: String,
    owner: SearchOwner,
    description: Option<String>,
    #[serde(default)]
    topics: Vec<String>,
    #[serde(default)]
    r#private: bool,
    #[serde(default)]
    archived: bool,
}
#[derive(Deserialize)]
struct SearchOwner {
    id: u64,
    login: String,
}

impl SearchRepository {
    fn checked(self) -> Result<Option<(GitHubRepository, Self)>> {
        if self.r#private || self.archived {
            return Ok(None);
        }
        let repository = GitHubRepository::parse(&self.html_url)?;
        if self.id == 0
            || self.owner.id == 0
            || self.full_name.to_ascii_lowercase()
                != format!("{}/{}", repository.owner, repository.name)
            || !self.name.eq_ignore_ascii_case(&repository.name)
            || !self.owner.login.eq_ignore_ascii_case(&repository.owner)
            || self.description.as_ref().is_some_and(|s| s.len() > 4096)
            || self.topics.len() > 64
            || self.topics.iter().any(|t| t.len() > 100)
            || !self
                .topics
                .iter()
                .any(|t| t.eq_ignore_ascii_case("codlet-plugin"))
        {
            return Err(error(
                "github_response_invalid",
                "GitHub search returned an inconsistent repository.",
            ));
        }
        Ok(Some((repository, self)))
    }
}

fn zip_candidate(asset: &GitHubAsset) -> bool {
    asset.size > 0 && asset.size <= MAX_ARCHIVE_BYTES
}
fn latest(left: &GitHubRelease, right: &GitHubRelease) -> std::cmp::Ordering {
    left.published_at
        .cmp(&right.published_at)
        .then(left.id.cmp(&right.id))
}

struct MarketRelease {
    release: GitHubRelease,
    declaration: DeclarationAsset,
}
enum DeclarationAsset {
    Missing,
    Invalid,
    Fetch {
        id: u64,
        size: u64,
        digest: Option<String>,
    },
}
#[derive(Deserialize)]
#[serde(deny_unknown_fields)]
struct ReleaseDeclaration {
    schema: u32,
    kind: String,
    manifest: Value,
    metadata: Value,
    asset: DeclaredAsset,
}
#[derive(Deserialize)]
#[serde(deny_unknown_fields)]
struct DeclaredAsset {
    name: String,
    bytes: u64,
    sha256: String,
}

fn declaration_asset(raw: &ApiRelease) -> DeclarationAsset {
    let matches: Vec<_> = raw
        .assets
        .iter()
        .filter(|asset| asset.name.eq_ignore_ascii_case("codlet-release.json"))
        .collect();
    match matches.as_slice() {
        [] => DeclarationAsset::Missing,
        [asset]
            if asset.name == "codlet-release.json"
                && asset.state == "uploaded"
                && asset.id > 0
                && (1..=MAX_DECLARATION_BYTES).contains(&asset.size) =>
        {
            DeclarationAsset::Fetch {
                id: asset.id,
                size: asset.size,
                digest: asset.digest.clone(),
            }
        }
        _ => DeclarationAsset::Invalid,
    }
}

fn parse_declaration(bytes: &[u8], release: &GitHubRelease) -> Option<MarketDeclaredPackage> {
    let declaration: ReleaseDeclaration = serde_json::from_slice(bytes).ok()?;
    if declaration.schema != 1
        || declaration.kind != "codlet-plugin-release"
        || !valid_asset_name(&declaration.asset.name)
        || !(1..=MAX_ARCHIVE_BYTES).contains(&declaration.asset.bytes)
        || !valid_sha256(&declaration.asset.sha256)
    {
        return None;
    }
    let matches: Vec<_> = release
        .assets
        .iter()
        .filter(|asset| asset.name == declaration.asset.name)
        .collect();
    let [asset] = matches.as_slice() else {
        return None;
    };
    if asset.size != declaration.asset.bytes
        || asset.digest.as_deref() != Some(format!("sha256:{}", declaration.asset.sha256).as_str())
    {
        return None;
    }
    let manifest = PluginManifest::parse(&declaration.manifest.to_string()).ok()?;
    let metadata: PackageMetadata = serde_json::from_value(declaration.metadata).ok()?;
    validate_metadata(&metadata).ok()?;
    let device_compatibility = super::device_compatibility(Some(&metadata));
    Some(MarketDeclaredPackage {
        manifest,
        metadata,
        asset: MarketDeclaredAsset {
            id: asset.id,
            name: asset.name.clone(),
            bytes: asset.size,
            sha256: declaration.asset.sha256,
            download_count: asset.download_count,
        },
        release_id: release.id,
        published_at: release.published_at.clone(),
        device_compatibility,
        basis: "publisher-release-declaration",
    })
}

impl GitHubClient {
    async fn market_releases(
        &self,
        repository: &GitHubRepository,
    ) -> Result<(Vec<MarketRelease>, bool)> {
        let mut endpoint = repository.endpoint(&["releases"]);
        endpoint.set_query(Some("per_page=100&page=1"));
        let raw: Vec<ApiRelease> = self.json(endpoint).await?;
        if raw.len() > RELEASE_PAGE_SIZE {
            return Err(error(
                "github_response_limit",
                "The release list exceeded its limit.",
            ));
        }
        let mut truncated = raw.len() == RELEASE_PAGE_SIZE;
        let mut ids = BTreeSet::new();
        let mut output = Vec::new();
        let mut asset_fallbacks = 0;
        for mut item in raw {
            if item.draft {
                continue;
            }
            if item.assets.is_empty() {
                if asset_fallbacks < MAX_DECLARATIONS_PER_REPOSITORY {
                    self.hydrate_release_assets(repository, &mut item).await?;
                    asset_fallbacks += 1;
                } else {
                    truncated = true;
                }
            }
            let declaration = declaration_asset(&item);
            let release = item.checked(repository)?;
            if !ids.insert(release.id) {
                return Err(error("github_response_invalid", "Duplicate release ID."));
            }
            output.push(MarketRelease {
                release,
                declaration,
            });
        }
        Ok((output, truncated))
    }
    async fn matched_declaration(
        &self,
        repository: &GitHubRepository,
        release: &MarketRelease,
    ) -> Result<(&'static str, Option<MarketDeclaredPackage>)> {
        let (id, size, digest) = match &release.declaration {
            DeclarationAsset::Missing => return Ok(("missing", None)),
            DeclarationAsset::Invalid => return Ok(("invalid", None)),
            DeclarationAsset::Fetch { id, size, digest } => (*id, *size, digest),
        };
        let bytes = match self
            .get(
                repository.endpoint(&["releases", "assets", &id.to_string()]),
                true,
                MAX_DECLARATION_BYTES,
            )
            .await
        {
            Ok(bytes) => bytes,
            Err(error) if error.code == "github_not_found" => return Ok(("invalid", None)),
            Err(error) => return Err(error),
        };
        if bytes.len() as u64 != size {
            return Ok(("invalid", None));
        }
        if digest
            .as_ref()
            .is_some_and(|digest| digest != &format!("sha256:{:x}", sha2::Sha256::digest(&bytes)))
        {
            return Ok(("invalid", None));
        }
        let declared = parse_declaration(&bytes, &release.release);
        Ok((
            if declared.is_some() {
                "matched"
            } else {
                "invalid"
            },
            declared,
        ))
    }
}

impl GitHubClient {
    pub async fn discover(&self, query: &MarketQuery) -> Result<MarketPage> {
        query.validate()?;
        let mut url =
            Url::parse("https://api.github.com/search/repositories").expect("constant URL");
        url.query_pairs_mut()
            .append_pair("q", &query.search_term())
            .append_pair("per_page", &PAGE_SIZE.to_string())
            .append_pair("page", &query.page.to_string());
        let response: SearchResponse = self.json(url).await?;
        if response.incomplete_results {
            return Err(error(
                "github_search_incomplete",
                "GitHub returned incomplete search results. Try again.",
            ));
        }
        if response.items.len() > PAGE_SIZE {
            return Err(error(
                "github_response_limit",
                "GitHub search page exceeded its limit.",
            ));
        }
        let mut items = Vec::new();
        for raw in response.items {
            let Some((repository, raw)) = raw.checked()? else {
                continue;
            };
            let (releases, truncated) = self.market_releases(&repository).await?;
            let mut candidates: Vec<_> = releases
                .iter()
                .filter(|release| release.release.assets.iter().any(zip_candidate))
                .collect();
            candidates.sort_by(|left, right| latest(&right.release, &left.release));
            let Some(current) = candidates.first() else {
                continue;
            };
            let mut total_downloads = (!truncated
                && candidates.len() <= MAX_DECLARATIONS_PER_REPOSITORY)
                .then_some(0_u64);
            let mut declaration_status = "missing";
            let mut declared_package = None;
            for (index, candidate) in candidates
                .iter()
                .take(MAX_DECLARATIONS_PER_REPOSITORY)
                .enumerate()
            {
                let (status, declared) = self.matched_declaration(&repository, candidate).await?;
                if index == 0 {
                    declaration_status = status;
                    declared_package = declared.clone();
                }
                total_downloads = total_downloads
                    .and_then(|sum| declared.as_ref()?.asset.download_count?.checked_add(sum));
            }
            // A matched publisher declaration selects an exact GitHub ZIP for
            // indexing, but only githubPrepare inspects actual archive contents.
            let mut latest_release = current.release.clone();
            for asset in &mut latest_release.assets {
                asset.download_count = None;
            }
            let latest_installable_published_at = declared_package
                .as_ref()
                .and_then(|package: &MarketDeclaredPackage| package.published_at.clone());
            items.push(MarketItem {
                plugin_id: None,
                repository_id: raw.id,
                owner_id: raw.owner.id,
                repository_url: repository.url,
                full_name: raw.full_name,
                owner: raw.owner.login.clone(),
                name: raw.name,
                description: raw.description,
                topics: raw.topics,
                author: raw.owner.login,
                latest_release,
                latest_release_verified: false,
                latest_installable_published_at,
                total_downloads,
                declaration_status,
                declared_package,
            });
        }
        items.sort_by(|left, right| {
            right
                .latest_release
                .published_at
                .cmp(&left.latest_release.published_at)
                .then_with(|| left.name.to_lowercase().cmp(&right.name.to_lowercase()))
                .then(left.repository_id.cmp(&right.repository_id))
        });
        let now = SystemTime::now()
            .duration_since(UNIX_EPOCH)
            .unwrap_or_default()
            .as_millis()
            .min(u128::from(u64::MAX)) as u64;
        Ok(MarketPage {
            items,
            page: query.page,
            has_more: query.page < MAX_PAGE
                && u64::from(query.page) * (PAGE_SIZE as u64) < response.total_count,
            fetched_at_unix_ms: now,
            cache_until_unix_ms: now.saturating_add(10 * 60 * 1000),
        })
    }
}

#[cfg(test)]
mod tests {
    use super::*;
    #[test]
    fn query_is_bounded_and_tag_search_is_explicit() {
        let mut q = MarketQuery {
            query: "#adapter".into(),
            page: 1,
            refresh: false,
        };
        assert_eq!(q.search_term(), "topic:codlet-plugin topic:adapter");
        assert!(q.validate().is_ok());
        q.query = "#notes foo".into();
        assert_eq!(q.search_term(), "topic:codlet-plugin topic:notes foo");
        assert!(q.validate().is_ok());
        q.query = "#Adapter".into();
        assert_eq!(q.search_term(), "topic:codlet-plugin topic:adapter");
        q.query = "#".into();
        assert_eq!(q.search_term(), "topic:codlet-plugin");
        assert!(q.validate().is_ok());
        for bad in ["#two#words", "topic:other", "a\n"] {
            q.query = bad.into();
            assert!(q.validate().is_err());
        }
        q.query.clear();
        q.page = 11;
        assert!(q.validate().is_err());
    }
    #[test]
    fn unknown_asset_count_cannot_become_zero() {
        let mut count = Some(0_u64);
        for asset_count in [Some(2), None] {
            count = count.and_then(|sum| asset_count.map(|v| sum + v));
        }
        assert_eq!(count, None);
    }
}
