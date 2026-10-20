"""Native, account-free acceptance of one reviewed official Mac CUA Node build."""

import argparse
import hashlib
import json
import os
from pathlib import Path
import plistlib
import platform
import shutil
import subprocess
import tempfile


ROOT = Path(__file__).resolve().parent.parent


def digest(file):
    with file.open("rb") as stream:
        return hashlib.file_digest(stream, "sha256").hexdigest()


def run(*arguments, cwd=ROOT, env=None, timeout=180):
    result = subprocess.run([str(value) for value in arguments], cwd=cwd, env=env,
                            capture_output=True, text=True, timeout=timeout)
    if result.returncode:
        raise RuntimeError(f"Native fixture failed ({result.returncode}): {arguments[0]}\n{result.stdout}\n{result.stderr}")
    return result


def main(archive, export_runtime):
    if (platform.system(), platform.machine()) != ("Darwin", "arm64"):
        raise ValueError("This acceptance must execute on native Apple Silicon")
    archive = archive.resolve(strict=True)
    profile = json.loads((ROOT / "tests/fixtures/native-macos.json").read_text())
    if digest(archive) != profile["archiveSha256"]:
        raise ValueError("Official Mac fixture ZIP differs from the reviewed build")
    source = profile["source"]
    with tempfile.TemporaryDirectory(prefix="codlet-reviewed-client-node-") as temporary:
        temporary = Path(temporary)
        run("/usr/bin/ditto", "-x", "-k", archive, temporary)
        app = temporary / "ChatGPT.app"
        info = plistlib.loads((app / "Contents/Info.plist").read_bytes())
        if info["CFBundleIdentifier"] != source["bundleId"] or info["CFBundleShortVersionString"] != source["appVersion"] or info["CFBundleVersion"] != source["build"]:
            raise ValueError("Extracted official app identity does not match its reviewed profile")
        node = app / source["nodePath"]
        license_file = app / source["licensePath"]
        if not node.is_file() or not license_file.is_file() or node.is_symlink() or license_file.is_symlink():
            raise ValueError("Reviewed CUA Node and license must be ordinary files")
        if digest(node) != profile["nodeSha256"] or digest(license_file) != profile["licenseSha256"]:
            raise ValueError("Official client Node files differ from the reviewed hashes")
        for target in (app, node):
            run("/usr/bin/codesign", "--verify", "--strict", "--test-requirement",
                '=anchor apple generic and certificate leaf[subject.OU] = "2DC432GLL2"', target)
        signature = run("/usr/bin/codesign", "-dv", "--verbose=4", node)
        if f"TeamIdentifier={source['teamId']}" not in signature.stderr:
            raise ValueError("CUA Node does not have the reviewed OpenAI signing team")
        if run(node, "--version").stdout.strip() != "v" + profile["nodeVersion"]:
            raise ValueError("CUA Node did not report its reviewed runtime version")
        clean = {key: value for key, value in os.environ.items()
                 if not key.upper().startswith(("NODE_", "OPENSSL_", "DYLD_")) and key.upper() != "ELECTRON_RUN_AS_NODE"}
        print(run(node, ROOT / "tests/mac_client_node.native.mjs", ROOT, env=clean).stdout.strip())
        run("node", ROOT / "scripts/check-dev-storage.mjs", env=clean)
        print(run("cargo", "build", "--locked", "--features", "test-fixtures", "--bin", "codlet-traffic-fixture", env=clean).stdout.strip())
        print(run(node, "--test", ROOT / "tests/host_bootstrap.test.mjs",
                  ROOT / "tests/host_capability_bootstrap.test.mjs",
                  ROOT / "tests/host_traffic.test.mjs", env=clean).stdout.strip())
        clean["CODLET_CORE_ROOT"] = str(ROOT)
        print(run(node, "--test", ROOT / "codex/tests/desktop_host_abi.test.mjs",
                  ROOT / "codex/tests/desktop_launch_bundle.test.mjs", env=clean).stdout.strip())
        native = {**clean, "CODLET_TEST_REVIEWED_MAC_APP": str(app),
                  "CODLET_HOME": str(temporary / "resolver-acceptance-home"), "CARGO_INCREMENTAL": "0"}
        run("node", ROOT / "scripts/check-dev-storage.mjs", env=clean)
        print(run("cargo", "test", "--locked", "--target", "aarch64-apple-darwin", "--lib",
                  "verified_mac_client_node_bundle", "--", "--ignored", "--nocapture",
                  env=native, timeout=900).stdout.strip())
        if export_runtime is not None:
            if export_runtime.exists():
                raise ValueError("Reviewed CUA Node export directory already exists")
            export_runtime.mkdir(parents=True)
            exported_node = export_runtime / "bin/node"
            exported_node.parent.mkdir()
            exported_license = export_runtime / "LICENSE"
            shutil.copy2(node, exported_node)
            shutil.copy2(license_file, exported_license)
            if digest(exported_node) != profile["nodeSha256"] or digest(exported_license) != profile["licenseSha256"]:
                raise ValueError("Reviewed CUA Node copy changed")
            run("/usr/bin/codesign", "--verify", "--strict", exported_node)
        print("Reviewed official Mac CUA Node: codesign, exact Host flags, modules, traffic, and launch ABI passed.")


if __name__ == "__main__":
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument("--archive", type=Path, required=True)
    parser.add_argument("--export-runtime", type=Path)
    args = parser.parse_args()
    main(args.archive, args.export_runtime)
