import hashlib
import json
import os
from pathlib import Path
import shlex
import shutil
import subprocess
import tempfile
import textwrap
import unittest
from unittest.mock import patch

from server_images import verify_loaded_images
from test_verify_release_resume import RUN_ID, SOURCE, images_manifest, release
import verify_release_resume as resume


class StagedReleaseTests(unittest.TestCase):
    def setUp(self):
        temporary = tempfile.TemporaryDirectory()
        self.addCleanup(temporary.cleanup)
        self.root = Path(temporary.name)
        self.directory = Path(f".server-images-{SOURCE}")
        self.receipt = self.root / self.directory / "staged-release.json"
        contents = b"staged installer bytes"
        desktop = release(SOURCE, "1.1.0-rc.48", contents)
        images = images_manifest(SOURCE)
        self.desktop_manifest = self.write(f".desktop-release-{SOURCE}.json", json.dumps(desktop).encode())
        self.image_manifest = self.write(self.directory / "server-images.json", json.dumps(images).encode())
        self.installer = self.write(f"data/downloads/.{desktop['filename']}.{SOURCE}.upload", contents)
        for project, (_, services) in resume.PROJECTS.items():
            self.write(self.directory / f"{project}.compose.json", json.dumps(resume.overlay(SOURCE, services, managed=False)).encode())
        self.write(".env", b"DESKTOP_RELEASE_VERSION=1.1.0-rc.46\n")
        runtime = {name: resume.digest(self.write(name, f"committed: {name}\n".encode())) for name in resume.RUNTIME_FILES}
        self.expected = {"desktop": desktop, "workflowRunId": RUN_ID, "images": images, "runtime": runtime,
                         "staging": {"desktopManifestSha256": resume.digest(self.desktop_manifest),
                                     "imageManifestSha256": resume.digest(self.image_manifest)}}
        self.docker = {entry["tag"]: {"Id": entry["id"], "Os": "linux", "Architecture": "amd64",
                                      "Config": {"Labels": {"org.opencontainers.image.revision": SOURCE}}}
                       for entry in images["images"]}
        image_state = patch.object(resume, "image_state", side_effect=lambda *_: verify_loaded_images(images, self.docker.__getitem__))
        self.image_state = image_state.start()
        self.addCleanup(image_state.stop)

    def write(self, relative, contents):
        path = self.root / relative
        path.parent.mkdir(exist_ok=True, parents=True)
        path.write_bytes(contents)
        return path

    def snapshot(self):
        return {path.relative_to(self.root): (path.read_bytes(), path.stat().st_mtime_ns)
                for path in self.root.rglob("*") if path.is_file()}

    def stage(self, mode="verify", **changes):
        with patch.object(Path, "cwd", return_value=self.root):
            return resume.remote({**self.expected, **changes}, stage=mode)

    def test_receipt_written_only_after_complete_verified_staging(self):
        before = self.snapshot()
        result = self.stage("record")
        self.assertEqual(result["status"], "passed")
        self.assertEqual(result["workflowRunId"], RUN_ID)
        self.assertEqual(result["installerSha256"], hashlib.sha256(self.installer.read_bytes()).hexdigest())
        after = self.snapshot()
        self.assertEqual(set(after) - set(before), {self.receipt.relative_to(self.root)})
        self.assertEqual(before, {path: after[path] for path in before})
        self.assertEqual(self.stage(), result)
        self.assertEqual(self.snapshot(), after)

    def test_missing_damaged_or_wrong_run_receipt_is_rejected(self):
        with self.assertRaisesRegex(ValueError, "staged-release.json"):
            self.stage()
        self.stage("record")
        with self.assertRaisesRegex(ValueError, "CD run"):
            self.stage(workflowRunId="9999")
        for damage in (b"[1]", b"{", b"{}"):
            with self.subTest(damage=damage), self.assertRaises(ValueError):
                self.receipt.write_bytes(damage)
                self.stage()

    def test_staged_manifests_and_installer_are_verified_byte_for_byte(self):
        self.stage("record")
        for path in (self.desktop_manifest, self.image_manifest, self.installer):
            with self.subTest(file=path.name):
                original = path.read_bytes()
                # Keep manifests semantically identical and installer length stable.
                path.write_bytes(original + b"\n" if path.suffix == ".json" else b"x" + original[1:])
                with self.assertRaisesRegex(ValueError, "differs from the verified artifact"):
                    self.stage()
                path.write_bytes(original)
        self.installer.unlink()
        self.receipt.unlink()
        with self.assertRaisesRegex(ValueError, "upload"):
            self.stage("record")
        self.assertFalse(self.receipt.exists())

    def test_loaded_ids_and_compose_files_must_match_the_original_stage(self):
        self.stage("record")
        image = self.expected["images"]["images"][0]
        self.docker[image["tag"]]["Id"] = image["configId"]
        with self.assertRaisesRegex(ValueError, "Loaded images differ from the stage receipt"):
            self.stage()
        self.docker[image["tag"]]["Id"] = "sha256:" + "0" * 64
        with self.assertRaisesRegex(ValueError, "Loaded image differs from verified release"):
            self.stage()
        self.write(self.directory / "main.compose.json", b"{}")
        with self.assertRaisesRegex(ValueError, "Staged Compose override differs"):
            self.stage()

    def test_post_switch_resume_does_not_use_staging(self):
        self.stage("record")
        self.write(self.directory / "running-images.json", b"{}")
        with self.assertRaisesRegex(ValueError, "service switch receipt already exists"):
            self.stage()
        with patch.object(resume, "probe", return_value={"status": "passed"}) as switched:
            self.assertEqual(resume.remote(self.expected), {"status": "passed"})
            switched.assert_called_once()

    def test_remote_command_binds_staging_to_the_downloaded_artifact_bytes(self):
        runner_script = self.write("deploy/verify_release_resume.py", b"checked-out verifier")
        self.write("desktop-release/desktop-release.json", self.desktop_manifest.read_bytes())
        self.write("server-images/server-images.json", self.image_manifest.read_bytes())
        reply = subprocess.CompletedProcess([], 0, stdout=b'{"status":"passed"}')
        with patch.object(resume, "__file__", str(runner_script)), patch.object(resume.subprocess, "run", return_value=reply) as ssh:
            self.assertEqual(resume.call_remote("/srv/release dir", SOURCE, RUN_ID, stage="verify"), {"status": "passed"})
            argv = ssh.call_args.args[0]
            self.assertEqual(argv[:2], ["ssh", "deploy-target"])
            command = shlex.split(argv[2])
            self.assertEqual(command[:2], ["cd", "/srv/release dir"])
            self.assertEqual(json.loads(command[-1]), {"expected": self.expected, "stage": "verify"})
            self.assertEqual(ssh.call_args.kwargs["input"], runner_script.read_bytes())


class StagedReleaseCapacityTests(unittest.TestCase):
    def test_reuse_drops_only_archive_allowance_after_interrupted_staging(self):
        workflow = (Path(__file__).resolve().parents[1] / ".github/workflows/cd.yml").read_text(encoding="utf-8")
        bash = shutil.which("bash")
        if os.name == "nt" and shutil.which("git"):
            candidate = Path(shutil.which("git")).resolve().parents[1] / "bin/bash.exe"
            if candidate.is_file():
                bash = str(candidate)
        if not bash:
            self.skipTest("Bash is required to execute deployment guards")
        step = workflow.split("      - name: Check server platform and disk capacity\n", 1)[1].split("\n      - name:", 1)[0]
        capacity = textwrap.dedent(step.split("        run: |\n", 1)[1])
        mocks = r'''
stat() { printf '1073741824\n'; }
ssh() {
  ARCHIVE_BYTES="${2#*ARCHIVE_BYTES=\'}"
  ARCHIVE_BYTES="${ARCHIVE_BYTES%%\'*}"
  source /dev/stdin
}
python3() { :; }
docker() {
  case "$*" in
    *Architecture*) printf '%s\n' "$TEST_PLATFORM" ;;
    *DockerRootDir*) printf '/docker\n' ;;
    *) return 99 ;;
  esac
}
df() { printf 'Filesystem 1024-blocks Used Available\nfake 12345678 1234 %s\n' "$TEST_AVAILABLE_KIB"; }
'''
        cases = (("first attempt", "", 7_864_320, "linux/x86_64", 0),
                 ("retry without receipt", "", 6_815_744, "linux/x86_64", 1),
                 ("retry with exact staged proof", "true", 6_815_744, "linux/x86_64", 0),
                 ("fixed reserve is still required", "true", 2_097_151, "linux/x86_64", 1),
                 ("platform remains required", "true", 7_864_320, "linux/aarch64", 1))
        for label, reuse, available, platform, exit_code in cases:
            with self.subTest(case=label):
                result = subprocess.run([bash, "--noprofile", "--norc"], input=mocks + capacity,
                                        env={**os.environ, "REUSE_STAGED": reuse, "DEPLOY_APP_DIR": "/test",
                                             "TEST_AVAILABLE_KIB": str(available), "TEST_PLATFORM": platform},
                                        text=True, capture_output=True, timeout=10)
                self.assertEqual(result.returncode, exit_code, result.stdout + result.stderr)
                if platform == "linux/x86_64":
                    required = 2_097_152 if reuse else 7_340_032
                    self.assertIn(f"{required} KiB required", result.stdout)


if __name__ == "__main__":
    unittest.main()
