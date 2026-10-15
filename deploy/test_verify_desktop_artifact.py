import io
import json
from pathlib import Path
import tempfile
import unittest
from unittest.mock import patch

from verify_desktop_artifact import installer_manifest, verify_manifest, verify_public_release


class DesktopArtifactTests(unittest.TestCase):
    def setUp(self):
        self.temp = tempfile.TemporaryDirectory()
        self.addCleanup(self.temp.cleanup)
        self.directory = Path(self.temp.name)
        self.version = "1.1.0-rc.2"
        self.sha = "a" * 40
        self.installer = self.directory / f"Detachym-{self.version}-x64.exe"
        self.installer.write_bytes(b"synthetic-installer")

    def manifest(self):
        return installer_manifest(self.directory, self.version, self.sha)

    def test_unique_installer_and_exact_source_can_be_verified(self):
        manifest = self.manifest()
        self.assertEqual(verify_manifest(self.directory, manifest, self.version, self.sha), manifest)
        self.assertEqual(manifest["bytes"], 19)

    def test_missing_extra_wrong_version_and_empty_installers_fail(self):
        self.installer.unlink()
        with self.assertRaises(ValueError):
            self.manifest()
        self.installer.write_bytes(b"data")
        extra = self.directory / "old.exe"
        extra.write_bytes(b"old")
        with self.assertRaises(ValueError):
            self.manifest()
        extra.unlink()
        with self.assertRaises(ValueError):
            installer_manifest(self.directory, "1.1.0-rc.3", self.sha)
        self.installer.write_bytes(b"")
        with self.assertRaises(ValueError):
            self.manifest()

    def test_bad_version_and_non_full_commit_fail(self):
        for version, sha in (("../outside", self.sha), (self.version, "main"), (self.version, "a" * 7)):
            with self.assertRaises(ValueError):
                installer_manifest(self.directory, version, sha)

    def test_tampered_file_or_manifest_cannot_be_reused(self):
        original = self.manifest()
        for key, value in (("sourceCommit", "b" * 40), ("version", "1.0.0"),
                           ("filename", "../other.exe"), ("bytes", 1), ("sha256", "0" * 64)):
            with self.subTest(key=key), self.assertRaises(ValueError):
                verify_manifest(self.directory, {**original, key: value}, self.version, self.sha)
        self.installer.write_bytes(b"tampered-installer")
        with self.assertRaises(ValueError):
            verify_manifest(self.directory, original, self.version, self.sha)

    def public_responses(self, *, available=True, version=None, size="19", ready="ready"):
        def response(payload):
            return io.BytesIO(json.dumps(payload).encode())
        head = io.BytesIO()
        head.status = 200
        head.headers = {"Content-Length": size}
        return [response({"status": ready}), response({"available": available,
                "version": version or self.version, "filename": self.installer.name}), head]

    def test_public_readiness_version_and_head_are_required(self):
        manifest = self.manifest()
        with patch("verify_desktop_artifact.urlopen", side_effect=self.public_responses()) as request:
            self.assertEqual(verify_public_release("https://detachym.top", manifest)["status"], "passed")
            self.assertEqual(request.call_args.args[0].method, "HEAD")
        for parameters in ({"ready": "failed"}, {"available": False}, {"version": "1.0.0"}, {"size": "1"}):
            with self.subTest(parameters=parameters), patch(
                "verify_desktop_artifact.urlopen", side_effect=self.public_responses(**parameters)
            ), self.assertRaises(ValueError):
                verify_public_release("https://detachym.top", manifest)

    def test_public_check_does_not_accept_http_or_url_credentials(self):
        for origin in ("http://detachym.top", "https://user:password@detachym.top", "https:///missing"):
            with self.assertRaises(ValueError):
                verify_public_release(origin, self.manifest())


if __name__ == "__main__":
    unittest.main()
