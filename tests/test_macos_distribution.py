"""Offline packaging boundary checks; no Mac binaries are executed here."""
import hashlib
import importlib.util
import json
from pathlib import Path
import plistlib
import tempfile
import unittest

ROOT = Path(__file__).resolve().parent.parent
spec = importlib.util.spec_from_file_location("macos_distribution", ROOT / "scripts/build-preview-macos.py")
builder = importlib.util.module_from_spec(spec)
spec.loader.exec_module(builder)


class PackagingTests(unittest.TestCase):
    def setUp(self):
        artifacts = ROOT / ".codlet-artifacts/installer-refresh-2026-09-22/macos/packaging-tests"
        artifacts.mkdir(parents=True, exist_ok=True)
        self.directory = Path(tempfile.mkdtemp(prefix="case-", dir=artifacts))
        self.source = self.directory / "source"
        self.runtime = self.directory / "runtime"
        self.plugins = self.directory / "plugins"
        self.binary = self.directory / "codlet"
        self.binary.write_bytes(bytes.fromhex("cffaedfe0c00000100000000"))
        self.original_root = builder.ROOT
        builder.ROOT = self.source
        self.write(self.source / "Cargo.toml", 'version = "0.2.0-preview.5"\nlicense = "Apache-2.0"\n')
        self.write(self.runtime / "bin/node", b"fixture node")
        self.write(self.runtime / "LICENSE", "fixture license")
        pin = {"version": "24.0.0", "platforms": {"darwin-arm64": {"version": "22.0.0", "executableSha256": self.hash(self.runtime / "bin/node"), "licenseSha256": self.hash(self.runtime / "LICENSE")}}}
        self.write(self.source / "runtime/node-runtime.json", json.dumps(pin))
        self.write(self.source / "LICENSE", "Fixture license text; never distributed.\n" * 10)
        for name in ["runtime/update-channel.json", "scripts/macos/initialize.mjs", "NOTICE", "docs/THIRD_PARTY_UI_LICENSES.txt", "types/host.d.ts"]:
            self.write(self.source / name, "fixture")
        packages = []
        for identifier in builder.ALLOWED:
            manifest = {"id": identifier, "version": "1.0.0", "permissions": ["ui.dom"]}
            file = self.plugins / "packages" / identifier / "codlet.json"
            self.write(file, json.dumps(manifest))
            packages.append({**manifest, "repository": "https://github.com/example/" + identifier, "tag": "v1.0.0", "sha256": "0" * 64, "dependencies": ["codex.ui.adapter"] if identifier == "codlet-gui" else [], "files": [{"path": "codlet.json", "bytes": file.stat().st_size, "sha256": self.hash(file)}]})
        self.catalog = {"schema": 1, "kind": "codlet-official-plugin-bundle", "installerPlugins": builder.ALLOWED, "packages": packages}
        self.save_catalog()

    def tearDown(self):
        builder.ROOT = self.original_root

    @staticmethod
    def write(file, data):
        file.parent.mkdir(parents=True, exist_ok=True)
        file.write_bytes(data if isinstance(data, bytes) else data.encode())

    @staticmethod
    def hash(file):
        return hashlib.sha256(file.read_bytes()).hexdigest()

    def save_catalog(self):
        self.write(self.plugins / "catalog.json", json.dumps(self.catalog))

    def stage(self):
        return builder.stage_payload(self.binary, self.runtime, self.plugins, self.directory / "output", "a" * 40, "b" * 40)

    def test_bundle_has_provenance_licenses_and_untouched_runtime(self):
        app, version, manifest = self.stage()
        self.assertEqual(version, "0.2.0-preview.5")
        self.assertEqual(manifest["sourceCommit"], "a" * 40)
        self.assertEqual(manifest["pluginsSourceCommit"], "b" * 40)
        self.assertFalse(manifest["notarized"])
        info = plistlib.loads((app / "Contents/Info.plist").read_bytes())
        self.assertEqual(info["LSArchitecturePriority"], ["arm64"])
        resources = app / "Contents/Resources"
        self.assertEqual(self.hash(resources / "runtime/node-v22.0.0-darwin-arm64/bin/node"), self.hash(self.runtime / "bin/node"))
        self.assertTrue((resources / "licenses/LICENSE").is_file())
        self.assertEqual(manifest["license"], "Apache-2.0")
        self.assertIn("Contents/Resources/licenses/LICENSE", manifest["licenseFiles"])
        self.assertFalse((resources / "config.json").exists())

    def test_rejects_incorrect_architecture_and_runtime(self):
        self.binary.write_bytes(b"MZ" + b"\x00" * 12)
        with self.assertRaisesRegex(ValueError, "Apple Silicon"):
            self.stage()
        self.binary.write_bytes(bytes.fromhex("cffaedfe0c00000100000000"))
        self.write(self.runtime / "bin/node", "changed")
        with self.assertRaisesRegex(ValueError, "pinned macOS runtime"):
            self.stage()

    def test_rejects_package_path_escape(self):
        self.catalog["packages"][0]["files"][0]["path"] = "../outside.json"
        self.save_catalog()
        with self.assertRaisesRegex(ValueError, "payload path"):
            self.stage()
        self.assertFalse((self.directory / "outside.json").exists())

    def test_rejects_missing_gui_dependency(self):
        self.catalog["packages"][2]["dependencies"] = []
        self.save_catalog()
        with self.assertRaisesRegex(ValueError, "UI Adapter dependency"):
            self.stage()

    def test_rejects_missing_license_text(self):
        (self.source / "LICENSE").unlink()
        with self.assertRaisesRegex(ValueError, "license text"):
            self.stage()


if __name__ == "__main__":
    unittest.main()
