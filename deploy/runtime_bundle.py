"""Ship only committed deployment configuration; retain host runtime state."""

import argparse
import gzip
import hashlib
import io
import json
import os
from pathlib import Path, PurePosixPath
import re
import subprocess
import tarfile
import tempfile


SOURCE_PATHS = ("deploy", "docker-compose.yml", "agent-server/docker-compose.yml")
REQUIRED_FILES = {
    "docker-compose.yml", "agent-server/docker-compose.yml",
    "deploy/server_images.py", "deploy/nginx.conf",
}
RUNTIME_NAMES = {
    "ssl", "certs", "certificates", "runtime", "data", "logs", "__pycache__",
    "node_modules", "venv", ".venv", ".pytest_cache", ".deployed-release.json",
    "docker-compose.override.yml", "docker-compose.override.yaml",
    "compose.override.yml", "compose.override.yaml",
}


def validate_source(source_commit):
    if not re.fullmatch(r"[0-9a-f]{40}", source_commit):
        raise ValueError("sourceCommit must be a full lowercase commit SHA")


def read_bundle(payload, source_commit):
    """Validate the complete archive before returning any files for extraction."""
    validate_source(source_commit)
    files = {}
    with tarfile.open(fileobj=io.BytesIO(payload), mode="r:gz") as archive:
        if archive.pax_headers.get("comment") != source_commit:
            raise ValueError("Archive sourceCommit does not match the requested commit")
        seen = set()
        for member in archive:
            name = member.name.rstrip("/")
            path = PurePosixPath(name)
            if (not name or name in seen or path.is_absolute()
                    or "\\" in name or any(part in ("", ".", "..") for part in name.split("/"))):
                raise ValueError(f"Unsafe or duplicate archive path: {name}")
            seen.add(name)
            parts = path.parts
            if any(part.lower() in RUNTIME_NAMES or part.lower().startswith((".env", ".server-images-"))
                   or part.lower().endswith((".env", ".pem", ".key", ".crt", ".pyc")) for part in parts):
                raise ValueError(f"Runtime state must not be bundled: {name}")
            allowed = (name in SOURCE_PATHS[1:] or name.startswith("deploy/")
                       or (member.isdir() and name in ("deploy", "agent-server")))
            if not allowed or not (member.isfile() or member.isdir()):
                raise ValueError(f"Unexpected archive path or type: {name}")
            if member.isfile():
                files[name] = (archive.extractfile(member).read(), member.mode)
    missing = REQUIRED_FILES - files.keys()
    if missing:
        raise ValueError(f"Missing runtime configuration: {', '.join(sorted(missing))}")
    return files


def create_bundle(repo, source_commit, output):
    validate_source(source_commit)
    resolved = subprocess.check_output(
        ["git", "rev-parse", "--verify", f"{source_commit}^{{commit}}"], cwd=repo, text=True,
    ).strip()
    if resolved != source_commit:
        raise ValueError("Requested SHA does not identify the exact source commit")
    raw = subprocess.check_output(
        ["git", "archive", "--format=tar", source_commit, *SOURCE_PATHS], cwd=repo,
    )
    payload = gzip.compress(raw, mtime=0)
    files = read_bundle(payload, source_commit)
    Path(output).write_bytes(payload)
    return {
        "sourceCommit": source_commit, "sha256": hashlib.sha256(payload).hexdigest(),
        "bytes": len(payload), "files": sorted(files),
    }


def install_bundle(archive_path, source_commit, expected_sha256, destination):
    payload = Path(archive_path).read_bytes()
    if (not re.fullmatch(r"[0-9a-f]{64}", expected_sha256)
            or hashlib.sha256(payload).hexdigest() != expected_sha256):
        raise ValueError("Runtime bundle SHA-256 mismatch")
    files = read_bundle(payload, source_commit)
    destination = Path(destination)
    # Check every destination first; never follow a host symlink into runtime data.
    for name in files:
        target = destination / name
        for parent in (target, *target.parents):
            if parent == destination.parent:
                break
            if parent.is_symlink():
                raise ValueError(f"Refusing symlink destination: {name}")
            if parent.exists() and not (parent.is_file() if parent == target else parent.is_dir()):
                raise ValueError(f"Unexpected destination type: {name}")
    for name, (content, mode) in files.items():
        target = destination / name
        target.parent.mkdir(parents=True, exist_ok=True)
        with tempfile.NamedTemporaryFile(dir=target.parent, delete=False) as temporary:
            temporary.write(content)
            temporary_path = Path(temporary.name)
        try:
            temporary_path.chmod(mode & 0o777)
            os.replace(temporary_path, target)
        finally:
            temporary_path.unlink(missing_ok=True)
    return {"sourceCommit": source_commit, "sha256": expected_sha256, "files": sorted(files)}


def main():
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument("--source-commit", required=True)
    parser.add_argument("--output", default="deploy-runtime.tgz")
    parser.add_argument("--install", type=Path)
    parser.add_argument("--sha256")
    args = parser.parse_args()
    if args.install:
        if not args.sha256:
            parser.error("--install requires --sha256")
        result = install_bundle(args.install, args.source_commit, args.sha256, Path.cwd())
    else:
        result = create_bundle(Path.cwd(), args.source_commit, args.output)
    print(json.dumps(result, indent=2))


if __name__ == "__main__":
    main()
