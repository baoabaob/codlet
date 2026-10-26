"""Offline runtime staging with synthetic archives; no archive content executes."""
import hashlib
import importlib.util
import json
import os
from pathlib import Path
import subprocess
import tempfile
import unittest
import zipfile

ROOT = Path(__file__).resolve().parent.parent
spec = importlib.util.spec_from_file_location("install_js_runtime", ROOT / "scripts/install-js-runtime.py")
installer = importlib.util.module_from_spec(spec)
spec.loader.exec_module(installer)


class RuntimeStagingTests(unittest.TestCase):
    def setUp(self):
        temporary = tempfile.TemporaryDirectory(prefix="codlet-runtime-staging-")
        self.addCleanup(temporary.cleanup)
        self.root = Path(temporary.name).resolve()
        self.source = self.root / "source"
        (self.source / "scripts").mkdir(parents=True)
        (self.source / "runtime").mkdir()
        original_file = installer.__file__
        installer.__file__ = str(self.source / "scripts/install-js-runtime.py")
        self.addCleanup(setattr, installer, "__file__", original_file)
        self.basename = "node-v24.0.0-win-x64"
        self.archive = self.root / "runtime.zip"
        self.payload = {"node.exe": b"synthetic executable", "LICENSE": b"synthetic license"}
        with zipfile.ZipFile(self.archive, "w") as package:
            for name, data in self.payload.items():
                package.writestr(self.basename + "/" + name, data)
        sha = lambda data: hashlib.sha256(data).hexdigest()
        self.pin = {"version": "24.0.0", "platforms": {"win-x64": {
            "archiveSha256": sha(self.archive.read_bytes()),
            "executableSha256": sha(self.payload["node.exe"]),
            "licenseSha256": sha(self.payload["LICENSE"]),
        }}}
        self.write_pin()
        self.destination = self.root / "用户 runtime"
        self.target = self.destination / "runtime" / self.basename

    def write_pin(self):
        (self.source / "runtime/node-runtime.json").write_text(json.dumps(self.pin), encoding="utf-8")

    def install(self):
        return installer.install(self.destination, "win-x64", self.archive)

    def link_directory(self, link, target):
        if os.name == "nt":
            subprocess.run(["cmd", "/c", "mklink", "/J", str(link), str(target)], check=True, stdout=subprocess.DEVNULL)
            self.addCleanup(link.rmdir)
        else:
            link.symlink_to(target, target_is_directory=True)
            self.addCleanup(link.unlink)

    def test_atomic_verified_publication_and_idempotent_reuse(self):
        node = self.install()
        self.assertEqual(node.read_bytes(), self.payload["node.exe"])
        self.assertEqual(self.install(), node)
        self.assertEqual(sorted(p.name for p in self.target.parent.iterdir()), [self.basename])

    def test_changed_or_partial_existing_directory_is_preserved(self):
        self.target.mkdir(parents=True)
        (self.target / "LICENSE").write_bytes(b"keep partial")
        with self.assertRaisesRegex(ValueError, "existing runtime differs"):
            self.install()
        self.assertEqual((self.target / "LICENSE").read_bytes(), b"keep partial")
        self.assertFalse((self.target / "node.exe").exists())

    def test_failed_archive_verification_retires_unpublished_staging(self):
        self.pin["platforms"]["win-x64"]["archiveSha256"] = "0" * 64
        self.write_pin()
        with self.assertRaisesRegex(ValueError, "archive differs"):
            self.install()
        self.assertFalse(self.target.exists())
        self.assertEqual(list(self.target.parent.iterdir()), [])

    def test_linked_destination_ancestor_and_existing_member_parent_are_rejected(self):
        outside = self.root / "outside"
        outside.mkdir()
        alias = self.root / "alias"
        self.link_directory(alias, outside)
        with self.assertRaisesRegex(ValueError, "Linked runtime path"):
            installer.install(alias / "child", "win-x64", self.archive)
        self.assertEqual(list(outside.iterdir()), [])
        self.target.mkdir(parents=True)
        member = self.target / "bin"
        self.link_directory(member, outside)
        with self.assertRaisesRegex(ValueError, "Linked runtime path"):
            installer.plain(member / "node")
        self.assertEqual(list(outside.iterdir()), [])


if __name__ == "__main__":
    unittest.main()
