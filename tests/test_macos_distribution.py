"""Offline packaging boundary checks; no Mac binaries are executed here."""
import hashlib
import importlib.util
import json
from pathlib import Path
import plistlib
import tempfile
import unittest
import zipfile
import os
from contextlib import nullcontext
from unittest.mock import patch

ROOT = Path(__file__).resolve().parent.parent
spec = importlib.util.spec_from_file_location("macos_distribution", ROOT / "scripts/build-macos-distribution.py")
builder = importlib.util.module_from_spec(spec)
spec.loader.exec_module(builder)


class PackagingTests(unittest.TestCase):
    def setUp(self):
        temporary = tempfile.TemporaryDirectory(prefix="codlet-macos-packaging-")
        self.addCleanup(temporary.cleanup)
        # macOS /var is a system alias; packaging inputs deliberately reject
        # linked path components, so use the fixture's physical directory.
        self.directory = Path(temporary.name).resolve(strict=True)
        self.source = self.directory / "source"
        self.runtime = self.directory / "runtime"
        self.plugins = self.directory / "plugins"
        self.binary = self.directory / "codlet"
        self.binary.write_bytes(bytes.fromhex("cffaedfe0c00000100000000"))
        self.original_root = builder.ROOT
        builder.ROOT = self.source
        self.write(self.source / "Cargo.toml", 'version = "0.2.0"\nlicense = "Apache-2.0"\n')
        self.write(self.runtime / "bin/node", b"fixture node")
        self.write(self.runtime / "LICENSE", "fixture license")
        pin = {"version": "24.0.0", "mode": "managed", "platforms": {"darwin-arm64": {"version": "22.0.0", "executableSha256": self.hash(self.runtime / "bin/node"), "licenseSha256": self.hash(self.runtime / "LICENSE")}}}
        self.write(self.source / "runtime/node-runtime.json", json.dumps(pin))
        self.write(self.source / "runtime/client-node-profiles.json", '{"schema":1,"profiles":[]}')
        self.write(self.source / "LICENSE", "Fixture license text; never distributed.\n" * 10)
        self.write(self.source / "runtime/update-channel.json", '{"schema":1,"channel":"stable","source":{"manifestAsset":"codlet-update-managed.json"}}')
        for name in ["scripts/macos/initialize.mjs", "NOTICE", "docs/THIRD_PARTY_UI_LICENSES.txt", "docs/THIRD_PARTY_RUST_LICENSES.txt", "types/host.d.ts"]:
            self.write(self.source / name, "fixture")
        self.write(self.source / "scripts/distribution/official-plugins.json", (ROOT / "scripts/distribution/official-plugins.json").read_bytes())

    def tearDown(self):
        builder.ROOT = self.original_root

    @staticmethod
    def write(file, data):
        file.parent.mkdir(parents=True, exist_ok=True)
        file.write_bytes(data if isinstance(data, bytes) else data.encode())

    @staticmethod
    def hash(file):
        return hashlib.sha256(file.read_bytes()).hexdigest()

    def stage(self):
        return builder.stage_payload(self.binary, self.runtime, self.directory / "output", "a" * 40)

    def gui_bundle(self):
        official = json.loads((self.source / "scripts/distribution/official-plugins.json").read_text())["plugins"][0]
        manifest = {"schema": 1, "id": "codlet-gui", "version": "1.0.0-rc.3", "renderer": {"entry": "renderer.js", "world": "isolated"}, "permissions": official["permissions"]}
        package = self.plugins / "packages/codlet-gui"
        self.write(package / "codlet.json", json.dumps(manifest))
        self.write(package / "renderer.js", "module.exports={activate(){},deactivate(){}};")
        files = [{"path": p.name, "bytes": p.stat().st_size, "sha256": self.hash(p)} for p in sorted(package.iterdir())]
        pkg = {"id": manifest["id"], "version": manifest["version"], "permissions": manifest["permissions"], "updateSource": {key: official[key] for key in ("repositoryUrl", "repositoryId", "ownerId")}, "files": files}
        catalog = {"schema": 1, "kind": "codlet-official-plugin-bundle", "packages": [pkg]}
        self.write(self.plugins / "catalog.json", json.dumps(catalog))
        return catalog

    def test_optional_gui_is_inventory_checked_and_has_its_own_provenance(self):
        self.gui_bundle()
        app, _, manifest = builder.stage_payload(self.binary, self.runtime, self.directory / "output", "a" * 40, self.plugins, "b" * 40)
        self.assertEqual(manifest["pluginDelivery"], "installer-bundle")
        self.assertEqual(manifest["gui"], {"version": "1.0.0-rc.3", "sourceCommit": "b" * 40})
        resources = app / "Contents/Resources"
        self.assertEqual(json.loads((resources / "official-plugins.json").read_text())["bundledCatalog"], "optional-plugins/catalog.json")
        self.assertTrue((resources / "optional-plugins/packages/codlet-gui/renderer.js").is_file())

    def test_gui_tampering_source_substitution_and_traversal_are_rejected(self):
        for change in ("bytes", "identity", "path", "duplicate", "permission"):
            with self.subTest(change=change):
                catalog = self.gui_bundle()
                pkg = catalog["packages"][0]
                if change == "bytes":
                    self.write(self.plugins / "packages/codlet-gui/renderer.js", "changed")
                elif change == "identity":
                    pkg["updateSource"]["ownerId"] += 1
                elif change == "path":
                    pkg["files"][0]["path"] = "../outside"
                elif change == "duplicate":
                    pkg["files"].append(pkg["files"][0])
                else:
                    pkg["permissions"].append("host.raw")
                self.write(self.plugins / "catalog.json", json.dumps(catalog))
                resources = self.directory / change
                self.write(resources / "official-plugins.json", (self.source / "scripts/distribution/official-plugins.json").read_bytes())
                with self.assertRaises(ValueError):
                    builder.stage_gui(self.plugins, resources, "b" * 40)
                self.assertFalse((resources / "optional-plugins").exists())

    def test_managed_bundle_has_provenance_licenses_and_no_embedded_node(self):
        app, version, manifest = self.stage()
        self.assertEqual(version, "0.2.0")
        self.assertEqual(manifest["sourceCommit"], "a" * 40)
        self.assertEqual(manifest["pluginDelivery"], "github-latest")
        self.assertNotIn("pluginsSourceCommit", manifest)
        self.assertFalse(manifest["notarized"])
        info = plistlib.loads((app / "Contents/Info.plist").read_bytes())
        self.assertEqual(info["LSArchitecturePriority"], ["arm64"])
        resources = app / "Contents/Resources"
        self.assertFalse((resources / "runtime/node-v22.0.0-darwin-arm64/bin/node").exists())
        self.assertTrue((resources / "runtime/client-node-profiles.json").is_file())
        self.assertTrue((resources / "initialize.mjs").is_file())
        self.assertTrue((resources / "licenses/LICENSE").is_file())
        self.assertEqual(manifest["license"], "Apache-2.0")
        self.assertIn("Contents/Resources/licenses/LICENSE", manifest["licenseFiles"])
        self.assertFalse((resources / "config.json").exists())

    def test_legacy_bridge_restores_old_reader_node_contract(self):
        app, _, _ = self.stage()
        bridge = builder.stage_legacy_bridge(app, self.runtime, self.directory / "bridge/Codlet.app")
        pin = json.loads((bridge / "Contents/Resources/runtime/node-runtime.json").read_text())
        self.assertNotIn("mode", pin)
        self.assertEqual(self.hash(bridge / "Contents/Resources/runtime/node-v22.0.0-darwin-arm64/bin/node"), self.hash(self.runtime / "bin/node"))
        self.assertEqual(self.hash(bridge / "Contents/Resources/runtime/node-v22.0.0-darwin-arm64/LICENSE"), self.hash(self.runtime / "LICENSE"))
        self.assertFalse((app / "Contents/Resources/runtime/node-v22.0.0-darwin-arm64/bin/node").exists())

    def test_rejects_incorrect_architecture_and_runtime(self):
        self.binary.write_bytes(b"MZ" + b"\x00" * 12)
        with self.assertRaisesRegex(ValueError, "Apple Silicon"):
            self.stage()
        self.binary.write_bytes(bytes.fromhex("cffaedfe0c00000100000000"))
        self.write(self.runtime / "bin/node", "changed")
        with self.assertRaisesRegex(ValueError, "pinned macOS runtime"):
            self.stage()

    def test_package_contains_only_download_options_and_no_plugin_code(self):
        app, _, _ = self.stage()
        resources = app / "Contents/Resources"
        self.assertFalse((resources / "optional-plugins").exists())
        self.assertEqual(list(app.rglob("codlet.json")), [])
        self.assertEqual(list(app.rglob("renderer.js")), [])
        options = json.loads((resources / "official-plugins.json").read_text())
        self.assertEqual(options["kind"], "codlet-plugin-download-options")
        self.assertTrue(all("version" not in p and "files" not in p for p in options["plugins"]))

    def test_rejects_missing_license_text(self):
        (self.source / "LICENSE").unlink()
        with self.assertRaisesRegex(ValueError, "license text"):
            self.stage()

    def test_signed_bundle_update_format_is_explicitly_next_start_only(self):
        app, version, _ = self.stage()
        output = self.directory / "runtime-update.zip"
        # Windows cannot preserve POSIX file modes. This offline fixture checks
        # archive/metadata shape; real Mac packaging still validates each mode.
        original_stat = Path.stat
        def posix_file_modes(file, *args, **kwargs):
            result = original_stat(file, *args, **kwargs)
            if result.st_mode & 0o170000 == 0o100000:
                values = list(result)
                values[0] = (result.st_mode & ~0o777) | 0o644
                return os.stat_result(values)
            return result
        modes = patch.object(Path, "stat", posix_file_modes) if os.name == "nt" else nullcontext()
        with modes:
            asset = builder.build_update_zip(app, output, version)
        self.assertEqual(asset["sha256"], self.hash(output))
        with zipfile.ZipFile(output) as archive:
            manifest = json.loads(archive.read("runtime-update-manifest.json"))
            self.assertEqual(manifest["profile"], "macApp")
            self.assertNotIn("online", manifest)
            self.assertTrue(all(file["path"].startswith("Codlet.app/") for file in manifest["files"]))


if __name__ == "__main__":
    unittest.main()
