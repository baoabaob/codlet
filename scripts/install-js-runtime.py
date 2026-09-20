"""Stage the pinned runtime without executing archive content or install hooks."""
import argparse
import hashlib
import json
import os
from pathlib import Path
import platform
import shutil
import tarfile
import tempfile
import urllib.request
import zipfile


def digest(path):
    with path.open("rb") as stream:
        checksum = hashlib.sha256()
        while chunk := stream.read(1024 * 1024):
            checksum.update(chunk)
        return checksum.hexdigest()


def install(destination, selected, archive_path=None):
    pin = json.loads((Path(__file__).resolve().parent.parent / "runtime/node-runtime.json").read_text(encoding="utf-8"))
    spec = pin["platforms"][selected]
    basename = f"node-v{spec.get('version', pin['version'])}-{selected}"
    executable = "bin/node" if selected == "darwin-arm64" else "node.exe"
    runtime_root = Path(destination).resolve() / "runtime"
    target = runtime_root / basename
    expected = {executable: spec["executableSha256"], "LICENSE": spec["licenseSha256"]}
    if target.exists():
        if target.is_symlink() or not all((target / name).is_file() and not (target / name).is_symlink() and digest(target / name) == checksum for name, checksum in expected.items()):
            raise ValueError(f"The existing runtime differs from its pin; repair {target}")
        return target / executable
    runtime_root.mkdir(parents=True, exist_ok=True)
    with tempfile.TemporaryDirectory(prefix=".node-", dir=runtime_root) as temporary:
        temporary = Path(temporary)
        archive = Path(archive_path).resolve() if archive_path else temporary / spec["archive"]
        if archive_path is None:
            url = spec.get("baseUrl", pin["baseUrl"]) + "/" + spec["archive"]
            if not url.startswith("https://nodejs.org/download/release/"):
                raise ValueError("Runtime downloads must use the official Node release source")
            with urllib.request.urlopen(url, timeout=60) as response, archive.open("xb") as output:
                total = 0
                while chunk := response.read(1024 * 1024):
                    total += len(chunk)
                    if total > 200 * 1024 * 1024:
                        raise ValueError("Runtime archive exceeds its limit")
                    output.write(chunk)
        if digest(archive) != spec["archiveSha256"]:
            raise ValueError("Runtime archive differs from its checked-in SHA-256")
        prepared = temporary / basename
        for name, checksum in expected.items():
            member_name = basename + "/" + name
            if selected == "darwin-arm64":
                with tarfile.open(archive) as package:
                    member = package.getmember(member_name)
                    if not member.isfile() or not 0 < member.size <= 160 * 1024 * 1024:
                        raise ValueError("Expected a bounded regular archive member")
                    with package.extractfile(member) as stream:
                        write_member(stream, prepared / name)
            else:
                with zipfile.ZipFile(archive) as package:
                    member = package.getinfo(member_name)
                    if not 0 < member.file_size <= 160 * 1024 * 1024:
                        raise ValueError("Archive member exceeds its limit")
                    with package.open(member) as stream:
                        write_member(stream, prepared / name)
            if digest(prepared / name) != checksum:
                raise ValueError(f"Runtime {name} differs from its pin")
        if selected == "darwin-arm64":
            (prepared / executable).chmod(0o755)
        # Publish only a fully checked directory. An existing installation is
        # never recursively replaced by this development staging utility.
        prepared.rename(target)
    return target / executable


def write_member(stream, output):
    output.parent.mkdir(parents=True, exist_ok=True)
    with output.open("xb") as destination:
        shutil.copyfileobj(stream, destination, 1024 * 1024)


if __name__ == "__main__":
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument("--destination", required=True)
    parser.add_argument("--platform", choices=["win-x64", "win-arm64", "darwin-arm64"])
    parser.add_argument("--archive")
    arguments = parser.parse_args()
    target = arguments.platform or {("Darwin", "arm64"): "darwin-arm64", ("Windows", "ARM64"): "win-arm64", ("Windows", "AMD64"): "win-x64"}.get((platform.system(), platform.machine()))
    if not target:
        parser.error("Supported targets are Windows x64/ARM64 and macOS ARM64")
    print("JS runtime ready:", install(arguments.destination, target, arguments.archive))
