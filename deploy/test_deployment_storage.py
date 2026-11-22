from contextlib import redirect_stdout
from io import StringIO
import json
import os
from pathlib import Path
import subprocess
import tempfile
from types import SimpleNamespace
import unittest
from unittest.mock import patch

import deployment_storage as storage


REQUESTED = "a" * 40
PUBLISHED = "b" * 40
PRIOR = "c" * 40
STALE = "d" * 40


class DeploymentStorageTests(unittest.TestCase):
    def setUp(self):
        work = tempfile.TemporaryDirectory()
        self.addCleanup(work.cleanup)
        self.root = Path(work.name).resolve() / "deploy"
        self.root.mkdir()
        self.docker_root = self.root.parent / "docker"
        self.docker_root.mkdir()

    def write(self, relative, value):
        path = self.root / relative
        path.parent.mkdir(parents=True, exist_ok=True)
        path.write_text(value, encoding="utf-8")
        return path

    def override(self, source, services):
        return {"x-agentproject-source-commit": source, "services": {
            service: {"image": f"agentproject-{service}:sha-{source}", "pull_policy": "never"} for service in services
        }}

    def test_reports_exact_staging_artifacts_and_protects_current_and_prior_release(self):
        self.write(".deployed-release.json", json.dumps({"sourceCommit": PUBLISHED}))
        for path, services in storage.OVERRIDES.values():
            self.write(path, json.dumps(self.override(PUBLISHED, services)))
        self.write(f".server-images-{PUBLISHED}/previous-overrides.json", json.dumps({
            "schemaVersion": 1, "sourceCommit": PUBLISHED,
            "main": self.override(PRIOR, ("backend", "nginx")),
            "agent": self.override(PRIOR, ("agent-server",)),
        }))
        runtime = self.write(f".deploy-runtime-{STALE}.tgz", "old stage")
        os.utime(runtime, (1000, 1000))
        archive = f".server-images-{PRIOR}/server-images.tar.gz"
        upload = f"data/downloads/.Detachym-1.1.0-rc.19-x64.exe.{REQUESTED}.upload"
        self.write(archive, "keep archive")
        self.write(upload, "upload")
        self.write("data/downloads/Detachym-1.1.0-rc.18-x64.exe", "published installer")
        self.write(f"data/downloads/.Unrelated-1.1.0-x64.exe.{STALE}.upload", "unrelated")
        self.write(f".server-images-{PRIOR}/server-images.json", "manifest")
        self.write("data/postgres/database.file", "user data")
        self.write(".env", "DATABASE_PASSWORD=preserve-unreported-secret")

        image_id = f"sha256:{'e' * 64}"
        usage_result = json.dumps({
            "Type": "Build Cache", "TotalCount": "12", "Active": "3", "Size": "4.1GB", "Reclaimable": "1.8GB (43%)",
        })
        replies = [str(self.docker_root), "\n".join(f"/{name}\ttrue\t{image_id}\t{PUBLISHED}" for name in storage.CONTAINERS), usage_result]
        with patch.object(storage.os, "statvfs", create=True, side_effect=lambda path: SimpleNamespace(
            f_bavail=2 if path == self.root else 3, f_frsize=4096,
        )), patch.object(storage.subprocess, "run", side_effect=[
            subprocess.CompletedProcess([], 0, stdout) for stdout in replies
        ]) as docker:
            report = storage.inspect_storage(self.root, REQUESTED, now=1060)

        self.assertEqual(report["status"], "ok")
        self.assertEqual(report["filesystems"]["app"], {"device": self.root.stat().st_dev, "freeBytes": 8192})
        self.assertEqual(report["filesystems"]["docker"]["freeBytes"], 12288)
        self.assertEqual(report["protection"]["sourceCommits"], sorted([REQUESTED, PUBLISHED, PRIOR]))
        self.assertEqual(report["protection"]["priorSources"], [PRIOR])
        self.assertEqual(report["protection"]["runningContainers"][0]["imageId"], image_id)
        files = {item["path"]: item for item in report["staging"]["files"]}
        self.assertEqual(set(files), {runtime.name, archive, upload})
        self.assertEqual(files[runtime.name]["ageSeconds"], 60)
        self.assertEqual(files[runtime.name]["bytes"], 9)
        self.assertFalse(files[runtime.name]["protected"])
        self.assertTrue(files[archive]["protected"])
        self.assertTrue(files[upload]["protected"])
        self.assertEqual(report["dockerUsage"][0]["reclaimable"], "1.8GB (43%)")
        self.assertNotIn("preserve-unreported-secret", json.dumps(report))
        self.assertEqual(runtime.read_text(encoding="utf-8"), "old stage")
        self.assertEqual([call.args[0][1:3] for call in docker.call_args_list], [
            ["info", "--format"], ["container", "inspect"], ["system", "df"],
        ])
        self.assertEqual(docker.call_args_list[1].args[0][4].count("\t"), 3)
        for call in docker.call_args_list:
            self.assertEqual(call.kwargs["timeout"], storage.DOCKER_PROBE_TIMEOUT)
            self.assertEqual(call.kwargs["stderr"], subprocess.DEVNULL)

    def test_skips_symlink_files_directories_and_root(self):
        outside = self.root.parent / "other"
        (outside / "downloads").mkdir(parents=True)
        (outside / "downloads" / f".Detachym-1.1.0-x64.exe.{STALE}.upload").write_text("outside", encoding="utf-8")
        archive = outside / "server-images.tar.gz"
        archive.write_text("outside", encoding="utf-8")
        metadata = outside / "manifest.json"
        metadata.write_text(json.dumps({"sourceCommit": PUBLISHED}), encoding="utf-8")
        link = self.root.parent / "link"
        try:
            link.symlink_to(self.root, target_is_directory=True)
            (self.root / f".server-images-{STALE}").symlink_to(outside, target_is_directory=True)
            (self.root / f".deploy-runtime-{STALE}.tgz").symlink_to(archive)
            (self.root / "data").symlink_to(outside, target_is_directory=True)
            (self.root / ".deployed-release.json").symlink_to(metadata)
        except OSError as error:
            self.skipTest(f"Symbolic links unavailable: {error}")

        self.assertEqual(storage.staging_inventory(self.root, set(), 0)["files"], [])
        self.assertEqual(storage.read_metadata(self.root, ".deployed-release.json"), {})
        self.assertEqual(storage.inspect_storage(link, REQUESTED)["error"], "invalid-deploy-directory")

    def test_bounds_staging_scan_and_results(self):
        for source in (REQUESTED, PUBLISHED, PRIOR, STALE):
            self.write(f".deploy-runtime-{source}.tgz", "stage")
        with patch.object(storage, "MAX_SCAN_ENTRIES", 2), patch.object(storage, "MAX_STAGED_FILES", 1):
            report = storage.staging_inventory(self.root, set(), 0)
        self.assertEqual(len(report["files"]), 1)
        self.assertTrue(report["truncated"])

    def test_docker_timeout_still_reports_local_capacity_and_staging(self):
        self.write(f".deploy-runtime-{STALE}.tgz", "stage")
        with patch.object(storage.os, "statvfs", create=True, return_value=SimpleNamespace(f_bavail=5, f_frsize=4096)), \
                patch.object(storage.subprocess, "run", side_effect=subprocess.TimeoutExpired("docker", 10)):
            report = storage.inspect_storage(self.root, REQUESTED)
        self.assertEqual(report["status"], "partial")
        self.assertEqual(report["filesystems"]["app"]["freeBytes"], 20480)
        self.assertIsNone(report["filesystems"]["docker"])
        self.assertIn("docker-usage-unavailable", report["warnings"])
        self.assertEqual(len(report["staging"]["files"]), 1)

    def test_invalid_commit_writes_one_json_report_without_probing(self):
        output = StringIO()
        with redirect_stdout(output), patch.object(storage.sys, "argv", [
            "-", "--directory", str(self.root), "--protected-source", "../invalid",
        ]), patch.object(storage.subprocess, "run") as docker:
            self.assertEqual(storage.main(), 1)
        self.assertEqual(len(output.getvalue().splitlines()), 1)
        self.assertEqual(json.loads(output.getvalue()), {"status": "failed", "error": "invalid-protected-source"})
        docker.assert_not_called()


if __name__ == "__main__":
    unittest.main()
