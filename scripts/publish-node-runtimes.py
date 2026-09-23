#!/usr/bin/env python3
"""Mirror exactly pinned, unmodified Node.js archives to Codlet's dependency release."""

import argparse
import hashlib
import json
import os
from pathlib import Path
import re
import sys
import tempfile
import time
from urllib.error import HTTPError
from urllib.parse import quote
from urllib.request import HTTPRedirectHandler, Request, build_opener


REPOSITORY = "baoabaob/codlet"
TAG = "node-runtimes"
TITLE = "Automated Node.js runtime dependencies (not Codlet installers)"
PLATFORMS = {"win-x64": ".zip", "win-arm64": ".zip", "darwin-arm64": ".tar.gz"}
MAX_ARCHIVE_BYTES = 150 * 1024 * 1024
HEX_SHA256 = re.compile(r"[0-9a-f]{64}\Z")
VERSION = re.compile(r"[0-9]+\.[0-9]+\.[0-9]+\Z")


class NoRedirect(HTTPRedirectHandler):
    def redirect_request(self, request, fp, code, message, headers, new_url):
        raise ValueError(f"Unexpected redirect from the fixed publication URL: {request.full_url}")


def pinned_archives(pin_path):
    pin = json.loads(Path(pin_path).read_text(encoding="utf-8"))
    if pin.get("schema") != 1 or set(pin.get("platforms", {})) != set(PLATFORMS):
        raise ValueError("Unexpected Node runtime pin schema or platform set")
    result = []
    for platform, suffix in PLATFORMS.items():
        spec = pin["platforms"][platform]
        version = spec.get("version", pin.get("version"))
        archive = spec.get("archive")
        expected_name = f"node-v{version}-{platform}{suffix}"
        base = spec.get("baseUrl", pin.get("baseUrl"))
        if not isinstance(version, str) or not VERSION.fullmatch(version):
            raise ValueError(f"Invalid Node version for {platform}")
        if archive != expected_name or base != f"https://nodejs.org/download/release/v{version}":
            raise ValueError(f"Node archive URL is outside the official pinned release: {platform}")
        digest = spec.get("archiveSha256")
        if not isinstance(digest, str) or not HEX_SHA256.fullmatch(digest):
            raise ValueError(f"Missing SHA-256 for {platform}")
        result.append({"platform": platform, "name": archive, "sha256": digest, "url": f"{base}/{archive}"})
    if len({item["name"] for item in result}) != len(result):
        raise ValueError("Duplicate Node archive asset name")
    return result


def download_official(spec, directory):
    path = directory / spec["name"]
    request = Request(spec["url"], headers={"User-Agent": "Codlet-pinned-Node-runtime-mirror", "Accept-Encoding": "identity"})
    digest = hashlib.sha256()
    size = 0
    with build_opener(NoRedirect()).open(request, timeout=90) as response, path.open("wb") as target:
        if response.geturl() != spec["url"]:
            raise ValueError(f"Unexpected official download URL for {spec['name']}")
        while chunk := response.read(1024 * 1024):
            size += len(chunk)
            if size > MAX_ARCHIVE_BYTES:
                raise ValueError(f"Node archive exceeds size limit: {spec['name']}")
            digest.update(chunk)
            target.write(chunk)
        length = response.headers.get("Content-Length")
        if length is not None and int(length) != size:
            raise ValueError(f"Incomplete official archive: {spec['name']}")
    if size == 0 or digest.hexdigest() != spec["sha256"]:
        raise ValueError(f"Official archive SHA-256 mismatch: {spec['name']}")
    return path, size


def github_request(method, path, token, payload=None, missing=False, upload=None):
    host = "uploads.github.com" if upload is not None else "api.github.com"
    url = f"https://{host}{path}"
    data = upload if upload is not None else (json.dumps(payload).encode("utf-8") if payload is not None else None)
    headers = {
        "Accept": "application/vnd.github+json",
        "Authorization": f"Bearer {token}",
        "User-Agent": "Codlet-Node-runtime-publisher",
        "X-GitHub-Api-Version": "2022-11-28",
    }
    if data is not None:
        headers["Content-Type"] = "application/octet-stream" if upload is not None else "application/json"
    request = Request(url, data=data, headers=headers, method=method)
    try:
        with build_opener(NoRedirect()).open(request, timeout=120) as response:
            body = response.read()
            return json.loads(body) if body else None
    except HTTPError as error:
        if missing and error.code == 404:
            return None
        raise RuntimeError(f"GitHub {method} {path} failed with HTTP {error.code}") from error


def release_notes(specs):
    header = (
        "These are automatically managed, SHA-256 verified Node.js project archives used by Codlet. "
        "They are Node.js dependencies, not Codlet installers. The original archives contain the Node.js LICENSE.\n\n"
    )
    lines = [f"- `{spec['name']}` — [original Node.js download]({spec['url']}), SHA-256 `{spec['sha256']}`" for spec in specs]
    return header + "\n".join(lines) + "\n"


def release_assets(release_id, token):
    assets = []
    for page in range(1, 11):
        batch = github_request("GET", f"/repos/{REPOSITORY}/releases/{release_id}/assets?per_page=100&page={page}", token)
        assets.extend(batch)
        if len(batch) < 100:
            return assets
    raise ValueError("Dependency release contains too many assets")


def assert_asset(asset, spec, size):
    if (asset.get("name") != spec["name"] or asset.get("state") != "uploaded"
            or asset.get("size") != size or asset.get("digest") != "sha256:" + spec["sha256"]):
        raise ValueError(f"Existing release asset differs from the checked official archive: {spec['name']}")


def publish(specs, downloaded, token, commit):
    release_path = f"/repos/{REPOSITORY}/releases/tags/{TAG}"
    release = github_request("GET", release_path, token, missing=True)
    if release is None:
        tag_ref = github_request("GET", f"/repos/{REPOSITORY}/git/ref/tags/{TAG}", token, missing=True)
        if tag_ref is not None and (tag_ref.get("object", {}).get("type") != "commit" or tag_ref["object"]["sha"] != commit):
            raise ValueError("The existing node-runtimes tag does not point to this tool commit")
        release = github_request("POST", f"/repos/{REPOSITORY}/releases", token, {
            "tag_name": TAG, "target_commitish": commit, "name": TITLE, "body": release_notes(specs),
            "draft": False, "prerelease": True, "make_latest": "false", "generate_release_notes": False,
        })
        print(f"Created dependency release {release['html_url']}")
    if release.get("tag_name") != TAG or release.get("name") != TITLE or release.get("draft") or not release.get("prerelease"):
        raise ValueError("The existing dependency release has unexpected metadata")
    assets = release_assets(release["id"], token)
    for spec in specs:
        path, size = downloaded[spec["name"]]
        matching = [asset for asset in assets if asset.get("name") == spec["name"]]
        if len(matching) > 1:
            raise ValueError(f"Duplicate dependency release asset: {spec['name']}")
        if matching:
            assert_asset(matching[0], spec, size)
            asset = matching[0]
            action = "verified existing"
        else:
            upload_path = f"/repos/{REPOSITORY}/releases/{release['id']}/assets?name={quote(spec['name'])}"
            asset = github_request("POST", upload_path, token, upload=path.read_bytes())
            for attempt in range(6):
                try:
                    assert_asset(asset, spec, size)
                    break
                except ValueError:
                    if attempt == 5:
                        raise
                    time.sleep(3)
                    asset = github_request("GET", f"/repos/{REPOSITORY}/releases/assets/{asset['id']}", token)
            action = "uploaded"
            assets.append(asset)
        print(json.dumps({"platform": spec["platform"], "action": action, "url": asset["browser_download_url"],
                          "bytes": size, "sha256": spec["sha256"]}, sort_keys=True))
    existing_body = release.get("body") or ""
    additions = [spec for spec in specs if spec["url"] not in existing_body]
    if additions:
        body = existing_body.rstrip() + "\n\n" + "\n".join(release_notes(additions).split("\n\n", 1)[1].splitlines()) + "\n"
        github_request("PATCH", f"/repos/{REPOSITORY}/releases/{release['id']}", token, {"body": body})


def main():
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument("--pin", type=Path, default=Path(__file__).resolve().parent.parent / "runtime/node-runtime.json")
    parser.add_argument("--validate-only", action="store_true")
    args = parser.parse_args()
    specs = pinned_archives(args.pin)
    if args.validate_only:
        for spec in specs:
            print(json.dumps(spec, sort_keys=True))
        return
    token = os.environ.get("GITHUB_TOKEN")
    commit = os.environ.get("GITHUB_SHA", "")
    if os.environ.get("GITHUB_REPOSITORY") != REPOSITORY or not token or not re.fullmatch(r"[0-9a-f]{40}", commit):
        raise ValueError("Run this publisher only in the baoabaob/codlet GitHub workflow")
    with tempfile.TemporaryDirectory(prefix="codlet-node-runtimes-") as temporary:
        directory = Path(temporary)
        downloaded = {}
        for spec in specs:
            path, size = download_official(spec, directory)
            downloaded[spec["name"]] = path, size
            print(f"Verified original Node.js archive {spec['name']}: {size} bytes, SHA-256 {spec['sha256']}")
        publish(specs, downloaded, token, commit)


if __name__ == "__main__":
    try:
        main()
    except (ValueError, RuntimeError, HTTPError) as error:
        print(f"Node runtime publication stopped: {error}", file=sys.stderr)
        sys.exit(1)
