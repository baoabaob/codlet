"""Build a native Apple Silicon .app and an unsigned, unnotarized preview DMG."""
import argparse
import hashlib
import json
import os
from pathlib import Path
import platform
import plistlib
import re
import shutil
import subprocess
import tempfile
import zipfile

ROOT = Path(__file__).resolve().parent.parent
ALLOWED = ["codex.ui.adapter", "codex.desktop.adapter", "codlet-gui"]


def digest(file):
    with file.open("rb") as stream:
        return hashlib.file_digest(stream, "sha256").hexdigest()


def plain(file):
    for component in (file, *file.parents):
        if component.is_symlink():
            raise ValueError(f"Linked input/output path: {component}")


def copy(source, target):
    plain(source)
    if not source.is_file():
        raise ValueError(f"Missing regular payload: {source}")
    target.parent.mkdir(parents=True, exist_ok=True)
    if target.exists():
        raise ValueError(f"Duplicate payload: {target}")
    shutil.copy2(source, target)


def run(*args):
    subprocess.run([str(arg) for arg in args], check=True)


def build_update_zip(app, destination, version):
    """Package one complete sealed app with explicit file modes for the updater."""
    pin = json.loads((app / "Contents/Resources/runtime/node-runtime.json").read_text())
    node = pin["platforms"]["darwin-arm64"]
    runtime = {
        "version": node.get("version", pin["version"]),
        "executableSha256": node["executableSha256"],
        "licenseSha256": node["licenseSha256"],
    }
    mode = pin.get("mode", "bundled")
    if mode not in ("bundled", "managed"):
        raise ValueError("Unknown macOS Node runtime mode")
    if mode == "managed":
        runtime["mode"] = "managed"
    files = []
    for source in sorted(app.rglob("*")):
        plain(source)
        if not source.is_file():
            continue
        mode = source.stat().st_mode & 0o777
        if mode not in (0o644, 0o755):
            raise ValueError(f"Unsupported signed app file mode: {source} {mode:o}")
        files.append({"path": str(source.relative_to(app.parent)).replace(os.sep, "/"),
                      "bytes": source.stat().st_size, "sha256": digest(source), "mode": mode})
    if len(files) > 4096 or sum(file["bytes"] for file in files) > 1024 * 1024 * 1024:
        raise ValueError("Signed app exceeds updater bounds")
    update = {"schema": 1, "kind": "codlet-runtime-update", "version": version,
              "platform": "darwin-arm64", "profile": "macApp", "runtime": runtime, "files": files}
    with zipfile.ZipFile(destination, "w", compression=zipfile.ZIP_DEFLATED,
                         compresslevel=6, allowZip64=False) as archive:
        def put(name, data, mode):
            info = zipfile.ZipInfo(name)
            info.create_system = 3
            info.external_attr = (0o100000 | mode) << 16
            info.compress_type = zipfile.ZIP_DEFLATED
            archive.writestr(info, data, compress_type=zipfile.ZIP_DEFLATED, compresslevel=6)
        put("runtime-update-manifest.json", (json.dumps(update, separators=(",", ":")) + "\n").encode(), 0o644)
        for file in files:
            put(file["path"], (app.parent / file["path"]).read_bytes(), file["mode"])
    if destination.stat().st_size > 512 * 1024 * 1024:
        raise ValueError("Update ZIP exceeds the download size limit")
    return {"file": destination.name, "bytes": destination.stat().st_size, "sha256": digest(destination)}


def signed_inventory(app):
    return [{"path": str(file.relative_to(app)).replace(os.sep, "/"),
             "bytes": file.stat().st_size, "sha256": digest(file),
             "mode": file.stat().st_mode & 0o777}
            for file in sorted(app.rglob("*")) if file.is_file()]


def stage_legacy_bridge(app, node_directory, destination):
    """Give the already-shipped Preview 5 reader its exact bundled contract."""
    if destination.exists():
        raise ValueError("Legacy bridge destination already exists")
    shutil.copytree(app, destination, symlinks=False)
    runtime_file = destination / "Contents/Resources/runtime/node-runtime.json"
    pin = json.loads(runtime_file.read_text(encoding="utf-8"))
    if pin.pop("mode", None) != "managed":
        raise ValueError("Legacy bridge requires a managed source app")
    channel = json.loads((destination / "Contents/Resources/runtime/update-channel.json").read_text(encoding="utf-8"))
    if channel.get("source", {}).get("manifestAsset") != "codlet-update-managed.json":
        raise ValueError("Legacy bridge must switch to managed updates after installation")
    runtime_file.write_text(json.dumps(pin, indent=2) + "\n", encoding="utf-8")
    node = pin["platforms"]["darwin-arm64"]
    basename = f"node-v{node.get('version', pin['version'])}-darwin-arm64"
    target = destination / "Contents/Resources/runtime" / basename
    for name in ("bin/node", "LICENSE"):
        copy(node_directory / name, target / name)
    (target / "bin/node").chmod(0o755)
    if digest(target / "bin/node") != node["executableSha256"] or digest(target / "LICENSE") != node["licenseSha256"]:
        raise ValueError("Legacy bridge Node copy differs from the fixed pin")
    return destination


def stage_payload(executable, node_directory, plugin_distribution, output, core_commit, plugin_commit):
    """Validate and assemble only declared payloads; also used by portable tests."""
    for value in (executable, node_directory, plugin_distribution, output):
        plain(value)
    if output.exists():
        raise ValueError("Choose a new output directory")
    # A thin ARM64 Mach-O executable, never a renamed PE or Intel binary.
    with executable.open("rb") as stream:
        header = stream.read(12)
    if header[:4] != bytes.fromhex("cffaedfe") or int.from_bytes(header[4:8], "little") != 0x0100000C:
        raise ValueError("Expected an Apple Silicon Mach-O executable")
    for commit in (core_commit, plugin_commit):
        if not re.fullmatch(r"[0-9a-f]{40}", commit):
            raise ValueError("Source provenance must use complete 40-character Git SHAs")
    cargo = (ROOT / "Cargo.toml").read_text()
    version = re.search(r'^version = "([^"]+)"', cargo, re.MULTILINE)[1]
    license_match = re.search(r'^license = "([^"]+)"', cargo, re.MULTILINE)
    license_expression = license_match[1] if license_match else "See bundled license files"
    pin = json.loads((ROOT / "runtime/node-runtime.json").read_text())
    if pin.get("mode") != "managed":
        raise ValueError("The default Mac preview app requires managed Node mode")
    channel = json.loads((ROOT / "runtime/update-channel.json").read_text(encoding="utf-8"))
    if channel.get("source", {}).get("manifestAsset") != "codlet-update-managed.json":
        raise ValueError("Managed Mac preview requires the managed update channel")
    spec = pin["platforms"]["darwin-arm64"]
    for name, checksum in (("bin/node", spec["executableSha256"]), ("LICENSE", spec["licenseSha256"])):
        plain(node_directory / name)
        if digest(node_directory / name) != checksum:
            raise ValueError(f"Node does not match the pinned macOS runtime: {name}")
    catalog = json.loads((plugin_distribution / "catalog.json").read_text(encoding="utf-8"))
    if catalog.get("schema") != 1 or catalog.get("kind") != "codlet-official-plugin-bundle":
        raise ValueError("Invalid official plugin catalog")
    ids = catalog.get("installerPlugins", [pkg["id"] for pkg in catalog["packages"]])
    if len(set(ids)) != len(ids) or set(ids) != set(ALLOWED):
        raise ValueError("macOS setup requires the three declared official installer plugins")
    packages = []
    for identifier in ALLOWED:
        matches = [pkg for pkg in catalog["packages"] if pkg["id"] == identifier]
        if len(matches) != 1:
            raise ValueError("Duplicate or missing installer package")
        pkg = matches[0]
        if not re.fullmatch(r"https://github\.com/[A-Za-z0-9_.-]+/[A-Za-z0-9_.-]+", pkg["repository"]) or pkg["tag"] != "v" + pkg["version"]:
            raise ValueError("Invalid official plugin provenance")
        if any(dep not in ALLOWED for dep in pkg.get("dependencies", [])):
            raise ValueError("Installer plugin has an unavailable dependency")
        if identifier == "codlet-gui" and "codex.ui.adapter" not in pkg.get("dependencies", []):
            raise ValueError("GUI must declare its UI Adapter dependency")
        packages.append(pkg)
    catalog["packages"] = packages
    app = output / "Codlet.app"
    resources = app / "Contents/Resources"
    copy(executable, resources / "codlet")
    (resources / "codlet").chmod(0o755)
    for name in ("node-runtime.json", "client-node-profiles.json", "update-channel.json"):
        copy(ROOT / "runtime" / name, resources / "runtime" / name)
    copy(ROOT / "scripts/macos/initialize.mjs", resources / "initialize.mjs")
    (resources / "optional-plugins").mkdir()
    (resources / "optional-plugins/catalog.json").write_text(json.dumps(catalog, indent=2) + "\n", encoding="utf-8")
    for pkg in packages:
        seen = set()
        for file in pkg["files"]:
            relative = file["path"]
            if not re.fullmatch(r"[a-zA-Z0-9._/-]+", relative) or any(part in ("", ".", "..") for part in relative.split("/")) or relative in seen:
                raise ValueError("Invalid or duplicate package payload path")
            seen.add(relative)
            source = plugin_distribution / "packages" / pkg["id"] / relative
            plain(source)
            if digest(source) != file["sha256"] or source.stat().st_size != file["bytes"]:
                raise ValueError(f"Plugin payload mismatch: {pkg['id']}/{relative}")
            copy(source, resources / "optional-plugins/packages" / pkg["id"] / relative)
        manifest = json.loads((resources / "optional-plugins/packages" / pkg["id"] / "codlet.json").read_text())
        if manifest["id"] != pkg["id"] or manifest["version"] != pkg["version"] or sorted(manifest["permissions"]) != sorted(pkg["permissions"]):
            raise ValueError("Plugin manifest/catalog mismatch")
    license_names = [name for name in ("LICENSE",) if (ROOT / name).is_file()]
    if not license_names or any((ROOT / name).stat().st_size < 200 for name in license_names):
        raise ValueError("A complete repository license text is required")
    for name in [*license_names, "NOTICE"]:
        copy(ROOT / name, resources / "licenses" / name)
    copy(ROOT / "docs/THIRD_PARTY_UI_LICENSES.txt", resources / "licenses/THIRD_PARTY_UI_LICENSES.txt")
    copy(ROOT / "docs/THIRD_PARTY_RUST_LICENSES.txt", resources / "licenses/THIRD_PARTY_RUST_LICENSES.txt")
    for source in (ROOT / "types").glob("*.d.ts"):
        copy(source, resources / "sdk/types" / source.name)
    info = {
        "CFBundleIdentifier": "io.github.baoabaob.codlet.preview",
        "CFBundleName": "Codlet", "CFBundleDisplayName": "Codlet",
        "CFBundleExecutable": "Codlet", "CFBundlePackageType": "APPL",
        "CFBundleShortVersionString": version.split("-")[0],
        "CFBundleVersion": version.split("-")[0], "CodletPreviewVersion": version,
        "CFBundleIconFile": "Codlet", "LSMinimumSystemVersion": "13.0",
        "LSArchitecturePriority": ["arm64"], "LSUIElement": True,
        "NSHighResolutionCapable": True,
        "NSHumanReadableCopyright": f"Codlet contributors — {license_expression}",
    }
    (app / "Contents/Info.plist").write_bytes(plistlib.dumps(info))
    (app / "Contents/MacOS").mkdir()
    return app, version, {
        "schema": 1, "kind": "codlet-macos-preview", "version": version,
        "platform": "darwin-arm64", "sourceCommit": core_commit,
        "pluginsSourceCommit": plugin_commit, "appleDeveloperSigned": False,
        "notarized": False, "signature": "ad-hoc app seal; managed Node verified outside the bundle",
        "license": license_expression, "licenseFiles": [f"Contents/Resources/licenses/{name}" for name in [*license_names, "NOTICE", "THIRD_PARTY_UI_LICENSES.txt", "THIRD_PARTY_RUST_LICENSES.txt"]],
        "officialPlugins": [{key: pkg[key] for key in ("id", "version", "repository", "tag", "sha256")} for pkg in packages],
    }


def build(args):
    if (platform.system(), platform.machine()) != ("Darwin", "arm64"):
        raise ValueError("Build on an Apple Silicon Mac with Xcode Command Line Tools")
    output = Path(os.path.abspath(args.output))
    plain(output)
    if output.exists():
        raise ValueError("Choose a new output directory")
    output.parent.mkdir(parents=True, exist_ok=True)
    with tempfile.TemporaryDirectory(prefix=".macos-package-", dir=output.parent) as temporary:
        temporary = Path(temporary)
        volume = temporary / "volume"
        app, version, manifest = stage_payload(Path(args.executable).absolute(), Path(args.node_directory).absolute(), Path(args.plugin_distribution).absolute(), volume, args.source_commit, args.plugins_commit)
        run("xcrun", "swiftc", "-swift-version", "5", "-O", "-target", "arm64-apple-macos13.0", "-framework", "AppKit", ROOT / "scripts/macos/Launcher.swift", "-o", app / "Contents/MacOS/Codlet")
        icons = temporary / "Codlet.iconset"
        icons.mkdir()
        for points in (16, 32, 128, 256, 512):
            for scale in (1, 2):
                name = f"icon_{points}x{points}{'@2x' if scale == 2 else ''}.png"
                copy(ROOT / f"assets/codlet/png/black/codlet-{points * scale}.png", icons / name)
        run("iconutil", "--convert", "icns", "--output", app / "Contents/Resources/Codlet.icns", icons)
        # Ad-hoc seal is necessary for an arm64 app. Never --deep re-sign the
        # pinned Node runtime: doing so would invalidate its checked-in digest.
        run("codesign", "--force", "--sign", "-", app)
        run("codesign", "--verify", "--strict", app)
        run(app / "Contents/MacOS/Codlet", "--packaging-smoke-test")
        run(app / "Contents/Resources/codlet", "--version")
        fallback_node = Path(args.node_directory).absolute() / "bin/node"
        run(fallback_node, "--version")
        reviewed_client_node = Path(args.reviewed_client_node_directory).absolute() if args.reviewed_client_node_directory else None
        if reviewed_client_node is not None:
            profiles = json.loads((ROOT / "runtime/client-node-profiles.json").read_text(encoding="utf-8"))
            candidates = [entry for entry in profiles["profiles"] if entry["platform"] == "darwin-arm64"]
            if len(candidates) != 1 or digest(reviewed_client_node / "bin/node") != candidates[0]["nodeSha256"] or digest(reviewed_client_node / "LICENSE") != candidates[0]["licenseSha256"]:
                raise ValueError("Native-reviewed client Node copy differs from the fixed profile")
            run("codesign", "--verify", "--strict", reviewed_client_node / "bin/node")
        update_zip = temporary / f"Codlet-{version}-darwin-arm64-update.zip"
        update_asset = build_update_zip(app, update_zip, version)
        bridge_app = stage_legacy_bridge(app, Path(args.node_directory).absolute(), temporary / "legacy-bridge" / "Codlet.app")
        run("codesign", "--force", "--sign", "-", bridge_app)
        run("codesign", "--verify", "--strict", bridge_app)
        bridge_zip = temporary / f"Codlet-{version}-darwin-arm64-legacy-update.zip"
        bridge_asset = build_update_zip(bridge_app, bridge_zip, version)
        update_environment = {**os.environ, "CODLET_MAC_UPDATE_APP": str(app), "CODLET_MAC_UPDATE_ZIP": str(update_zip),
                              "CODLET_MAC_LEGACY_APP": str(bridge_app), "CODLET_MAC_LEGACY_ZIP": str(bridge_zip),
                              "CODLET_HOME": str(temporary / "runtime-acceptance-home")}
        subprocess.run(["cargo", "test", "--locked", "--target", "aarch64-apple-darwin", "--lib", "macos_signed_bundle_update_archive", "--", "--nocapture"],
                       cwd=ROOT, env=update_environment, check=True, timeout=900)
        native = [fallback_node, ROOT / "tests/runtime_update_macos.native.mjs", app, version, bridge_app, Path(args.node_directory).absolute()]
        if reviewed_client_node is not None:
            native.append(reviewed_client_node)
        run(*native)
        os.symlink("/Applications", volume / "Applications")
        (volume / "开始使用.txt").write_text(
            f"Codlet {version} · macOS Apple Silicon Preview\n\n"
            "1. 将 Codlet 拖入 Applications，再从应用程序打开。\n"
            "2. 首次打开可选择官方插件及桌面快捷入口。GUI 自动包含 UI Adapter。\n"
            "3. 如果 Codex 正在运行，Codlet 会先提示你完成任务，并仅请求正常退出。\n\n"
            "本包没有 Apple Developer ID 签名或公证。Gatekeeper 可能阻止首次打开。\n"
            "确认下载来源和 SHA-256 后，可使用 macOS 系统设置中的隐私与安全性页\n"
            "允许这一个应用；不要关闭系统安全保护。工作与视觉验收仍需真实 Mac 客户端。\n\n"
            "配置、插件和日志在 ~/Library/Application Support/Codlet。\n"
            "首次启用主机插件时，若没有可复用的已验证运行时，Codlet 需要联网准备固定 Node；之后会复用缓存。\n"
            "拖走 Codlet.app 不删除这些用户数据。菜单栏可补选官方插件或打开日志。\n"
            "安装到 Applications 后，可在 Codlet GUI 中检查并安装预览版更新。更新会先校验整个应用包，请按提示正常退出，完成后 Codlet 会重新打开。\n",
            encoding="utf-8",
        )
        manifest["files"] = [{"path": str(file.relative_to(app)).replace(os.sep, "/"), "bytes": file.stat().st_size, "sha256": digest(file)} for file in sorted(app.rglob("*")) if file.is_file()]
        output.mkdir()
        dmg = output / f"Codlet-{version}-macos-arm64.dmg"
        run("hdiutil", "create", "-volname", "Codlet Preview", "-srcfolder", volume, "-ov", "-format", "UDZO", dmg)
        run("hdiutil", "verify", dmg)
        mounted = temporary / "mounted"
        mounted.mkdir()
        try:
            run("hdiutil", "attach", "-readonly", "-nobrowse", "-mountpoint", mounted, dmg)
            installed = mounted / "Codlet.app"
            run("codesign", "--verify", "--strict", installed)
            run(installed / "Contents/MacOS/Codlet", "--packaging-smoke-test")
            # Validate the shipped initializer with the real native Core using
            # disposable Codlet data. This does not launch the official client.
            environment = {**os.environ, "CODLET_HOME": str(temporary / "runtime-acceptance-home")}
            subprocess.run([str(installed / "Contents/Resources/codlet"), "__codlet_initialize_plugins", *ALLOWED], env=environment, check=True, timeout=180)
            listing = subprocess.run([str(installed / "Contents/Resources/codlet"), "plugin", "list", "--json"], env=environment, check=True, timeout=30, capture_output=True, text=True, encoding="utf-8")
            if {entry["id"] for entry in json.loads(listing.stdout)["plugins"]} != set(ALLOWED):
                raise ValueError("Mounted package failed real Core plugin initialization")
            manifest["nativePackagingChecks"] = ["arm64-host", "launcher-smoke", "codesign-ad-hoc-integrity", "signed-update-zip-stage", "native-app-update-swap-rollback", "dmg-verify", "mounted-launcher-smoke", "mounted-real-core-plugin-initialization"]
            if reviewed_client_node is not None:
                manifest["nativePackagingChecks"].append("official-client-node-helper")
        finally:
            if os.path.ismount(mounted):
                run("hdiutil", "detach", mounted)
        manifest["dmg"] = {"file": dmg.name, "bytes": dmg.stat().st_size, "sha256": digest(dmg)}
        shutil.copy2(update_zip, output / update_zip.name)
        manifest["updateZip"] = update_asset
        shutil.copy2(bridge_zip, output / bridge_zip.name)
        manifest["legacyUpdateZip"] = {**bridge_asset, "files": signed_inventory(bridge_app)}
        (output / "distribution-manifest.json").write_text(json.dumps(manifest, ensure_ascii=False, indent=2) + "\n", encoding="utf-8")
        (output / "SHA256SUMS.txt").write_text(f"{digest(dmg)}  {dmg.name}\n{update_asset['sha256']}  {update_zip.name}\n{bridge_asset['sha256']}  {bridge_zip.name}\n", encoding="utf-8")
        shutil.copy2(volume / "开始使用.txt", output / "开始使用.txt")
        print(json.dumps({"dmg": str(dmg), "sha256": digest(dmg), "version": version}))


if __name__ == "__main__":
    parser = argparse.ArgumentParser(description=__doc__)
    for option in ("executable", "node-directory", "plugin-distribution", "output", "source-commit", "plugins-commit"):
        parser.add_argument("--" + option, required=True)
    parser.add_argument("--reviewed-client-node-directory")
    build(parser.parse_args())
