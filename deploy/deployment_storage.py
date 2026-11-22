"""Report deployment storage without changing files, Docker objects, or release state."""

import argparse
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
DOCKER_SIZE = re.compile(r"[0-9]+(?:\.[0-9]+)?\s?(?:[kmgtpe]i?B|B)(?: \(\d+%\))?", re.IGNORECASE)
DOCKER_TYPES = {"Images", "Containers", "Local Volumes", "Build Cache"}
CONTAINERS = ("agentproject-backend", "agentproject-nginx", "agentproject-agent-server")
OVERRIDES = {
    "main": ("docker-compose.override.yml", ("backend", "nginx")),
    "agent": ("agent-server/docker-compose.override.yml", ("agent-server",)),
}
MAX_SCAN_ENTRIES = 4096
MAX_STAGED_FILES = 256
MAX_METADATA_BYTES = 65536
DOCKER_PROBE_TIMEOUT = 10


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


def docker_output(*arguments):
    try:
        result = subprocess.run(
            ["docker", *arguments], stdout=subprocess.PIPE, stderr=subprocess.DEVNULL,
            timeout=DOCKER_PROBE_TIMEOUT, encoding="utf-8", check=False,
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


def release_protection(root, requested, containers):
    published = source_id(read_metadata(root, ".deployed-release.json").get("sourceCommit"))
    overrides = {project: override_source(read_metadata(root, path), services)
                 for project, (path, services) in OVERRIDES.items()}
    current = {published, *overrides.values(), *(row["sourceCommit"] for row in containers or [])} - {None}
    prior = set()
    for source in sorted(current):
        snapshot = read_metadata(root, f".server-images-{source}/previous-overrides.json")
        if snapshot.get("schemaVersion") == 1 and snapshot.get("sourceCommit") == source:
            for project, (_, services) in OVERRIDES.items():
                previous = override_source(snapshot.get(project), services)
                if previous:
                    prior.add(previous)
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
    try:
        if not root.is_absolute() or root == Path(root.anchor) or root.resolve(strict=True) != root:
            return {"status": "failed", "error": "invalid-deploy-directory"}
        app = filesystem(root)
    except (OSError, RuntimeError, ValueError):
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


def main():
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument("--directory", type=Path, required=True)
    parser.add_argument("--protected-source", required=True)
    arguments = parser.parse_args()
    report = inspect_storage(arguments.directory, arguments.protected_source)
    print(json.dumps(report))
    return int(report["status"] == "failed")


if __name__ == "__main__":
    sys.exit(main())
