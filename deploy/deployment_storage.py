"""Report deployment storage or retire a verified, archived set of image tags."""

import argparse
import base64
import json
import os
from pathlib import Path
import re
import stat
import subprocess
import sys
import time


SOURCE = re.compile(r"[a-f0-9]{40}")
RUNTIME = re.compile(r"\.deploy-runtime-([a-f0-9]{40})\.tgz")
IMAGE_DIRECTORY = re.compile(r"\.server-images-([a-f0-9]{40})")
INSTALLER = re.compile(r"\.Detachym-[0-9]+\.[0-9]+\.[0-9]+(?:-(?:alpha|beta|rc)\.[0-9]+)?-x64\.exe\.([a-f0-9]{40})\.upload")
IMAGE_ID = re.compile(r"sha256:[a-f0-9]{64}")
DIGEST = re.compile(r"[a-f0-9]{64}")
DOCKER_SIZE = re.compile(r"[0-9]+(?:\.[0-9]+)?\s?(?:[kmgtpe]i?B|B)(?: \(\d+%\))?", re.IGNORECASE)
DOCKER_TYPES = {"Images", "Containers", "Local Volumes", "Build Cache"}
CONTAINERS = ("agentproject-backend", "agentproject-nginx", "agentproject-agent-server")
SERVICES = ("backend", "nginx", "agent-server")
REVISION_LABEL = "org.opencontainers.image.revision"
OVERRIDES = {
    "main": ("docker-compose.override.yml", ("backend", "nginx")),
    "agent": ("agent-server/docker-compose.override.yml", ("agent-server",)),
}
MAX_SCAN_ENTRIES = 4096
MAX_STAGED_FILES = 256
MAX_METADATA_BYTES = 65536
DOCKER_PROBE_TIMEOUT = 10
DOCKER_REMOVE_TIMEOUT = 90
MAX_CONTAINER_COUNT = 256


def source_id(value):
    return value if isinstance(value, str) and SOURCE.fullmatch(value) else None


def regular_stat(root, relative):
    """Check every component beneath the already validated deployment root."""
    try:
        for ancestor in reversed(relative.parents):
            if not stat.S_ISDIR((root / ancestor).lstat().st_mode):
                return None
        info = (root / relative).lstat()
        return info if stat.S_ISREG(info.st_mode) else None
    except OSError:
        return None


def read_metadata(root, relative):
    relative = Path(relative)
    info = regular_stat(root, relative)
    if info is None or info.st_size > MAX_METADATA_BYTES:
        return {}
    flags = os.O_RDONLY | getattr(os, "O_NOFOLLOW", 0) | getattr(os, "O_NONBLOCK", 0)
    try:
        with os.fdopen(os.open(root / relative, flags), "rb") as stream:
            opened = os.fstat(stream.fileno())
            if not stat.S_ISREG(opened.st_mode) or (opened.st_dev, opened.st_ino) != (info.st_dev, info.st_ino):
                return {}
            payload = stream.read(MAX_METADATA_BYTES + 1)
        if len(payload) > MAX_METADATA_BYTES:
            return {}
        value = json.loads(payload)
        return value if isinstance(value, dict) else {}
    except (OSError, ValueError, RecursionError):
        return {}


def filesystem(directory):
    info = directory.stat()
    if not stat.S_ISDIR(info.st_mode) or not hasattr(os, "statvfs"):
        raise OSError("not a directory")
    vfs = os.statvfs(directory)
    return {"device": info.st_dev, "freeBytes": vfs.f_bavail * vfs.f_frsize}


def app_filesystem(root):
    try:
        if not root.is_absolute() or root == Path(root.anchor) or root.resolve(strict=True) != root:
            return None
        return filesystem(root)
    except (OSError, RuntimeError, ValueError):
        return None


def docker_output(*arguments, timeout=DOCKER_PROBE_TIMEOUT):
    try:
        result = subprocess.run(
            ["docker", *arguments], stdout=subprocess.PIPE, stderr=subprocess.DEVNULL,
            timeout=timeout, encoding="utf-8", check=False,
        )
    except (OSError, UnicodeError, subprocess.TimeoutExpired):
        return None
    if result.returncode or len(result.stdout) > MAX_METADATA_BYTES:
        return None
    return result.stdout


def docker_filesystem():
    output = docker_output("info", "--format", "{{.DockerRootDir}}")
    if output is None:
        return None
    directory = output.strip()
    if not directory or not directory.isprintable() or not Path(directory).is_absolute():
        return None
    try:
        return filesystem(Path(directory))
    except OSError:
        return None


def docker_usage():
    output = docker_output("system", "df", "--format", "{{json .}}")
    if not output:
        return None
    usage = []
    try:
        for line in output.splitlines():
            record = json.loads(line)
            row_type = record["Type"]
            size, reclaimable = record["Size"], record["Reclaimable"]
            count, active = record["TotalCount"], record["Active"]
            if row_type not in DOCKER_TYPES or not DOCKER_SIZE.fullmatch(size) or not DOCKER_SIZE.fullmatch(reclaimable):
                return None
            if not re.fullmatch(r"[0-9]{1,12}", str(count)) or not re.fullmatch(r"[0-9]{1,12}", str(active)):
                return None
            usage.append({"type": row_type, "totalCount": int(count), "active": int(active), "size": size, "reclaimable": reclaimable})
        return usage if len(usage) == len({row["type"] for row in usage}) else None
    except (KeyError, TypeError, ValueError, RecursionError):
        return None


def running_containers():
    output = docker_output(
        "container", "inspect", "--format",
        '{{.Name}}\t{{.State.Running}}\t{{.Image}}\t{{index .Config.Labels "org.opencontainers.image.revision"}}',
        *CONTAINERS,
    )
    if output is None:
        return None
    containers = []
    for line in output.splitlines():
        parts = line.split("\t")
        if len(parts) != 4:
            return None
        name, running, image_id, revision = parts
        name = name[1:] if name.startswith("/") else name
        if name not in CONTAINERS or running not in {"true", "false"} or not IMAGE_ID.fullmatch(image_id):
            return None
        if running == "true":
            containers.append({"name": name, "imageId": image_id, "sourceCommit": source_id(revision)})
    return containers


def override_source(record, services):
    if not isinstance(record, dict):
        return None
    source = source_id(record.get("x-agentproject-source-commit"))
    expected = {service: {"image": f"agentproject-{service}:sha-{source}", "pull_policy": "never"} for service in services}
    return source if source and record.get("services") == expected else None


def prior_override_sources(root, source):
    snapshot = read_metadata(root, f".server-images-{source}/previous-overrides.json")
    if snapshot.get("schemaVersion") != 1 or snapshot.get("sourceCommit") != source:
        return {}
    return {project: override_source(snapshot.get(project), services) for project, (_, services) in OVERRIDES.items()}


def release_protection(root, requested, containers):
    published = source_id(read_metadata(root, ".deployed-release.json").get("sourceCommit"))
    overrides = {project: override_source(read_metadata(root, path), services)
                 for project, (path, services) in OVERRIDES.items()}
    current = {published, *overrides.values(), *(row["sourceCommit"] for row in containers or [])} - {None}
    prior = {previous for source in current for previous in prior_override_sources(root, source).values() if previous}
    return {
        "requestedSource": requested, "publishedSource": published, "runningContainers": containers,
        "overrideSources": overrides, "priorSources": sorted(prior), "sourceCommits": sorted(current | prior | {requested}),
    }


def scan_directory(path):
    try:
        with os.scandir(path) as entries:
            names = []
            for entry in entries:
                if len(names) == MAX_SCAN_ENTRIES:
                    return sorted(names), True
                names.append(entry.name)
            return sorted(names), False
    except OSError:
        return [], True


def staging_inventory(root, protected, now):
    files = []

    def add(relative, kind, source):
        info = regular_stat(root, relative)
        if info is None:
            return
        blocks = getattr(info, "st_blocks", None)
        files.append({
            "path": relative.as_posix(), "kind": kind, "sourceCommit": source, "bytes": info.st_size,
            "allocatedBytes": info.st_size if blocks is None else blocks * 512, "device": info.st_dev,
            "ageSeconds": max(0, int(now - info.st_mtime)), "protected": source in protected,
        })

    entries, truncated = scan_directory(root)
    for name in entries:
        runtime = RUNTIME.fullmatch(name)
        images = IMAGE_DIRECTORY.fullmatch(name)
        if runtime:
            add(Path(name), "runtime-bundle", runtime[1])
        elif images:
            add(Path(name) / "server-images.tar.gz", "server-image-archive", images[1])

    downloads = root / "data/downloads"
    try:
        safe_downloads = all(stat.S_ISDIR(path.lstat().st_mode) for path in (root / "data", downloads))
    except OSError:
        safe_downloads = False
    if safe_downloads:
        entries, downloads_truncated = scan_directory(downloads)
        truncated |= downloads_truncated
        for name in entries:
            installer = INSTALLER.fullmatch(name)
            if installer:
                add(Path("data/downloads") / name, "desktop-upload", installer[1])

    files.sort(key=lambda row: (-row["allocatedBytes"], row["path"]))
    return {"files": files[:MAX_STAGED_FILES], "truncated": truncated or len(files) > MAX_STAGED_FILES}


def inspect_storage(root, requested, *, now=None):
    if not source_id(requested):
        return {"status": "failed", "error": "invalid-protected-source"}
    app = app_filesystem(root)
    if app is None:
        return {"status": "failed", "error": "invalid-deploy-directory"}

    docker = docker_filesystem()
    containers = running_containers()
    usage = docker_usage()
    protection = release_protection(root, requested, containers)
    staging = staging_inventory(root, set(protection["sourceCommits"]), time.time() if now is None else now)
    warnings = [name for name, available in (
        ("docker-filesystem-unavailable", docker is not None),
        ("docker-usage-unavailable", usage is not None),
        ("running-release-unconfirmed", containers is not None and len(containers) == len(CONTAINERS)
         and all(row["sourceCommit"] for row in containers)),
        ("published-release-unconfirmed", protection["publishedSource"] is not None),
        ("staging-inventory-truncated", not staging["truncated"]),
    ) if not available]
    return {"status": "partial" if warnings else "ok", "filesystems": {"app": app, "docker": docker},
            "staging": staging, "protection": protection, "dockerUsage": usage, "warnings": warnings}


def read_archive_manifest(encoded):
    if not isinstance(encoded, str) or not encoded or len(encoded) > MAX_METADATA_BYTES:
        return None
    try:
        manifest = json.loads(base64.b64decode(encoded, validate=True))
    except (ValueError, RecursionError):
        return None
    if not isinstance(manifest, dict):
        return None
    source = source_id(manifest.get("sourceCommit"))
    size, digest, images = manifest.get("bytes"), manifest.get("sha256"), manifest.get("images")
    if (not source or type(manifest.get("schemaVersion")) is not int or manifest["schemaVersion"] != 1
            or manifest.get("filename") != "server-images.tar.gz" or type(size) is not int or size <= 0
            or not isinstance(digest, str) or not DIGEST.fullmatch(digest)
            or not isinstance(images, list) or len(images) != len(SERVICES)):
        return None

    indexed = {}
    for image in images:
        if not isinstance(image, dict):
            return None
        service = image.get("service")
        if service not in SERVICES or service in indexed:
            return None
        tag = f"agentproject-{service}:sha-{source}"
        if image.get("tag") != tag or image.get("revision") != source or (image.get("os"), image.get("architecture")) != ("linux", "amd64"):
            return None
        image_id = image.get("id")
        config_id = image.get("configId", image_id)
        if not all(isinstance(value, str) and IMAGE_ID.fullmatch(value) for value in (image_id, config_id)):
            return None
        indexed[service] = (tag, {image_id, config_id})
    return source, digest, dict(indexed[service] for service in SERVICES)


def retirement_protection(root, requested):
    active = running_containers()
    state = release_protection(root, requested, active)
    published = state["publishedSource"]
    if (not published or not active or len(active) != len(CONTAINERS)
            or {row["name"] for row in active} != set(CONTAINERS)
            or {row["sourceCommit"] for row in active} != {published}
            or set(state["overrideSources"].values()) != {published}):
        return None
    prior = set(prior_override_sources(root, published).values())
    if len(prior) != 1 or prior & {published, None}:
        return None
    return sorted({requested, published} | prior)


def tag_inventory(tags):
    """Successful exact Docker listings alone establish tag absence."""
    inventory = {}
    for tag in tags:
        output = docker_output("image", "ls", "--all", "--no-trunc", "--format", "{{.Repository}}:{{.Tag}}\t{{.ID}}",
                               "--filter", f"reference={tag}")
        if output is None:
            return None
        if not output.strip():
            continue
        parts = output.rstrip("\r\n").split("\t")
        if len(parts) != 2 or parts[0] != tag:
            return None
        image_id = f"sha256:{parts[1]}" if DIGEST.fullmatch(parts[1]) else parts[1]
        if not IMAGE_ID.fullmatch(image_id):
            return None
        inventory[tag] = image_id
    return inventory


def archived_image_matches(tag, image_id, source):
    output = docker_output("image", "inspect", "--format",
                           f'{{{{.Id}}}}\t{{{{.Os}}}}\t{{{{.Architecture}}}}\t{{{{index .Config.Labels "{REVISION_LABEL}"}}}}', tag)
    return output is not None and output.rstrip("\r\n").split("\t") == [image_id, "linux", "amd64", source]


def container_image_references():
    arguments = ("container", "ls", "--all", "--quiet", "--no-trunc")
    output = docker_output(*arguments)
    if output is None:
        return None
    container_ids = output.splitlines()
    if (not container_ids or len(container_ids) > MAX_CONTAINER_COUNT
            or len(container_ids) != len(set(container_ids)) or not all(DIGEST.fullmatch(value) for value in container_ids)):
        return None

    output = docker_output("container", "inspect", "--format", "{{.Id}}\t{{.Image}}", *container_ids)
    if output is None:
        return None
    references = {}
    for line in output.splitlines():
        parts = line.split("\t")
        if len(parts) != 2 or parts[0] in references or not IMAGE_ID.fullmatch(parts[1]):
            return None
        references[parts[0]] = parts[1]

    current = docker_output(*arguments)
    if current is None or sorted(current.splitlines()) != sorted(container_ids) or set(references) != set(container_ids):
        return None
    return set(references.values())


def retire_archive(root, requested, encoded, artifact_id):
    refusal = {"status": "failed", "outcome": "refused"}
    if not source_id(requested):
        return {**refusal, "error": "invalid-protected-source"}
    if not isinstance(artifact_id, str) or not re.fullmatch(r"[1-9][0-9]{0,18}", artifact_id):
        return {**refusal, "error": "invalid-archive-artifact-id"}
    manifest = read_archive_manifest(encoded)
    if manifest is None:
        return {**refusal, "error": "invalid-archive-manifest"}
    source, archive_digest, images = manifest
    evidence = {"sourceCommit": source, "archiveArtifactId": int(artifact_id), "archiveSha256": archive_digest}
    refusal.update(evidence)
    before = {"app": app_filesystem(root), "docker": None}
    if before["app"] is None:
        return {**refusal, "error": "invalid-deploy-directory"}
    protected = retirement_protection(root, requested)
    if protected is None:
        return {**refusal, "error": "rollback-protection-unconfirmed"}
    evidence["protectedSources"] = protected
    refusal["protectedSources"] = protected
    if source in protected:
        return {**refusal, "error": "protected-release"}

    present = tag_inventory(images)
    if present is None:
        return {**refusal, "error": "image-tag-inventory-unavailable"}
    if not all(image_id in images[tag] and archived_image_matches(tag, image_id, source) for tag, image_id in present.items()):
        return {**refusal, "error": "archive-image-mismatch"}
    before["docker"] = docker_filesystem()
    if before["docker"] is None:
        return {**refusal, "error": "docker-filesystem-unavailable"}
    # These are separate Docker API reads. Recheck just before any removal, and
    # use non-forced tag deletion so the daemon also enforces its reference rules.
    if retirement_protection(root, requested) != protected or tag_inventory(images) != present:
        return {**refusal, "error": "retirement-inventory-changed"}
    references = container_image_references()
    if references is None:
        return {**refusal, "error": "container-inventory-unavailable"}
    if any(references & image_ids for image_ids in images.values()):
        return {**refusal, "error": "archive-image-referenced"}
    removal = None
    if present:
        removal = docker_output("image", "rm", "--no-prune", *present, timeout=DOCKER_REMOVE_TIMEOUT)
    remaining = tag_inventory(images)
    after = {"app": app_filesystem(root), "docker": docker_filesystem()}
    deltas = {name: after[name]["freeBytes"] - prior["freeBytes"]
              if after[name] and after[name]["device"] == prior["device"] else None for name, prior in before.items()}
    report = {
        **evidence,
        "tags": {"requested": list(images), "absentBefore": [tag for tag in images if tag not in present],
                 "removed": [tag for tag in present if tag not in remaining] if remaining is not None else None,
                 "remaining": list(remaining) if remaining is not None else None},
        "dockerRemoveSucceeded": removal is not None if present else None,
        "filesystems": {"before": before, "after": after, "freeBytesDelta": deltas},
    }
    if remaining is None or remaining or None in deltas.values():
        return {**report, "status": "failed", "outcome": "partial", "error": "retirement-outcome-incomplete"}
    return {**report, "status": "passed", "outcome": "retired" if present else "already-absent"}


def main():
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument("--directory", type=Path, required=True)
    parser.add_argument("--protected-source", required=True)
    parser.add_argument("--retire-archive-manifest")
    parser.add_argument("--archive-artifact-id")
    arguments = parser.parse_args()
    if arguments.retire_archive_manifest is None and arguments.archive_artifact_id is None:
        report = inspect_storage(arguments.directory, arguments.protected_source)
    else:
        report = retire_archive(arguments.directory, arguments.protected_source,
                                arguments.retire_archive_manifest, arguments.archive_artifact_id)
    print(json.dumps(report))
    return int(report["status"] == "failed")


if __name__ == "__main__":
    sys.exit(main())
