"""Release image provenance checks without a Docker daemon or production data."""
import copy
import hashlib
import io
import json
import os
from pathlib import Path
import re
import shutil
import subprocess
import tarfile
import tempfile
import textwrap
import unittest
from unittest.mock import Mock, patch

import server_images


class ServerImageManifestTests(unittest.TestCase):
    SOURCE_SHA = "a" * 40
    OTHER_SHA = "b" * 40
    SERVICES = ("backend", "nginx", "agent-server")

    def setUp(self):
        self.temp = tempfile.TemporaryDirectory()
        self.addCleanup(self.temp.cleanup)
        self.directory = Path(self.temp.name)
        self.archive = self.directory / "server-images.tar.gz"
        self.tags = {
            service: f"agentproject-{service}:sha-{self.SOURCE_SHA}"
            for service in self.SERVICES
        }
        self.configs = {
            service: json.dumps({
                "architecture": "amd64", "os": "linux",
                "config": {"Labels": {
                    "org.opencontainers.image.revision": self.SOURCE_SHA,
                    "test.service": service,
                }},
                "rootfs": {"type": "layers", "diff_ids": []},
            }, sort_keys=True).encode()
            for service in self.SERVICES
        }
        self.inspected = {
            self.tags[service]: {
                "Id": "sha256:" + hashlib.sha256(self.configs[service]).hexdigest(),
                "Os": "linux",
                "Architecture": "amd64",
                "Config": {"Labels": {"org.opencontainers.image.revision": self.SOURCE_SHA}},
            }
            for service in self.SERVICES
        }
        self.entries = [{
            "Config": hashlib.sha256(self.configs[service]).hexdigest() + ".json",
            "RepoTags": [self.tags[service]], "Layers": [],
        } for service in self.SERVICES]
        self.write_archive()

    def write_archive(self, entries=None, configs=None):
        entries = self.entries if entries is None else entries
        configs = {
            hashlib.sha256(content).hexdigest() + ".json": content
            for content in self.configs.values()
        } if configs is None else configs
        with tarfile.open(self.archive, "w:gz") as archive:
            for name, content in {"manifest.json": json.dumps(entries).encode(), **configs}.items():
                member = tarfile.TarInfo(name)
                member.size = len(content)
                archive.addfile(member, io.BytesIO(content))

    def refresh_archive_checksum(self, manifest):
        return {**manifest, "bytes": self.archive.stat().st_size,
                "sha256": hashlib.sha256(self.archive.read_bytes()).hexdigest()}

    def inspector(self):
        return Mock(side_effect=lambda tag: copy.deepcopy(self.inspected[tag]))

    def manifest(self):
        return server_images.create_manifest(
            self.directory, self.SOURCE_SHA, inspect_image=self.inspector()
        )

    def test_archive_and_all_three_images_are_bound_to_the_full_source_sha(self):
        inspect = self.inspector()
        manifest = server_images.create_manifest(
            self.directory, self.SOURCE_SHA, inspect_image=inspect
        )
        self.assertEqual(manifest["schemaVersion"], 1)
        self.assertEqual(manifest["sourceCommit"], self.SOURCE_SHA)
        self.assertEqual(manifest["filename"], self.archive.name)
        self.assertEqual(manifest["bytes"], self.archive.stat().st_size)
        self.assertEqual(manifest["sha256"], hashlib.sha256(self.archive.read_bytes()).hexdigest())
        self.assertEqual({call.args[0] for call in inspect.call_args_list}, set(self.tags.values()))
        self.assertEqual(len(manifest["images"]), 3)
        images = {item["service"]: item for item in manifest["images"]}
        self.assertEqual(set(images), set(self.SERVICES))
        for service, image in images.items():
            self.assertEqual(image["tag"], self.tags[service])
            self.assertEqual(image["id"], self.inspected[image["tag"]]["Id"])
            self.assertEqual(image["revision"], self.SOURCE_SHA)
            self.assertEqual((image["os"], image["architecture"]), ("linux", "amd64"))
        self.assertEqual(
            server_images.verify_manifest(self.directory, manifest, self.SOURCE_SHA), manifest
        )
        server_images.verify_loaded_images(manifest, inspect_image=self.inspector())

    def test_invalid_or_abbreviated_source_is_rejected_before_inspecting_docker(self):
        for source in ("main", "a" * 7, "a" * 39, "a" * 41, "A" * 40, "../release", None):
            inspect = self.inspector()
            with self.subTest(source=source), self.assertRaises((ValueError, TypeError)):
                server_images.create_manifest(self.directory, source, inspect_image=inspect)
            inspect.assert_not_called()

    def test_missing_empty_or_non_regular_archive_is_rejected(self):
        self.archive.unlink()
        with self.assertRaises((ValueError, FileNotFoundError)):
            self.manifest()
        self.archive.touch()
        with self.assertRaises(ValueError):
            self.manifest()
        self.archive.unlink()
        self.archive.mkdir()
        with self.assertRaises(ValueError):
            self.manifest()

    def test_archive_changed_after_manifest_creation_is_rejected_even_at_same_size(self):
        manifest = self.manifest()
        original = self.archive.read_bytes()
        self.archive.write_bytes(b"X" + original[1:])
        with self.assertRaises(ValueError):
            server_images.verify_manifest(self.directory, manifest, self.SOURCE_SHA)

    def test_manifest_source_hash_size_schema_and_filename_must_match(self):
        original = self.manifest()
        changes = (
            ("sourceCommit", self.OTHER_SHA), ("filename", "../server-images.tar.gz"),
            ("filename", "other.tar.gz"), ("sha256", "0" * 64),
            ("bytes", original["bytes"] + 1), ("bytes", str(original["bytes"])),
            ("bytes", True), ("schemaVersion", 2),
        )
        for key, value in changes:
            with self.subTest(key=key, value=value), self.assertRaises(ValueError):
                server_images.verify_manifest(
                    self.directory, {**original, key: value}, self.SOURCE_SHA
                )
        with self.assertRaises(ValueError):
            server_images.verify_manifest(self.directory, original, self.OTHER_SHA)

    def test_manifest_requires_exactly_one_of_each_application_image(self):
        original = self.manifest()
        valid_images = original["images"]
        cases = (
            [], valid_images[:-1], valid_images + [valid_images[0]],
            [valid_images[0], valid_images[0], valid_images[1]],
            [{**valid_images[0], "service": "postgres"}, *valid_images[1:]],
        )
        for images in cases:
            with self.subTest(images=images), self.assertRaises(ValueError):
                server_images.verify_manifest(
                    self.directory, {**original, "images": images}, self.SOURCE_SHA
                )

    def test_manifest_rejects_wrong_tag_id_revision_or_platform(self):
        original = self.manifest()
        mutations = (
            ("tag", "agentproject-backend:latest"),
            ("tag", f"agentproject-backend:sha-{self.OTHER_SHA}"),
            ("id", "sha256:short"), ("revision", self.OTHER_SHA),
            ("os", "windows"), ("architecture", "arm64"),
        )
        for key, value in mutations:
            manifest = copy.deepcopy(original)
            manifest["images"][0][key] = value
            with self.subTest(key=key, value=value), self.assertRaises(ValueError):
                server_images.verify_manifest(self.directory, manifest, self.SOURCE_SHA)

    def test_create_checks_actual_image_revision_platform_and_id(self):
        tag = self.tags["backend"]
        original = copy.deepcopy(self.inspected[tag])
        mutations = (
            {**original, "Id": "invalid"}, {**original, "Os": "windows"},
            {**original, "Architecture": "arm64"}, {**original, "Config": {}},
            {**original, "Config": {"Labels": {"org.opencontainers.image.revision": self.OTHER_SHA}}},
        )
        for metadata in mutations:
            self.inspected[tag] = metadata
            with self.subTest(metadata=metadata), self.assertRaises(ValueError):
                self.manifest()

    def test_loaded_tags_must_resolve_to_the_manifest_image_ids_and_metadata(self):
        manifest = self.manifest()
        tag = self.tags["nginx"]
        original = copy.deepcopy(self.inspected[tag])
        mutations = (
            {**original, "Id": "sha256:" + "f" * 64},
            {**original, "Os": "windows"}, {**original, "Architecture": "arm64"},
            {**original, "Config": {"Labels": {"org.opencontainers.image.revision": self.OTHER_SHA}}},
            {**original, "Config": {"Labels": None}},
        )
        for metadata in mutations:
            self.inspected[tag] = metadata
            with self.subTest(metadata=metadata), self.assertRaises(ValueError):
                server_images.verify_loaded_images(manifest, inspect_image=self.inspector())

    def test_missing_loaded_image_stops_verification(self):
        manifest = self.manifest()
        inspect = Mock(side_effect=RuntimeError("image not found"))
        with self.assertRaises(RuntimeError):
            server_images.verify_loaded_images(manifest, inspect_image=inspect)

    def test_archive_tag_inventory_cannot_hide_extra_missing_or_different_images(self):
        manifest = self.manifest()
        mutations = [
            self.entries[:-1],
            self.entries + [{**self.entries[0], "RepoTags": ["unrelated:latest"]}],
            [{**self.entries[0], "RepoTags": ["unrelated:latest"]}, *self.entries[1:]],
            [{**self.entries[0], "RepoTags": [self.tags["backend"], "unrelated:latest"]},
             *self.entries[1:]],
        ]
        for entries in mutations:
            self.write_archive(entries=entries)
            with self.subTest(entries=entries), self.assertRaises(ValueError):
                server_images.verify_manifest(
                    self.directory, self.refresh_archive_checksum(manifest), self.SOURCE_SHA
                )

    def test_archive_configuration_must_exist_and_hash_to_the_recorded_image_id(self):
        manifest = self.manifest()
        configs = {
            hashlib.sha256(content).hexdigest() + ".json": content
            for content in self.configs.values()
        }
        backend_config = self.entries[0]["Config"]
        mutations = [
            {name: content for name, content in configs.items() if name != backend_config},
            {**configs, backend_config: b'{}'},
        ]
        for updated in mutations:
            self.write_archive(configs=updated)
            with self.subTest(configs=list(updated)), self.assertRaises(ValueError):
                server_images.verify_manifest(
                    self.directory, self.refresh_archive_checksum(manifest), self.SOURCE_SHA
                )

    def test_docker_oci_blob_paths_are_supported_without_extracting_the_archive(self):
        entries = []
        configs = {}
        for service in self.SERVICES:
            content = self.configs[service]
            name = "blobs/sha256/" + hashlib.sha256(content).hexdigest()
            configs[name] = content
            entries.append({"Config": name, "RepoTags": [self.tags[service]], "Layers": []})
        self.write_archive(entries=entries, configs=configs)
        manifest = self.manifest()
        server_images.verify_manifest(self.directory, manifest, self.SOURCE_SHA)
        self.assertFalse((self.directory / "blobs").exists())

    def test_duplicate_archive_manifest_is_rejected(self):
        manifest = self.manifest()
        members = [("manifest.json", json.dumps(self.entries).encode())] * 2
        members.extend((hashlib.sha256(content).hexdigest() + ".json", content)
                       for content in self.configs.values())
        with tarfile.open(self.archive, "w:gz") as archive:
            for name, content in members:
                member = tarfile.TarInfo(name)
                member.size = len(content)
                archive.addfile(member, io.BytesIO(content))
        with self.assertRaises(ValueError):
            server_images.verify_manifest(
                self.directory, self.refresh_archive_checksum(manifest), self.SOURCE_SHA
            )

    def test_archive_configuration_platform_and_revision_are_verified_independently(self):
        original = json.loads(self.configs["backend"])
        mutations = [
            {**original, "architecture": "arm64"},
            {**original, "os": "windows"},
            {**original, "config": {"Labels": {"org.opencontainers.image.revision": self.OTHER_SHA}}},
        ]
        for config in mutations:
            self.configs["backend"] = json.dumps(config, sort_keys=True).encode()
            digest = hashlib.sha256(self.configs["backend"]).hexdigest()
            self.inspected[self.tags["backend"]]["Id"] = "sha256:" + digest
            self.entries[0]["Config"] = digest + ".json"
            self.write_archive()
            with self.subTest(config=config), self.assertRaises(ValueError):
                self.manifest()

    def test_compose_overrides_use_only_verified_images_and_do_not_change_postgres(self):
        manifest = self.manifest()
        inspect = self.inspector()
        server_images.write_compose_overrides(self.directory, manifest, inspect_image=inspect)
        self.assertEqual(inspect.call_count, 3)
        main = json.loads((self.directory / "main.compose.json").read_text())
        agent = json.loads((self.directory / "agent.compose.json").read_text())
        self.assertEqual(main, {"services": {
            service: {"image": self.tags[service]} for service in ("backend", "nginx")
        }})
        self.assertEqual(agent, {"services": {"agent-server": {"image": self.tags["agent-server"]}}})

    def test_last_image_failure_does_not_write_partial_compose_overrides(self):
        manifest = self.manifest()
        self.inspected[self.tags["agent-server"]]["Id"] = "sha256:" + "f" * 64
        with self.assertRaises(ValueError):
            server_images.write_compose_overrides(self.directory, manifest, inspect_image=self.inspector())
        self.assertFalse((self.directory / "main.compose.json").exists())
        self.assertFalse((self.directory / "agent.compose.json").exists())

    def test_invalid_manifest_is_rejected_before_docker_inspection_or_override_creation(self):
        manifest = self.manifest()
        manifest["images"][0]["tag"] = "agentproject-backend:latest"
        inspect = self.inspector()
        with self.assertRaises(ValueError):
            server_images.write_compose_overrides(self.directory, manifest, inspect_image=inspect)
        inspect.assert_not_called()
        self.assertFalse((self.directory / "main.compose.json").exists())
        self.assertFalse((self.directory / "agent.compose.json").exists())

    def runtime_project(self):
        project = self.directory / "runtime"
        (project / "agent-server").mkdir(parents=True)
        return project

    def next_release(self, original):
        manifest = copy.deepcopy(original)
        manifest["sourceCommit"] = self.OTHER_SHA
        inspected = {}
        for entry in manifest["images"]:
            config = json.loads(self.configs[entry["service"]])
            config["config"]["Labels"]["org.opencontainers.image.revision"] = self.OTHER_SHA
            entry["id"] = "sha256:" + hashlib.sha256(json.dumps(config, sort_keys=True).encode()).hexdigest()
            entry["revision"] = self.OTHER_SHA
            entry["tag"] = f"agentproject-{entry['service']}:sha-{self.OTHER_SHA}"
            inspected[entry["tag"]] = {
                "Id": entry["id"], "Os": "linux", "Architecture": "amd64",
                "Config": {"Labels": {"org.opencontainers.image.revision": self.OTHER_SHA}},
            }
        release = self.directory / "next-release"
        release.mkdir()
        return release, manifest, Mock(side_effect=lambda tag: copy.deepcopy(inspected[tag]))

    def test_default_overrides_persist_verified_tags_and_never_pull(self):
        project = self.runtime_project()
        manifest = self.manifest()
        server_images.install_default_overrides(project, self.directory, manifest, inspect_image=self.inspector())
        for folder, services in ((project, ("backend", "nginx")),
                                 (project / "agent-server", ("agent-server",))):
            override = json.loads((folder / "docker-compose.override.yml").read_text())
            self.assertEqual(override["x-agentproject-source-commit"], self.SOURCE_SHA)
            self.assertEqual(override["services"], {
                service: {"image": self.tags[service], "pull_policy": "never"} for service in services
            })
        snapshot = json.loads((self.directory / "previous-overrides.json").read_text())
        self.assertIsNone(snapshot["main"])
        self.assertIsNone(snapshot["agent"])

    def test_unknown_default_override_stops_before_changing_either_project(self):
        project = self.runtime_project()
        manifest = self.manifest()
        custom = project / "agent-server/docker-compose.override.yml"
        custom.write_text("services:\n  agent-server:\n    environment:\n      KEEP: custom\n")
        before = custom.read_bytes()
        with self.assertRaises(ValueError):
            server_images.install_default_overrides(
                project, self.directory, manifest, inspect_image=self.inspector()
            )
        self.assertEqual(custom.read_bytes(), before)
        self.assertFalse((project / "docker-compose.override.yml").exists())
        self.assertFalse((self.directory / "previous-overrides.json").exists())

    def test_customized_managed_override_is_preserved_and_blocks_replacement(self):
        project = self.runtime_project()
        manifest = self.manifest()
        server_images.install_default_overrides(project, self.directory, manifest, inspect_image=self.inspector())
        main = project / "docker-compose.override.yml"
        agent = project / "agent-server/docker-compose.override.yml"
        custom = json.loads(agent.read_text())
        custom["services"]["agent-server"]["environment"] = {"KEEP": "custom"}
        agent.write_text(json.dumps(custom))
        originals = (main.read_bytes(), agent.read_bytes())
        release, following, inspect = self.next_release(manifest)
        with self.assertRaises(ValueError):
            server_images.install_default_overrides(project, release, following, inspect_image=inspect)
        self.assertEqual((main.read_bytes(), agent.read_bytes()), originals)
        self.assertFalse((release / "previous-overrides.json").exists())

    def test_later_release_and_same_release_retry_preserve_original_override_snapshot(self):
        project = self.runtime_project()
        manifest = self.manifest()
        server_images.install_default_overrides(project, self.directory, manifest, inspect_image=self.inspector())
        originals = {
            "main": json.loads((project / "docker-compose.override.yml").read_text()),
            "agent": json.loads((project / "agent-server/docker-compose.override.yml").read_text()),
        }
        release, following, inspect = self.next_release(manifest)
        server_images.install_default_overrides(project, release, following, inspect_image=inspect)
        snapshot_path = release / "previous-overrides.json"
        snapshot_bytes = snapshot_path.read_bytes()
        snapshot = json.loads(snapshot_bytes)
        self.assertEqual(snapshot["sourceCommit"], self.OTHER_SHA)
        self.assertEqual({key: snapshot[key] for key in originals}, originals)
        server_images.install_default_overrides(project, release, following, inspect_image=inspect)
        self.assertEqual(snapshot_path.read_bytes(), snapshot_bytes)
        for folder in (project, project / "agent-server"):
            override = json.loads((folder / "docker-compose.override.yml").read_text())
            self.assertEqual(override["x-agentproject-source-commit"], self.OTHER_SHA)

    def test_plain_docker_compose_automatically_resolves_persisted_release_images(self):
        docker = shutil.which("docker")
        if not docker:
            self.skipTest("Docker Compose CLI is required; no Docker daemon is used")
        available = subprocess.run([docker, "compose", "version"], capture_output=True, text=True, timeout=15)
        if available.returncode:
            self.skipTest("Docker Compose plugin is unavailable")
        project = self.runtime_project()
        repository = Path(__file__).resolve().parents[1]
        for relative in (Path("."), Path("agent-server")):
            shutil.copyfile(repository / relative / "docker-compose.yml", project / relative / "docker-compose.yml")
            (project / relative / ".env").write_text("")
        server_images.install_default_overrides(
            project, self.directory, self.manifest(), inspect_image=self.inspector()
        )
        for folder, services in ((project, ("backend", "nginx")),
                                 (project / "agent-server", ("agent-server",))):
            result = subprocess.run([docker, "compose", "config", "--images"], cwd=folder,
                                    capture_output=True, text=True, timeout=30)
            self.assertEqual(result.returncode, 0, result.stderr)
            images = set(result.stdout.splitlines())
            for service in services:
                self.assertIn(self.tags[service], images)
            application_images = {image for image in images if image.startswith("agentproject-")}
            self.assertEqual(application_images, {self.tags[service] for service in services})

    def container_inspector(self):
        containers = {
            f"agentproject-{service}": {
                "Image": self.inspected[self.tags[service]]["Id"],
                "Config": {
                    "Labels": {"org.opencontainers.image.revision": self.SOURCE_SHA},
                    "Env": ["PRIVATE_TOKEN=must-not-be-in-report"],
                },
                "State": {"Running": True},
            }
            for service in self.SERVICES
        }

        def output(command, **_kwargs):
            if command[:3] == ["docker", "image", "inspect"]:
                result = self.inspected[command[3]]
            elif command[:3] == ["docker", "container", "inspect"]:
                result = containers[command[3]]
            else:
                raise AssertionError(f"Unexpected Docker mutation: {command}")
            return json.dumps([result])

        return containers, output

    def test_running_provenance_requires_all_expected_containers_and_omits_runtime_secrets(self):
        manifest = self.manifest()
        _containers, output = self.container_inspector()
        with patch("server_images.subprocess.check_output", side_effect=output) as command:
            result = server_images.verify_running_images(manifest)
        self.assertEqual(result["status"], "passed")
        self.assertEqual(result["sourceCommit"], self.SOURCE_SHA)
        self.assertEqual({entry["container"] for entry in result["containers"]}, {
            f"agentproject-{service}" for service in self.SERVICES
        })
        self.assertEqual(command.call_count, 6)
        self.assertNotIn("PRIVATE_TOKEN", json.dumps(result))
        self.assertNotIn("must-not-be-in-report", json.dumps(result))

    def test_running_provenance_rejects_old_stopped_or_mislabelled_containers(self):
        manifest = self.manifest()
        changes = [
            {"Image": "sha256:" + "f" * 64},
            {"State": {"Running": False}},
            {"Config": {"Labels": {"org.opencontainers.image.revision": self.OTHER_SHA}}},
        ]
        for change in changes:
            containers, output = self.container_inspector()
            containers["agentproject-agent-server"].update(change)
            with self.subTest(change=change), patch(
                "server_images.subprocess.check_output", side_effect=output
            ), self.assertRaises(ValueError):
                server_images.verify_running_images(manifest)


class RemoteImageDeploymentTests(unittest.TestCase):
    SOURCE_SHA = "a" * 40

    @classmethod
    def setUpClass(cls):
        cls.workflow = (Path(__file__).resolve().parents[1] / ".github/workflows/cd.yml").read_text()
        cls.bash = shutil.which("bash")
        if os.name == "nt" and shutil.which("git"):
            git_bash = Path(shutil.which("git")).resolve().parents[1] / "bin/bash.exe"
            if git_bash.is_file():
                cls.bash = str(git_bash)

    def remote_script(self, marker):
        match = re.search(rf"<<'{marker}'\n(.*?)^\s*{marker}\s*$", self.workflow, re.M | re.S)
        self.assertIsNotNone(match, marker)
        return textwrap.dedent(match.group(1))

    def execute(self, marker, failure=""):
        if not self.bash:
            self.skipTest("Bash is required to execute remote deployment guards")
        # Every filesystem operation is restricted to this test's disposable tree.
        # Docker, Python deployment commands and network requests are intercepted.
        mocks = r'''
python3() {
  printf 'python3:%s\n' "$2" >> "$TEST_LOG"
  if [[ "$TEST_FAIL" == "$2" ]]; then return 41; fi
  printf '{}\n'
}
docker() {
  printf 'docker:%s\n' "$*" >> "$TEST_LOG"
  if [[ "$TEST_FAIL" == load && "$1 $2" == 'image load' ]]; then return 42; fi
  return 0
}
curl() { printf 'curl\n' >> "$TEST_LOG"; }
rm() { printf 'rm\n' >> "$TEST_LOG"; command rm "$@"; }
'''
        with tempfile.TemporaryDirectory() as name:
            root = Path(name)
            release = root / f".server-images-{self.SOURCE_SHA}"
            release.mkdir()
            archive = release / "server-images.tar.gz"
            archive.write_bytes(b"stub-archive")
            (root / "agent-server").mkdir()
            download = root / "data/downloads"
            download.mkdir(parents=True)
            installer = b"stub-installer"
            filename = "Detachym-1.1.0-rc.5-x64.exe"
            (download / f".{filename}.{self.SOURCE_SHA}.upload").write_bytes(installer)
            (root / ".env").write_text(
                "VOLC_AGENT_API_KEY=synthetic-agent-key\n"
                "BACKEND_INTERNAL_API_KEY=synthetic-backend-key\n"
                "WEB_APP_URL=https://example.test\n"
                "VOLC_AGENT_CHAT_COMPLETIONS_URL=https://example.test/agent/v1/chat/completions\n"
                "UNRELATED_SETTING=keep-me\n"
            )
            log = root / "commands.log"
            env = {**os.environ, "DEPLOY_SOURCE_SHA": self.SOURCE_SHA,
                   "TEST_LOG": log.as_posix(), "TEST_FAIL": failure,
                   "DESKTOP_RELEASE_VERSION": "1.1.0-rc.5", "DESKTOP_RELEASE_FILE": filename,
                   "DESKTOP_RELEASE_BYTES": str(len(installer)),
                   "DESKTOP_RELEASE_SHA256": hashlib.sha256(installer).hexdigest(),
                   "PUBLIC_DEPLOY_HOST": "example.test"}
            result = subprocess.run([self.bash, "--noprofile", "--norc"],
                                    input=mocks + self.remote_script(marker), text=True,
                                    capture_output=True, cwd=root, env=env, timeout=20)
            calls = log.read_text().splitlines() if log.exists() else []
            archive_exists = archive.exists()
            runtime_env = (root / ".env").read_text()
        return result, calls, archive_exists, runtime_env

    def test_archive_verification_failure_never_loads_images(self):
        result, calls, exists, _ = self.execute("REMOTE_IMAGES", "verify")
        self.assertNotEqual(result.returncode, 0)
        self.assertEqual(calls, ["python3:verify"])
        self.assertTrue(exists)

    def test_load_or_loaded_image_failure_stops_before_archive_removal(self):
        for failure in ("load", "compose"):
            with self.subTest(failure=failure):
                result, calls, exists, _ = self.execute("REMOTE_IMAGES", failure)
                self.assertNotEqual(result.returncode, 0)
                self.assertEqual(calls[0], "python3:verify")
                self.assertTrue(calls[1].startswith("docker:image load --input "))
                self.assertNotIn("rm", calls)
                if failure == "load":
                    self.assertNotIn("python3:compose", calls)
                self.assertTrue(exists)

    def test_successful_load_verifies_before_loading_and_removes_only_uploaded_archive(self):
        result, calls, exists, _ = self.execute("REMOTE_IMAGES")
        self.assertEqual(result.returncode, 0, result.stderr)
        self.assertEqual(calls[0], "python3:verify")
        self.assertTrue(calls[1].startswith("docker:image load --input "))
        self.assertEqual(calls[2:], ["python3:compose", "rm"])
        self.assertFalse(exists)

    def test_last_inspection_failure_does_not_switch_any_containers(self):
        result, calls, _, _ = self.execute("REMOTE_DEPLOY", "inspect")
        self.assertNotEqual(result.returncode, 0)
        self.assertEqual(calls, ["python3:inspect"])

    def test_default_override_activation_failure_does_not_switch_any_containers(self):
        result, calls, _, _ = self.execute("REMOTE_DEPLOY", "activate")
        self.assertNotEqual(result.returncode, 0)
        self.assertEqual(calls, ["python3:inspect", "python3:activate"])

    def test_successful_deployment_uses_loaded_images_without_build_or_pull(self):
        result, calls, _, runtime_env = self.execute("REMOTE_DEPLOY")
        self.assertEqual(result.returncode, 0, result.stderr)
        starts = [call for call in calls if call.startswith("docker:compose ") and " up " in call]
        self.assertEqual(len(starts), 2)
        for call in starts:
            self.assertIn("--no-build --pull never", call)
            self.assertNotIn("--build", call)
        self.assertIn("main.compose.json", starts[0])
        self.assertIn("agent.compose.json", starts[1])
        self.assertEqual(calls[0], "python3:inspect")
        self.assertEqual(calls[1], "python3:activate")
        self.assertEqual(calls[-1], "python3:inspect")
        self.assertIn("UNRELATED_SETTING=keep-me", runtime_env)
        self.assertIn("BACKEND_INTERNAL_API_KEY=synthetic-backend-key", runtime_env)


if __name__ == "__main__":
    unittest.main()
