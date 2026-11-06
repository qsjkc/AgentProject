"""Bind a Docker image archive and running containers to one verified source SHA.

Only stdlib is required on the deployment host. Archives are inspected in memory,
never extracted. Docker inspection output is reduced to non-secret provenance.
"""
import argparse
import hashlib
import json
import os
from pathlib import Path
import re
import subprocess
import sys
import tarfile
import tempfile


SERVICES = ("backend", "nginx", "agent-server")
ARCHIVE_NAME = "server-images.tar.gz"
MANIFEST_NAME = "server-images.json"
REVISION_LABEL = "org.opencontainers.image.revision"


def validate_source_commit(value):
    if not isinstance(value, str) or not re.fullmatch(r"[0-9a-f]{40}", value):
        raise ValueError("A full lowercase source commit SHA is required")
    return value


def image_tags(source_commit):
    validate_source_commit(source_commit)
    return {service: f"agentproject-{service}:sha-{source_commit}" for service in SERVICES}


def file_digest(path):
    digest = hashlib.sha256()
    with Path(path).open("rb") as stream:
        for chunk in iter(lambda: stream.read(1024 * 1024), b""):
            digest.update(chunk)
    return digest.hexdigest()


def inspect_docker_image(tag):
    return json.loads(subprocess.check_output(
        ["docker", "image", "inspect", tag], text=True
    ))[0]


def config_revision(config):
    if not isinstance(config, dict) or not isinstance(config.get("Labels"), dict):
        return None
    return config["Labels"].get(REVISION_LABEL)


def validate_manifest(manifest, source_commit):
    tags = image_tags(source_commit)
    if not isinstance(manifest, dict) or type(manifest.get("schemaVersion")) is not int or manifest["schemaVersion"] != 1:
        raise ValueError("Unsupported image manifest schema")
    if manifest.get("sourceCommit") != source_commit:
        raise ValueError("Image manifest source commit does not match the deployment")
    if manifest.get("filename") != ARCHIVE_NAME:
        raise ValueError("Unexpected image archive filename")
    if type(manifest.get("bytes")) is not int or manifest["bytes"] <= 0:
        raise ValueError("Image archive bytes must be a positive integer")
    if not isinstance(manifest.get("sha256"), str) or not re.fullmatch(r"[0-9a-f]{64}", manifest["sha256"]):
        raise ValueError("Invalid image archive SHA-256")
    images = manifest.get("images")
    if not isinstance(images, list) or len(images) != len(SERVICES):
        raise ValueError("Exactly three application images are required")
    seen = set()
    for entry in images:
        if not isinstance(entry, dict):
            raise ValueError("Invalid image entry")
        service = entry.get("service")
        if not isinstance(service, str) or service not in tags or service in seen:
            raise ValueError("Unknown or duplicate image service")
        seen.add(service)
        if entry.get("tag") != tags[service] or entry.get("revision") != source_commit:
            raise ValueError("Image tag or revision does not match the source commit")
        if not isinstance(entry.get("id"), str) or not re.fullmatch(r"sha256:[0-9a-f]{64}", entry["id"]):
            raise ValueError("Invalid Docker image ID")
        if entry.get("os") != "linux" or entry.get("architecture") != "amd64":
            raise ValueError("Only linux/amd64 release images are accepted")
    return manifest


def verify_archive(path, images):
    """Check saved tags and image config digests/platforms before docker load."""
    configs = {}
    wanted = {}
    for entry in images:
        digest = entry["id"].split(":", 1)[1]
        wanted[f"{digest}.json"] = entry
        wanted[f"blobs/sha256/{digest}"] = entry
    archive_manifest = None
    seen_members = set()
    with tarfile.open(path, "r|gz") as archive:
        for member in archive:
            if member.name != "manifest.json" and member.name not in wanted:
                continue
            if member.name in seen_members or not member.isfile() or member.size > 2 * 1024 * 1024:
                raise ValueError("Invalid or duplicated archive metadata")
            seen_members.add(member.name)
            content = archive.extractfile(member).read()
            if member.name == "manifest.json":
                archive_manifest = json.loads(content)
            else:
                entry = wanted[member.name]
                if "sha256:" + hashlib.sha256(content).hexdigest() != entry["id"]:
                    raise ValueError("Archived image config does not match its image ID")
                config = json.loads(content)
                if config.get("os") != entry["os"] or config.get("architecture") != entry["architecture"]:
                    raise ValueError("Archived image platform does not match the manifest")
                if config_revision(config.get("config")) != entry["revision"]:
                    raise ValueError("Archived image revision does not match the source commit")
                configs[member.name] = entry
    if not isinstance(archive_manifest, list) or len(archive_manifest) != len(images):
        raise ValueError("Archive must contain exactly three application images")
    saved_tags = set()
    for saved in archive_manifest:
        if not isinstance(saved, dict) or not isinstance(saved.get("Config"), str):
            raise ValueError("Invalid saved image metadata")
        entry = configs.get(saved["Config"])
        if entry is None or saved.get("RepoTags") != [entry["tag"]] or entry["tag"] in saved_tags:
            raise ValueError("Archive contains unexpected, missing, or duplicate image tags")
        saved_tags.add(entry["tag"])
    if saved_tags != {entry["tag"] for entry in images}:
        raise ValueError("Archive image set does not match the release")


def create_manifest(directory, source_commit, inspect_image=inspect_docker_image):
    validate_source_commit(source_commit)
    directory = Path(directory)
    archive = directory / ARCHIVE_NAME
    if archive.is_symlink() or not archive.is_file() or archive.stat().st_size <= 0:
        raise ValueError("Image archive must be a non-empty regular file")
    images = []
    for service, tag in image_tags(source_commit).items():
        actual = inspect_image(tag)
        images.append({"service": service, "tag": tag, "id": actual.get("Id"),
                       "os": actual.get("Os"), "architecture": actual.get("Architecture"),
                       "revision": config_revision(actual.get("Config"))})
    manifest = {"schemaVersion": 1, "sourceCommit": source_commit, "filename": ARCHIVE_NAME,
                "bytes": archive.stat().st_size, "sha256": file_digest(archive), "images": images}
    verify_manifest(directory, manifest, source_commit)
    (directory / MANIFEST_NAME).write_text(json.dumps(manifest, indent=2) + "\n", encoding="utf-8")
    return manifest


def verify_manifest(directory, manifest, source_commit):
    validate_manifest(manifest, source_commit)
    archive = Path(directory) / ARCHIVE_NAME
    if archive.is_symlink() or not archive.is_file() or archive.stat().st_size != manifest["bytes"]:
        raise ValueError("Image archive is missing or its byte size differs")
    if file_digest(archive) != manifest["sha256"]:
        raise ValueError("Image archive SHA-256 differs from the manifest")
    verify_archive(archive, manifest["images"])
    return manifest


def verify_loaded_images(manifest, inspect_image=inspect_docker_image):
    validate_manifest(manifest, manifest.get("sourceCommit"))
    for entry in manifest["images"]:
        actual = inspect_image(entry["tag"])
        revision = config_revision(actual.get("Config"))
        if (actual.get("Id"), actual.get("Os"), actual.get("Architecture"), revision) != (
            entry["id"], entry["os"], entry["architecture"], entry["revision"]
        ):
            raise ValueError(f"Loaded image differs from verified release: {entry['service']}")
    return {"status": "passed", "sourceCommit": manifest["sourceCommit"], "images": manifest["images"]}


def write_compose_overrides(directory, manifest, inspect_image=inspect_docker_image):
    verify_loaded_images(manifest, inspect_image)
    images = {entry["service"]: {"image": entry["tag"]} for entry in manifest["images"]}
    for filename, services in (("main.compose.json", ("backend", "nginx")),
                               ("agent.compose.json", ("agent-server",))):
        (Path(directory) / filename).write_text(json.dumps(
            {"services": {service: images[service] for service in services}}, indent=2
        ) + "\n", encoding="utf-8")


def managed_default_override(source_commit, services):
    tags = image_tags(source_commit)
    return {"x-agentproject-source-commit": source_commit, "services": {
        service: {"image": tags[service], "pull_policy": "never"} for service in services
    }}


def install_default_overrides(project_directory, release_directory, manifest, inspect_image=inspect_docker_image):
    """Keep ordinary `docker compose up -d` on the verified release as well.

    Validate both existing files before touching either. Never overwrite a user
    override or replace the first pre-release snapshot when retrying a release.
    """
    verify_loaded_images(manifest, inspect_image)
    source = manifest["sourceCommit"]
    project_directory = Path(project_directory)
    release_directory = Path(release_directory)
    plans = []
    previous = {"schemaVersion": 1, "sourceCommit": source}
    for name, directory, services in (
        ("main", project_directory, ("backend", "nginx")),
        ("agent", project_directory / "agent-server", ("agent-server",)),
    ):
        if not directory.is_dir():
            raise ValueError(f"Missing compose project directory: {name}")
        target = directory / "docker-compose.override.yml"
        for filename in ("compose.override.yaml", "compose.override.yml", "docker-compose.override.yaml"):
            candidate = directory / filename
            if candidate.exists() or candidate.is_symlink():
                raise ValueError(f"Unmanaged compose override exists: {candidate.name} ({name})")
        old = None
        if target.exists() or target.is_symlink():
            if target.is_symlink() or not target.is_file():
                raise ValueError(f"Unmanaged compose override exists: {name}")
            try:
                old = json.loads(target.read_text(encoding="utf-8"))
                if not isinstance(old, dict) or old != managed_default_override(
                    old.get("x-agentproject-source-commit"), services
                ):
                    raise ValueError("modified override")
            except (ValueError, TypeError):
                raise ValueError(f"Refusing to replace an unmanaged compose override: {name}") from None
        previous[name] = old
        plans.append((target, managed_default_override(source, services)))
    snapshot = release_directory / "previous-overrides.json"
    if snapshot.exists():
        saved = json.loads(snapshot.read_text(encoding="utf-8"))
        if saved.get("schemaVersion") != 1 or saved.get("sourceCommit") != source:
            raise ValueError("Previous override snapshot does not match this release")
    else:
        with snapshot.open("x", encoding="utf-8") as stream:
            stream.write(json.dumps(previous, indent=2) + "\n")
    temporary = []
    try:
        for target, payload in plans:
            with tempfile.NamedTemporaryFile(mode="w", encoding="utf-8", dir=target.parent,
                                             prefix=".agentproject-override-", delete=False) as stream:
                temporary.append((Path(stream.name), target))
                stream.write(json.dumps(payload, indent=2) + "\n")
        for staged, target in temporary:
            os.replace(staged, target)
    finally:
        for staged, _target in temporary:
            staged.unlink(missing_ok=True)
    return {"status": "passed", "sourceCommit": source, "defaultOverridesInstalled": True}


def verify_running_images(manifest):
    report = verify_loaded_images(manifest)
    containers = []
    for entry in manifest["images"]:
        name = f"agentproject-{entry['service']}"
        actual = json.loads(subprocess.check_output(["docker", "container", "inspect", name], text=True))[0]
        revision = config_revision(actual.get("Config"))
        if actual.get("Image") != entry["id"] or revision != entry["revision"] or actual.get("State", {}).get("Running") is not True:
            raise ValueError(f"Running container differs from verified release: {name}")
        containers.append({"service": entry["service"], "container": name,
                           "imageId": actual["Image"], "sourceCommit": revision, "running": True})
    report["containers"] = containers
    return report


def main():
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument("action", choices=("create", "verify", "inspect", "compose", "activate"))
    parser.add_argument("--directory", type=Path, required=True)
    parser.add_argument("--source-commit", required=True)
    parser.add_argument("--running", action="store_true")
    parser.add_argument("--project-directory", type=Path)
    args = parser.parse_args()
    if args.action == "create":
        result = create_manifest(args.directory, args.source_commit)
    else:
        manifest = json.loads((args.directory / MANIFEST_NAME).read_text(encoding="utf-8"))
        validate_manifest(manifest, args.source_commit)
        if args.action == "verify":
            result = verify_manifest(args.directory, manifest, args.source_commit)
        elif args.action == "compose":
            write_compose_overrides(args.directory, manifest)
            result = {"status": "passed", "sourceCommit": args.source_commit}
        elif args.action == "activate":
            if args.project_directory is None:
                raise ValueError("Activating default overrides requires --project-directory")
            result = install_default_overrides(args.project_directory, args.directory, manifest)
        else:
            result = verify_running_images(manifest) if args.running else verify_loaded_images(manifest)
    print(json.dumps({"status": "passed", **result}))


if __name__ == "__main__":
    try:
        main()
    except Exception as error:
        print(json.dumps({"status": "failed", "error": str(error)}))
        sys.exit(1)
