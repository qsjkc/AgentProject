from contextlib import redirect_stdout
from io import StringIO
import base64
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


class RetirementTests(unittest.TestCase):
    def setUp(self):
        work = tempfile.TemporaryDirectory()
        self.addCleanup(work.cleanup)
        self.root = Path(work.name).resolve()
        self.manifest = {
            "schemaVersion": 1, "sourceCommit": STALE, "filename": "server-images.tar.gz", "bytes": 8192,
            "sha256": "e" * 64,
            "images": [{"service": service, "tag": f"agentproject-{service}:sha-{STALE}", "revision": STALE,
                        "id": self.image_id(index), "configId": self.image_id(index + 10), "os": "linux", "architecture": "amd64"}
                       for index, service in enumerate(storage.SERVICES, 1)],
        }
        self.tags = {entry["tag"]: entry["configId"] for entry in self.manifest["images"]}
        self.running_images = {name: self.image_id(index) for index, name in enumerate(storage.CONTAINERS, 4)}
        self.references = {f"{index:064x}": image_id for index, image_id in enumerate(self.running_images.values(), 1)}
        self.commands = []
        self.remove_limit = len(self.tags)
        self.list_failure = False
        self.inspect_revision = STALE
        self.write(".deployed-release.json", {"sourceCommit": PUBLISHED})
        for path, services in storage.OVERRIDES.values():
            self.write(path, self.override(PUBLISHED, services))
        self.write(f".server-images-{PUBLISHED}/previous-overrides.json", {
            "schemaVersion": 1, "sourceCommit": PUBLISHED,
            **{project: self.override(PRIOR, services) for project, (_, services) in storage.OVERRIDES.items()},
        })

    @staticmethod
    def image_id(index):
        return f"sha256:{index:064x}"

    def write(self, relative, value):
        path = self.root / relative
        path.parent.mkdir(parents=True, exist_ok=True)
        path.write_text(json.dumps(value), encoding="utf-8")

    @staticmethod
    def override(source, services):
        return {"x-agentproject-source-commit": source, "services": {
            service: {"image": f"agentproject-{service}:sha-{source}", "pull_policy": "never"} for service in services
        }}

    def docker(self, *args, **options):
        self.commands.append((args, options))
        if args[:3] == ("container", "inspect", "--format"):
            if args[4:] == storage.CONTAINERS:
                return "\n".join(f"/{name}\ttrue\t{image_id}\t{PUBLISHED}" for name, image_id in self.running_images.items())
            self.assertEqual(set(args[4:]), self.references.keys())
            return "\n".join(f"{container}\t{image_id}" for container, image_id in self.references.items())
        if args == ("container", "ls", "--all", "--quiet", "--no-trunc"):
            return "\n".join(self.references)
        if args[:2] == ("image", "ls"):
            self.assertIn("--all", args)
            self.assertIn("--no-trunc", args)
            tag = args[-1].split("=", 1)[1]
            if self.list_failure:
                return None
            return f"{tag}\t{self.tags[tag]}" if tag in self.tags else ""
        if args[:2] == ("image", "inspect"):
            return f"{self.tags[args[-1]]}\tlinux\tamd64\t{self.inspect_revision}"
        if args[:3] == ("image", "rm", "--no-prune"):
            for tag in args[3:3 + self.remove_limit]:
                self.tags.pop(tag)
            return "removed" if self.remove_limit == len(args[3:]) else None
        self.fail(f"Unexpected Docker command {args}")

    def app_filesystem(self, _root):
        return {"device": 1, "freeBytes": 4096}

    def docker_filesystem(self):
        return {"device": 2, "freeBytes": 4096 + 8192 * (len(storage.SERVICES) - len(self.tags))}

    def retire(self, requested=REQUESTED, artifact_id="14736814415"):
        encoded = base64.b64encode(json.dumps(self.manifest).encode()).decode()
        with patch.object(storage, "docker_output", side_effect=self.docker), \
                patch.object(storage, "app_filesystem", side_effect=self.app_filesystem), \
                patch.object(storage, "docker_filesystem", side_effect=self.docker_filesystem):
            return storage.retire_archive(self.root, requested, encoded, artifact_id)

    def mutations(self):
        return [(args, options) for args, options in self.commands if args[:2] == ("image", "rm")]

    def test_retires_only_exact_tags_and_measures_real_filesystem_delta(self):
        targets = list(self.tags)
        report = self.retire()
        self.assertEqual(report["status"], "passed")
        self.assertEqual(report["outcome"], "retired")
        self.assertEqual(report["archiveArtifactId"], 14736814415)
        self.assertEqual(report["protectedSources"], sorted([REQUESTED, PUBLISHED, PRIOR]))
        self.assertEqual(report["tags"]["removed"], targets)
        self.assertEqual(report["tags"]["remaining"], [])
        self.assertEqual(report["filesystems"]["freeBytesDelta"], {"app": 0, "docker": 24576})
        self.assertEqual(self.mutations(), [(('image', 'rm', '--no-prune', *targets), {"timeout": storage.DOCKER_REMOVE_TIMEOUT})])

    def test_requires_successful_exact_listings_for_idempotency(self):
        self.tags.clear()
        report = self.retire()
        self.assertEqual(report["status"], "passed")
        self.assertEqual(report["outcome"], "already-absent")
        self.assertEqual(len(report["tags"]["absentBefore"]), 3)
        self.assertEqual(self.mutations(), [])
        self.list_failure = True
        self.assertEqual(self.retire()["error"], "image-tag-inventory-unavailable")
        self.assertEqual(self.mutations(), [])

    def test_container_config_id_reference_blocks_all_removal(self):
        # This container is absent from the active-release check but appears in --all.
        self.references["e" * 64] = self.manifest["images"][0]["configId"]
        self.assertEqual(self.retire()["error"], "archive-image-referenced")
        self.assertEqual(self.mutations(), [])

    def test_refuses_unknown_or_disagreeing_rollback_and_current_release(self):
        path = f".server-images-{PUBLISHED}/previous-overrides.json"
        self.write(path, {"schemaVersion": 1, "sourceCommit": PUBLISHED, "main": self.override(PRIOR, ("backend", "nginx"))})
        self.assertEqual(self.retire()["error"], "rollback-protection-unconfirmed")
        self.assertEqual(self.mutations(), [])
        self.write(path, {"schemaVersion": 1, "sourceCommit": PUBLISHED,
                          **{project: self.override(PRIOR, services) for project, (_, services) in storage.OVERRIDES.items()}})
        self.write("agent-server/docker-compose.override.yml", self.override(PRIOR, ("agent-server",)))
        self.assertEqual(self.retire()["error"], "rollback-protection-unconfirmed")
        self.assertEqual(self.mutations(), [])

    def test_refuses_protected_source_even_if_archived(self):
        self.assertEqual(self.retire(requested=STALE)["error"], "protected-release")
        self.assertEqual(self.mutations(), [])

    def test_refuses_archive_or_image_inconsistency_before_removing_any_tag(self):
        self.inspect_revision = PRIOR
        self.assertEqual(self.retire()["error"], "archive-image-mismatch")
        self.assertEqual(self.mutations(), [])
        self.inspect_revision = STALE
        self.tags[self.manifest["images"][0]["tag"]] = self.image_id(999)
        self.assertEqual(self.retire()["error"], "archive-image-mismatch")
        self.assertEqual(self.mutations(), [])
        self.commands.clear()
        self.manifest["images"][0]["tag"] = "--force"
        self.assertEqual(self.retire()["error"], "invalid-archive-manifest")
        self.assertEqual(self.retire(artifact_id="0")["error"], "invalid-archive-artifact-id")
        self.assertEqual(self.commands, [])

    def test_reports_partial_removal_from_authoritative_postcheck(self):
        self.remove_limit = 1
        targets = list(self.tags)
        report = self.retire()
        self.assertEqual(report["status"], "failed")
        self.assertEqual(report["outcome"], "partial")
        self.assertEqual(report["tags"]["removed"], targets[:1])
        self.assertEqual(report["tags"]["remaining"], targets[1:])
        self.assertFalse(report["dockerRemoveSucceeded"])


if __name__ == "__main__":
    unittest.main()
