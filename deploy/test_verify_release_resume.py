import hashlib
import json
import os
from pathlib import Path
import re
import shutil
import subprocess
import tempfile
import textwrap
import unittest
from unittest.mock import call, patch

from server_images import validate_manifest
import verify_release_resume as resume


SOURCE = "a" * 40
PRIOR = "b" * 40
RUN_ID = "4567"


def release(source, version, contents):
    return {"sourceCommit": source, "version": version, "filename": f"Detachym-{version}-x64.exe",
            "bytes": len(contents), "sha256": hashlib.sha256(contents).hexdigest()}


def release_keys(manifest):
    return f"DESKTOP_RELEASE_VERSION={manifest['version']}\nDESKTOP_RELEASE_FILE={manifest['filename']}\n"


def images_manifest(source):
    rows = []
    for index, service in enumerate(("backend", "nginx", "agent-server"), start=1):
        rows.append({"service": service, "tag": f"agentproject-{service}:sha-{source}",
                     "id": f"sha256:{index:064x}", "configId": f"sha256:{index + 3:064x}",
                     "os": "linux", "architecture": "amd64", "revision": source})
    return validate_manifest({"schemaVersion": 1, "sourceCommit": source, "filename": "server-images.tar.gz",
                              "bytes": 123, "sha256": "e" * 64, "images": rows}, source)


class ReleaseResumeTests(unittest.TestCase):
    def setUp(self):
        temporary = tempfile.TemporaryDirectory()
        self.addCleanup(temporary.cleanup)
        self.root = Path(temporary.name)
        self.directory = Path(f".server-images-{SOURCE}")
        self.pending = Path(f".desktop-release-{SOURCE}.json")
        self.partial = release(SOURCE, "1.1.0-rc.28", b"candidate installer")
        self.prior = release(PRIOR, "1.1.0-rc.27", b"previous installer")
        self.write(self.pending, self.partial)
        self.write(".deployed-release.json", self.prior)
        self.installer = self.write(f"data/downloads/{self.partial['filename']}", b"candidate installer")
        self.write(f"data/downloads/{self.prior['filename']}", b"previous installer")
        self.write(".env", "PRIVATE_KEY=synthetic-value\n" + release_keys(self.partial))
        self.write(f".release-state-before-{SOURCE}.env", release_keys(self.prior))
        self.write(f".public-origin-{SOURCE}", "https://detachym.example\n")
        self.images = images_manifest(SOURCE)
        self.write(self.directory / "server-images.json", self.images)
        self.running = {"status": "passed", "sourceCommit": SOURCE,
                        "images": [{**row, "loadedId": row["configId"]} for row in self.images["images"]],
                        "containers": [{"service": row["service"], "container": f"agentproject-{row['service']}",
                                        "imageId": row["configId"], "buildImageId": row["id"],
                                        "configId": row["configId"], "sourceCommit": SOURCE, "running": True}
                                       for row in self.images["images"]]}
        self.receipt = self.directory / "running-images.json"
        self.write(self.receipt, {**self.running, "workflowRunId": RUN_ID})
        self.previous = {"schemaVersion": 1, "sourceCommit": SOURCE}
        for project, (directory, services) in resume.PROJECTS.items():
            self.previous[project] = resume.overlay(PRIOR, services, managed=True)
            self.write(directory / "docker-compose.override.yml", resume.overlay(SOURCE, services, managed=True))
            self.write(self.directory / f"{project}.compose.json", resume.overlay(SOURCE, services, managed=False))
        self.write(self.directory / "previous-overrides.json", self.previous)
        runtime = {name: resume.digest(self.write(name, f"committed: {name}\n")) for name in resume.RUNTIME_FILES}
        self.expected = {"desktop": self.partial, "workflowRunId": RUN_ID, "images": self.images, "runtime": runtime}
        states = patch.object(resume, "image_state", side_effect=lambda *args, running=False: (
            self.running if running else {"status": "passed", "sourceCommit": PRIOR}))
        self.image_state = states.start()
        self.addCleanup(states.stop)
        readiness = patch.object(resume, "verify_readiness")
        self.readiness = readiness.start()
        self.addCleanup(readiness.stop)

    def write(self, relative, contents):
        path = self.root / relative
        path.parent.mkdir(exist_ok=True, parents=True)
        if isinstance(contents, dict):
            contents = json.dumps(contents)
        if isinstance(contents, str):
            contents = contents.encode()
        path.write_bytes(contents)
        return path

    def remote(self, before=None):
        with patch.object(Path, "cwd", return_value=self.root):
            return resume.remote(self.expected, before)

    def test_probe_checks_exact_previous_and_running_images_without_writes(self):
        before = {path: path.read_bytes() for path in self.root.rglob("*") if path.is_file()}
        observed = self.remote()
        self.assertFalse(observed["alreadyPublished"])
        self.assertEqual(observed["priorSource"], PRIOR)
        self.assertEqual(observed["running"], self.running)
        self.assertEqual(self.image_state.call_args_list, [call(self.root, Path(f".server-images-{PRIOR}"), PRIOR),
                                                         call(self.root, self.directory, SOURCE, running=True)])
        self.readiness.assert_called_once_with(self.partial)
        self.assertEqual(before, {path: path.read_bytes() for path in self.root.rglob("*") if path.is_file()})

    def test_other_run_and_different_running_image_do_not_qualify(self):
        self.write(self.receipt, {**self.running, "workflowRunId": "4568"})
        with self.assertRaisesRegex(ValueError, "different CD run"):
            self.remote()
        self.write(self.receipt, {**self.running, "workflowRunId": RUN_ID, "containers": self.running["containers"][:-1]})
        with self.assertRaisesRegex(ValueError, "running images differ"):
            self.remote()
        self.assertEqual(json.loads((self.root / ".deployed-release.json").read_bytes()), self.prior)

    def test_corruption_of_installer_runtime_and_rollback_prevents_resume(self):
        cases = (
            (self.pending, {**self.partial, "sha256": "d" * 64}, "Pending release"),
            (".deployed-release.json", {**self.prior, "sourceCommit": "d" * 40}, "previous deployment"),
            (self.installer.relative_to(self.root), b"candidate installe!", "installed file differs"),
            ("docker-compose.yml", "changed", "Runtime configuration"),
            (".env", release_keys(self.prior), "Runtime desktop release keys"),
            ("agent-server/docker-compose.override.yml", {"services": {}}, "default Compose override"),
            (self.directory / "main.compose.json", {"services": {}}, "explicit Compose override"),
            (self.directory / "server-images.json", {**self.images, "bytes": 42}, "image manifest differs"),
            (self.directory / "previous-overrides.json", {**self.previous, "agent": {}}, "Previous Compose override"),
            (f".release-state-before-{SOURCE}.env", release_keys(self.partial), "previous desktop release keys"),
        )
        for relative, contents, expected in cases:
            with self.subTest(relative=relative):
                path = self.root / relative
                original = path.read_bytes()
                try:
                    self.write(relative, contents)
                    before = {file: file.read_bytes() for file in self.root.rglob("*") if file.is_file()}
                    with self.assertRaisesRegex(ValueError, expected):
                        self.remote()
                    self.assertEqual(before, {file: file.read_bytes() for file in self.root.rglob("*") if file.is_file()})
                finally:
                    path.write_bytes(original)

    def test_unmanaged_compose_overrides_block_resume_in_either_project(self):
        for directory, _ in resume.PROJECTS.values():
            for name in ("compose.override.yaml", "compose.override.yml", "docker-compose.override.yaml"):
                with self.subTest(directory=directory, name=name):
                    path = self.write(directory / name, "unmanaged")
                    with self.assertRaisesRegex(ValueError, "Unmanaged Compose override"):
                        self.remote()
                    path.unlink()
        override = self.root / "agent-server/compose.override.yml"
        try:
            override.symlink_to(self.root / "absent-target")
        except OSError:
            return  # Windows may deny creating symlinks without Developer Mode.
        with self.assertRaisesRegex(ValueError, "Unmanaged Compose override"):
            self.remote()

    def test_publish_rechecks_proof_and_is_idempotent(self):
        before = self.remote()
        self.write(f".public-origin-{SOURCE}", "https://changed.example\n")
        with self.assertRaisesRegex(ValueError, "changed during public verification"):
            self.remote(before)
        self.assertTrue((self.root / self.pending).is_file())
        self.assertEqual(json.loads((self.root / ".deployed-release.json").read_bytes()), self.prior)
        self.write(f".public-origin-{SOURCE}", before["origin"] + "\n")
        self.remote(before)
        self.assertFalse((self.root / self.pending).exists())
        published = self.root / ".deployed-release.json"
        self.assertEqual(json.loads(published.read_bytes()), self.partial)
        update_time = published.stat().st_mtime_ns
        after = self.remote()
        self.assertTrue(after["alreadyPublished"])
        self.assertEqual(self.remote(after), after)
        self.assertEqual(published.stat().st_mtime_ns, update_time)

    def test_fresh_readiness_and_public_full_body_are_both_required(self):
        self.readiness.side_effect = ValueError("backend not ready")
        with self.assertRaisesRegex(ValueError, "backend not ready"):
            self.remote()
        origin = "https://detachym.example"
        report = {**self.partial, "status": "passed", "origin": origin}
        resume.verify_public_proof(report, self.partial, origin)
        for change in ({"status": "failed"}, {"sha256": "0" * 64}, {"origin": "https://changed.example"}):
            with self.assertRaisesRegex(ValueError, "successful full public download"):
                resume.verify_public_proof({**report, **change}, self.partial, origin)


class ResumeWorkflowTests(unittest.TestCase):
    ROOT = Path(__file__).resolve().parents[1]

    @classmethod
    def setUpClass(cls):
        cls.workflow = (cls.ROOT / ".github/workflows/cd.yml").read_text(encoding="utf-8")
        cls.bash = shutil.which("bash")
        if os.name == "nt" and shutil.which("git"):
            candidate = Path(shutil.which("git")).resolve().parents[1] / "bin/bash.exe"
            if candidate.is_file():
                cls.bash = str(candidate)

    def section(self, name):
        start = self.workflow.index(f"      - name: {name}\n")
        end = self.workflow.find("\n      - ", start)
        return self.workflow[start:end if end >= 0 else None]

    def execute(self, step, commands, **changes):
        if not self.bash:
            self.skipTest("Bash is required to execute deployment guards")
        script = textwrap.dedent(self.section(step).split("        run: |\n", 1)[1])
        with tempfile.TemporaryDirectory() as directory:
            output = Path(directory) / "outputs"
            (Path(directory) / "resume-probe.json").write_text('{"origin":"https://detachym.example"}')
            env = {**os.environ, "GITHUB_OUTPUT": output.as_posix(), "GITHUB_RUN_ID": RUN_ID,
                   "GITHUB_RUN_ATTEMPT": "2", "GITHUB_REPOSITORY": "test/project", "DEPLOY_APP_DIR": "/deployment",
                   "DEPLOY_SOURCE_SHA": SOURCE, "TEST_MAIN_SHA": SOURCE, "VERIFY_ONLY": "true", **changes}
            result = subprocess.run([self.bash, "--noprofile", "--norc"], cwd=directory, input=commands + script,
                                    text=True, capture_output=True, env=env, timeout=10)
            return result, output.read_text() if output.exists() else ""

    def test_only_same_run_retry_can_opt_into_skipping_writes(self):
        step = "Check whether the same CD run already switched"
        mock = """
python3() {
  echo 'probed' >&2
  printf '{"status":"%s"}\\n' "$TEST_RESULT"
  [[ "$TEST_RESULT" == passed ]]
}
"""
        first, first_outputs = self.execute(step, mock, GITHUB_RUN_ATTEMPT="1", TEST_RESULT="passed")
        self.assertEqual(first.returncode, 0, first.stderr)
        self.assertNotIn("probed", first.stderr)
        self.assertEqual(first_outputs, "")
        invalid, invalid_outputs = self.execute(step, mock, TEST_RESULT="failed")
        self.assertEqual(invalid.returncode, 0, invalid.stderr)
        self.assertIn("probed", invalid.stderr)
        self.assertEqual(invalid_outputs, "")
        exact, exact_outputs = self.execute(step, mock, TEST_RESULT="passed")
        self.assertEqual(exact.returncode, 0, exact.stderr)
        self.assertEqual(exact_outputs, "verify_only=true\n")
        for name in ("Prepare remote directories", "Check server platform and disk capacity",
                     "Upload committed runtime configuration", "Stage and load verified server images",
                     "Stage verified desktop download", "Deploy on server"):
            self.assertIn("if: steps.resume.outputs.verify_only != 'true'", self.section(name))
        self.assertNotIn("verify_only", self.section("Refuse application or database downgrade"))
        self.assertRegex(self.workflow, r"concurrency:\n  group: cd-main\n  cancel-in-progress: false")

    def test_after_full_download_refresh_main_before_remote_publication(self):
        step = "Verify public release and download"
        shell = """
python3() {
  case "$*" in
    *'-c '*) echo https://detachym.example ;;
    *'--proof resume-probe.json --public-download public-installer-download.json'*) echo 'publish proof' >&2 ;;
    *'--verify-public-download'*) echo 'full download started' >&2; [[ "$TEST_DOWNLOAD" == passed ]] ;;
    *) echo 'metadata check' >&2 ;;
  esac
}
timeout() { shift 2; "$@"; }
gh() { echo 'main checked' >&2; echo "$TEST_MAIN_SHA"; }
ssh() { echo 'unexpected direct ssh publication' >&2; return 1; }
"""
        for changes, outcome in (({"TEST_DOWNLOAD": "passed"}, True),
                                 ({"TEST_DOWNLOAD": "failed"}, False),
                                 ({"TEST_DOWNLOAD": "passed", "TEST_MAIN_SHA": PRIOR}, False)):
            with self.subTest(changes=changes):
                result, _ = self.execute(step, shell, **changes)
                self.assertEqual(result.returncode == 0, outcome, result.stderr)
                self.assertIn("full download started", result.stderr)
                self.assertNotIn("unexpected direct ssh publication", result.stderr)
                self.assertEqual("publish proof" in result.stderr, outcome, result.stderr)
                if outcome:
                    self.assertLess(result.stderr.index("full download started"), result.stderr.index("main checked"))
                    self.assertLess(result.stderr.index("main checked"), result.stderr.index("publish proof"))


if __name__ == "__main__":
    unittest.main()
