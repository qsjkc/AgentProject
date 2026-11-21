import gzip
import hashlib
import io
import json
import os
from pathlib import Path
import re
import shutil
import subprocess
import sys
import tarfile
import tempfile
import textwrap
import unittest

from runtime_bundle import REQUIRED_FILES, SOURCE_PATHS, create_bundle, install_bundle, read_bundle


class RuntimeBundleTests(unittest.TestCase):
    def setUp(self):
        temporary = tempfile.TemporaryDirectory()
        self.addCleanup(temporary.cleanup)
        self.directory = Path(temporary.name)
        self.repo = self.directory / "repo"
        self.repo.mkdir()
        self.runtime = self.directory / "runtime"
        self.runtime.mkdir()
        self.archive = self.directory / "deploy-runtime.tgz"
        for name in REQUIRED_FILES | {"deploy/future_check.py", "deploy/Dockerfile.nginx"}:
            target = self.repo / name
            target.parent.mkdir(parents=True, exist_ok=True)
            target.write_text(f"committed: {name}\n", encoding="utf-8")
        self.git("init", "--quiet")
        self.commit()

    def git(self, *args):
        return subprocess.check_output(
            ["git", "-c", "core.autocrlf=false", "-c", "user.name=Bundle Test",
             "-c", "user.email=bundle@example.invalid", "-c", "commit.gpgsign=false", *args],
            cwd=self.repo, text=True,
            env={**os.environ, "GIT_CONFIG_NOSYSTEM": "1", "GIT_CONFIG_GLOBAL": os.devnull},
            stderr=subprocess.PIPE,
        ).strip()

    def commit(self):
        self.git("add", ".")
        self.git("commit", "--quiet", "-m", "configuration fixture")
        self.source = self.git("rev-parse", "HEAD")

    def create(self):
        return create_bundle(self.repo, self.source, self.archive)

    def install(self, manifest, **changes):
        return install_bundle(
            self.archive, changes.get("source", self.source),
            changes.get("sha256", manifest["sha256"]), self.runtime,
        )

    def test_archive_reads_exact_commit_and_includes_future_deployment_helpers(self):
        tracked = self.repo / "deploy/server_images.py"
        original = tracked.read_bytes()
        tracked.write_text("uncommitted change", encoding="utf-8")
        (self.repo / "deploy/.env").write_text("untracked secret", encoding="utf-8")
        manifest = self.create()
        payload = self.archive.read_bytes()
        files = read_bundle(payload, self.source)
        self.assertEqual(files["deploy/server_images.py"][0], original)
        self.assertIn("deploy/future_check.py", files)
        self.assertNotIn("deploy/.env", files)
        self.assertEqual(manifest["sha256"], hashlib.sha256(payload).hexdigest())
        self.assertEqual(manifest["bytes"], len(payload))
        self.assertEqual(self.create(), manifest)

    def test_actual_extract_only_updates_config_and_preserves_all_runtime_state(self):
        sentinels = {
            ".env", "agent-server/.env", "certificates/live/cert.pem",
            "data/postgres/PG_VERSION", "data/uploads/photo.png", "data/chroma/store",
            "data/downloads/old-installer.exe", "logs/server.log",
            "frontend/node_modules/retained", "frontend/dist/old.js", "backend/app/old.py",
            "backend/venv/retained", "agent-server/app/old.py", "agent-server/.venv/retained",
            "docker-compose.override.yml", "agent-server/docker-compose.override.yml",
            ".server-images-old/server-images.json", ".server-images-old/running-images.json",
            ".deployed-release.json", ".dockerignore", "deploy/operator-note.txt",
        }
        for name in sentinels | REQUIRED_FILES:
            target = self.runtime / name
            target.parent.mkdir(parents=True, exist_ok=True)
            target.write_text(f"existing: {name}\n", encoding="utf-8")
        before = {name: (self.runtime / name).read_bytes() for name in sentinels}
        manifest = self.create()
        report = self.install(manifest)
        self.assertEqual(report["sourceCommit"], self.source)
        self.assertEqual(report["sha256"], manifest["sha256"])
        self.assertEqual(before, {name: (self.runtime / name).read_bytes() for name in sentinels})
        for name in manifest["files"]:
            self.assertEqual((self.runtime / name).read_bytes(), (self.repo / name).read_bytes())

    def test_hash_or_source_mismatch_prevents_any_extraction(self):
        manifest = self.create()
        for changes in ({"sha256": "0" * 64}, {"source": "f" * 40}):
            with self.subTest(changes=changes), self.assertRaises(ValueError):
                self.install(manifest, **changes)
            self.assertEqual(list(self.runtime.iterdir()), [])

    def test_verifier_streamed_over_stdin_installs_and_emits_provenance(self):
        manifest = self.create()
        script = (Path(__file__).parent / "runtime_bundle.py").read_text(encoding="utf-8")
        result = subprocess.run(
            [sys.executable, "-", "--install", str(self.archive), "--source-commit", self.source,
             "--sha256", manifest["sha256"]],
            input=script, cwd=self.runtime, text=True, capture_output=True, timeout=10,
        )
        self.assertEqual(result.returncode, 0, result.stderr)
        self.assertEqual(json.loads(result.stdout)["sourceCommit"], self.source)
        self.assertEqual((self.runtime / "docker-compose.yml").read_bytes(),
                         (self.repo / "docker-compose.yml").read_bytes())

    def test_abbreviated_or_named_refs_are_rejected(self):
        for source in ("HEAD", "main", self.source[:12], self.source.upper()):
            with self.subTest(source=source), self.assertRaises(ValueError):
                create_bundle(self.repo, source, self.archive)
        self.assertFalse(self.archive.exists())

    def test_missing_required_runtime_file_fails_before_output(self):
        (self.repo / "deploy/nginx.conf").unlink()
        self.commit()
        with self.assertRaisesRegex(ValueError, "Missing runtime configuration"):
            self.create()
        self.assertFalse(self.archive.exists())

    def test_committed_sensitive_state_is_rejected(self):
        for name in ("deploy/.env", "deploy/config.env", "deploy/ssl/certificate",
                     "deploy/runtime/state.json", "deploy/data/store", "deploy/cert.key",
                     "deploy/docker-compose.override.yml"):
            with self.subTest(name=name):
                target = self.repo / name
                target.parent.mkdir(parents=True, exist_ok=True)
                target.write_text("must not ship", encoding="utf-8")
                self.commit()
                with self.assertRaisesRegex(ValueError, "Runtime state must not be bundled"):
                    self.create()
                self.assertFalse(self.archive.exists())
                target.unlink()
                self.commit()

    def test_unsafe_archive_paths_links_duplicates_and_extra_sources_are_rejected(self):
        self.create()
        original = self.archive.read_bytes()
        for name, kind in (("../.env", tarfile.REGTYPE), ("deploy/../../.env", tarfile.REGTYPE),
                           ("backend/app.py", tarfile.REGTYPE), ("deploy/link", tarfile.SYMTYPE),
                           ("deploy/link", tarfile.LNKTYPE), ("deploy/server_images.py", tarfile.REGTYPE)):
            with self.subTest(name=name, kind=kind):
                stream = io.BytesIO()
                with tarfile.open(fileobj=stream, mode="w", format=tarfile.PAX_FORMAT,
                                  pax_headers={"comment": self.source}) as modified:
                    with tarfile.open(fileobj=io.BytesIO(original), mode="r:gz") as archive:
                        for member in archive:
                            modified.addfile(member, archive.extractfile(member) if member.isfile() else None)
                    extra = tarfile.TarInfo(name)
                    extra.type = kind
                    extra.linkname = ".env" if kind != tarfile.REGTYPE else ""
                    modified.addfile(extra, io.BytesIO())
                self.archive.write_bytes(gzip.compress(stream.getvalue(), mtime=0))
                manifest = {"sha256": hashlib.sha256(self.archive.read_bytes()).hexdigest()}
                with self.assertRaises(ValueError):
                    self.install(manifest)
                self.assertEqual(list(self.runtime.iterdir()), [])

    def test_existing_wrong_destination_type_fails_before_other_files_change(self):
        manifest = self.create()
        target = self.runtime / "deploy/server_images.py"
        target.mkdir(parents=True)
        (self.runtime / "docker-compose.yml").write_text("original", encoding="utf-8")
        with self.assertRaisesRegex(ValueError, "Unexpected destination type"):
            self.install(manifest)
        self.assertEqual((self.runtime / "docker-compose.yml").read_text(), "original")
        self.assertFalse((self.runtime / "agent-server").exists())

    def test_replacing_hardlinked_config_does_not_modify_runtime_state(self):
        manifest = self.create()
        secret = self.runtime / ".env"
        secret.write_text("runtime sentinel", encoding="utf-8")
        os.link(secret, self.runtime / "docker-compose.yml")
        self.install(manifest)
        self.assertEqual(secret.read_text(), "runtime sentinel")

    def test_symlink_destination_is_rejected_before_extraction(self):
        manifest = self.create()
        try:
            (self.runtime / "deploy").symlink_to(self.repo / "deploy", target_is_directory=True)
        except OSError as error:
            self.skipTest(f"Host does not permit symlinks: {error}")
        with self.assertRaisesRegex(ValueError, "symlink destination"):
            self.install(manifest)
        self.assertFalse((self.runtime / "docker-compose.yml").exists())


class RuntimeBundleIntegrationTests(unittest.TestCase):
    ROOT = Path(__file__).resolve().parents[1]

    def test_real_repo_archive_contains_remote_scripts_and_config_bindings(self):
        source = subprocess.check_output(["git", "rev-parse", "HEAD"], cwd=self.ROOT, text=True).strip()
        with tempfile.TemporaryDirectory() as directory:
            output = Path(directory) / "runtime.tgz"
            manifest = create_bundle(self.ROOT, source, output)
            files = set(manifest["files"])
        workflow = (self.ROOT / ".github/workflows/cd.yml").read_text(encoding="utf-8")
        for block in re.findall(r"<<'REMOTE[^']*'\n(.*?)(?=\n          REMOTE)", workflow, re.DOTALL):
            for script in re.findall(r"python3 (deploy/[\w.-]+\.py)", block):
                self.assertIn(script, files)
        # Host bind mounts are retained data/certificates; nginx.conf and app code are baked in images.
        for compose in SOURCE_PATHS[1:]:
            config = (self.ROOT / compose).read_text(encoding="utf-8")
            for source_path in re.findall(r"^\s+- ([^\s:]+):/", config, re.MULTILINE):
                self.assertTrue(source_path.startswith(("./data/", "./logs", "/etc/letsencrypt")), source_path)

    def test_cd_upload_script_is_valid_and_has_no_source_cleanup(self):
        workflow = (self.ROOT / ".github/workflows/cd.yml").read_text(encoding="utf-8")
        match = re.search(
            r"      - name: Upload committed runtime configuration\n.*?        run: \|\n((?:          [^\n]*\n|\n)+)",
            workflow, re.DOTALL,
        )
        self.assertIsNotNone(match)
        script = textwrap.dedent(match.group(1))
        self.assertNotIn("rm -rf", script)
        self.assertNotIn("app-source", script)
        self.assertIn('< deploy/runtime_bundle.py > runtime-install.json', script)
        bash = shutil.which("bash")
        if os.name == "nt" and shutil.which("git"):
            candidate = Path(shutil.which("git")).resolve().parents[1] / "bin/bash.exe"
            if candidate.is_file():
                bash = str(candidate)
        if bash:
            result = subprocess.run([bash, "--noprofile", "--norc", "-n"], input=script,
                                    text=True, capture_output=True, timeout=10)
            self.assertEqual(result.returncode, 0, result.stderr)


if __name__ == "__main__":
    unittest.main()
