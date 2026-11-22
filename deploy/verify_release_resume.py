"""Verify staging or finish an exact switched release on a retry of the same CD run."""

import argparse
import hashlib
import json
from pathlib import Path
import re
import shlex
import subprocess
import sys
import tempfile
from urllib.parse import urlsplit
from urllib.request import urlopen


PROJECTS = {
    "main": (Path("."), ("backend", "nginx")),
    "agent": (Path("agent-server"), ("agent-server",)),
}
RUNTIME_FILES = (
    "docker-compose.yml", "agent-server/docker-compose.yml", "deploy/nginx.conf", "deploy/server_images.py",
)
SHA = re.compile(r"[a-f0-9]{40}")
VERSION = re.compile(r"\d+\.\d+\.\d+(?:-[A-Za-z0-9.-]+)?")
MAX_METADATA_BYTES = 65536


def regular_file(root, relative):
    path = root / relative
    for parent in relative.parents:
        directory = root / parent
        if directory.is_symlink() or not directory.is_dir():
            raise ValueError(f"Unverified release directory: {parent}")
    if path.is_symlink() or not path.is_file():
        raise ValueError(f"Missing or non-regular release file: {relative}")
    return path


def metadata(root, relative):
    path = regular_file(root, Path(relative))
    with path.open("rb") as stream:
        contents = stream.read(MAX_METADATA_BYTES + 1)
    if len(contents) > MAX_METADATA_BYTES:
        raise ValueError(f"Oversized release metadata: {relative}")
    return contents


def digest(path):
    content = hashlib.sha256()
    with path.open("rb") as stream:
        for chunk in iter(lambda: stream.read(1024 * 1024), b""):
            content.update(chunk)
    return content.hexdigest()


def desktop_manifest(manifest):
    version = manifest["version"]
    if (not VERSION.fullmatch(version) or not SHA.fullmatch(manifest["sourceCommit"])
            or manifest["filename"] != f"Detachym-{version}-x64.exe"
            or type(manifest["bytes"]) is not int or manifest["bytes"] <= 0
            or not re.fullmatch(r"[a-f0-9]{64}", manifest["sha256"])):
        raise ValueError("Invalid desktop release manifest")
    return manifest


def overlay(source, services, *, managed):
    entries = {service: {"image": f"agentproject-{service}:sha-{source}"} for service in services}
    if managed:
        for entry in entries.values():
            entry["pull_policy"] = "never"
        return {"x-agentproject-source-commit": source, "services": entries}
    return {"services": entries}


def image_state(root, directory, source, *, running=False):
    regular_file(root, directory / "server-images.json")
    command = [sys.executable, "-B", "deploy/server_images.py", "inspect", "--directory", str(directory),
               "--source-commit", source]
    if running:
        command.append("--running")
    result = subprocess.run(command, cwd=root, capture_output=True, text=True, timeout=45, check=False)
    if result.returncode:
        raise ValueError("Docker images do not match the verified release manifest")
    return json.loads(result.stdout)


def verify_readiness(desktop):
    # Print none of the live environment or response data.
    code = """
import json, sys, urllib.request
def get(path):
    with urllib.request.urlopen('http://127.0.0.1:5000' + path, timeout=10) as response:
        return json.load(response)
ready = get('/health/ready')
release = get('/api/v1/public/version/win-x64')
sys.exit(not (ready.get('status') == 'ready' and release.get('available') is True
              and release.get('version') == sys.argv[1] and release.get('filename') == sys.argv[2]))
"""
    if subprocess.run(["docker", "exec", "agentproject-backend", "python", "-c", code,
                       desktop["version"], desktop["filename"]], capture_output=True, timeout=25).returncode:
        raise ValueError("Running backend is not ready with the exact desktop release")
    with urlopen("http://127.0.0.1:8001/health", timeout=10) as response:
        if response.status != 200:
            raise ValueError("Running agent server is not ready")


def verify_runtime(root, expected):
    for name in RUNTIME_FILES:
        if digest(regular_file(root, Path(name))) != expected["runtime"][name]:
            raise ValueError(f"Runtime configuration differs: {name}")


def verify_staging(root, expected, *, record):
    desktop = desktop_manifest(expected["desktop"])
    source = desktop["sourceCommit"]
    run_id = expected["workflowRunId"]
    if not re.fullmatch(r"[1-9][0-9]*", run_id):
        raise ValueError("A CD run ID is required")
    directory = Path(f".server-images-{source}")
    receipt_path = directory / "staged-release.json"
    running_receipt = root / directory / "running-images.json"
    if not record and (running_receipt.exists() or running_receipt.is_symlink()):
        raise ValueError("A service switch receipt already exists")
    receipt = {
        "schemaVersion": 1, "sourceCommit": source, "workflowRunId": run_id,
        "installerSha256": desktop["sha256"],
        "desktopManifestSha256": expected["staging"]["desktopManifestSha256"],
        "imageManifestSha256": expected["staging"]["imageManifestSha256"],
    }
    if not record:
        saved = json.loads(metadata(root, receipt_path))
        if not isinstance(saved, dict) or any(saved.get(key) != value for key, value in receipt.items()):
            raise ValueError("Stage receipt differs from this CD run or its artifacts")

    verify_runtime(root, expected)
    desktop_bytes = metadata(root, f".desktop-release-{source}.json")
    if hashlib.sha256(desktop_bytes).hexdigest() != receipt["desktopManifestSha256"]:
        raise ValueError("Staged desktop manifest differs from the verified artifact")
    image_bytes = metadata(root, directory / "server-images.json")
    if hashlib.sha256(image_bytes).hexdigest() != receipt["imageManifestSha256"]:
        raise ValueError("Staged image manifest differs from the verified artifact")
    for project, (_, services) in PROJECTS.items():
        if json.loads(metadata(root, directory / f"{project}.compose.json")) != overlay(source, services, managed=False):
            raise ValueError(f"Staged Compose override differs: {project}")

    staged_name = f".{desktop['filename']}.{source}.upload"
    installer = regular_file(root, Path("data/downloads") / staged_name)
    if installer.stat().st_size != desktop["bytes"] or digest(installer) != desktop["sha256"]:
        raise ValueError("Staged installer differs from the verified artifact")
    loaded = image_state(root, directory, source)
    if loaded.get("status") != "passed" or loaded.get("sourceCommit") != source:
        raise ValueError("Loaded images do not match the staged release")
    receipt["loadedImageIds"] = {image["service"]: image["loadedId"] for image in loaded["images"]}
    if record:
        target = root / receipt_path
        if target.is_symlink():
            raise ValueError("Stage receipt cannot be a symlink")
        with tempfile.NamedTemporaryFile(mode="w", encoding="utf-8", dir=target.parent,
                                         prefix=".staged-release-", delete=False) as stream:
            temporary = Path(stream.name)
            try:
                stream.write(json.dumps(receipt) + "\n")
                stream.close()
                temporary.replace(target)
            finally:
                temporary.unlink(missing_ok=True)
    elif saved != receipt:
        raise ValueError("Loaded images differ from the stage receipt")
    return {"status": "passed", **receipt}


def probe(root, expected):
    desktop = desktop_manifest(expected["desktop"])
    source = desktop["sourceCommit"]
    run_id = expected["workflowRunId"]
    if not re.fullmatch(r"[1-9][0-9]*", run_id):
        raise ValueError("A CD run ID is required")
    directory = Path(f".server-images-{source}")
    published = desktop_manifest(json.loads(metadata(root, ".deployed-release.json")))
    pending = Path(f".desktop-release-{source}.json")
    already_published = published == desktop
    if not already_published or (root / pending).exists() or (root / pending).is_symlink():
        if json.loads(metadata(root, pending)) != desktop:
            raise ValueError("Pending release manifest does not match the verified installer")
    if published["sourceCommit"] == source and not already_published:
        raise ValueError("Published release differs from this same-source installer")
    configured_release = metadata(root, ".env").decode("utf-8")
    for key, field in (("DESKTOP_RELEASE_VERSION", "version"), ("DESKTOP_RELEASE_FILE", "filename")):
        if re.findall(rf"^{key}=([^\r\n]*)$", configured_release, re.MULTILINE) != [desktop[field]]:
            raise ValueError("Runtime desktop release keys differ from the verified installer")

    verify_runtime(root, expected)
    if json.loads(metadata(root, directory / "server-images.json")) != expected["images"]:
        raise ValueError("Remote image manifest differs from the verified build artifact")
    running_receipt = json.loads(metadata(root, directory / "running-images.json"))
    if running_receipt.get("workflowRunId") != run_id:
        raise ValueError("The switch receipt belongs to a different CD run")

    prior = json.loads(metadata(root, directory / "previous-overrides.json"))
    prior_source = prior["main"]["x-agentproject-source-commit"]
    if (prior["schemaVersion"] != 1 or prior["sourceCommit"] != source
            or not SHA.fullmatch(prior_source) or prior_source == source
            or (not already_published and published["sourceCommit"] != prior_source)):
        raise ValueError("The previous deployment is unconfirmed")
    for project, (project_directory, services) in PROJECTS.items():
        for name in ("compose.override.yaml", "compose.override.yml", "docker-compose.override.yaml"):
            unmanaged = root / project_directory / name
            if unmanaged.exists() or unmanaged.is_symlink():
                raise ValueError(f"Unmanaged Compose override exists: {project}/{name}")
        if prior[project] != overlay(prior_source, services, managed=True):
            raise ValueError(f"Previous Compose override differs: {project}")
        if json.loads(metadata(root, project_directory / "docker-compose.override.yml")) != overlay(source, services, managed=True):
            raise ValueError(f"Current default Compose override differs: {project}")
        if json.loads(metadata(root, directory / f"{project}.compose.json")) != overlay(source, services, managed=False):
            raise ValueError(f"Current explicit Compose override differs: {project}")
    snapshot = metadata(root, f".release-state-before-{source}.env").decode("utf-8")
    match = re.fullmatch(r"DESKTOP_RELEASE_VERSION=(.+)\nDESKTOP_RELEASE_FILE=(.+)\n", snapshot)
    if (not match or not VERSION.fullmatch(match[1]) or match[2] != f"Detachym-{match[1]}-x64.exe"
            or (not already_published and (published["version"], published["filename"]) != match.groups())):
        raise ValueError("The previous desktop release keys are unconfirmed")
    prior_installer = regular_file(root, Path("data/downloads") / match[2])
    if prior_installer.stat().st_size <= 0 or (not already_published and (
            prior_installer.stat().st_size != published["bytes"] or digest(prior_installer) != published["sha256"])):
        raise ValueError("The previous installer differs from its release record")
    if image_state(root, Path(f".server-images-{prior_source}"), prior_source).get("status") != "passed":
        raise ValueError("The previous release images are unconfirmed")

    installer = regular_file(root, Path("data/downloads") / desktop["filename"])
    if installer.stat().st_size != desktop["bytes"] or digest(installer) != desktop["sha256"]:
        raise ValueError("The installed file differs from the verified build artifact")
    fresh_running = image_state(root, directory, source, running=True)
    if fresh_running.get("status") != "passed" or running_receipt != {**fresh_running, "workflowRunId": run_id}:
        raise ValueError("The running images differ from the completed switch receipt")
    verify_readiness(desktop)
    origin = metadata(root, f".public-origin-{source}").decode("utf-8").rstrip("\n")
    parsed = urlsplit(origin)
    if parsed.scheme != "https" or not parsed.hostname or origin != f"https://{parsed.netloc}" or parsed.username or parsed.password:
        raise ValueError("The recorded public origin is invalid")
    return {"status": "passed", "workflowRunId": run_id, "sourceCommit": source, "origin": origin,
            "published": published, "alreadyPublished": already_published,
            "priorSource": prior_source, "priorReleaseKeys": list(match.groups()), "running": fresh_running}


def verify_public_proof(report, desktop, origin):
    required = {**desktop, "origin": origin, "status": "passed"}
    if any(report.get(key) != value for key, value in required.items()):
        raise ValueError("A successful full public download for this exact release is required")


def remote(expected, before=None, stage=None):
    root = Path.cwd()
    if stage is not None:
        if stage not in {"record", "verify"} or before is not None:
            raise ValueError("Invalid stage verification request")
        return verify_staging(root, expected, record=stage == "record")
    current = probe(root, expected)
    if before is not None:
        if before != current:
            raise ValueError("The switched release changed during public verification")
        if not current["alreadyPublished"]:
            pending = root / f".desktop-release-{current['sourceCommit']}.json"
            pending.replace(root / ".deployed-release.json")
    return current


def call_remote(app_dir, source, run_id, *, proof=None, public_download=None, stage=None):
    repo = Path(__file__).resolve().parent.parent
    desktop_bytes = metadata(repo, "desktop-release/desktop-release.json")
    image_bytes = metadata(repo, "server-images/server-images.json")
    desktop = desktop_manifest(json.loads(desktop_bytes))
    if desktop["sourceCommit"] != source:
        raise ValueError("The desktop artifact differs from the current main SHA")
    expected = {"desktop": desktop, "workflowRunId": run_id,
                "images": json.loads(image_bytes),
                "runtime": {name: digest(regular_file(repo, Path(name))) for name in RUNTIME_FILES}}
    payload = {"expected": expected}
    if stage is not None:
        payload["stage"] = stage
        expected["staging"] = {"desktopManifestSha256": hashlib.sha256(desktop_bytes).hexdigest(),
                               "imageManifestSha256": hashlib.sha256(image_bytes).hexdigest()}
    if proof is not None:
        before = json.loads(metadata(repo, proof))
        verify_public_proof(json.loads(metadata(repo, public_download)), desktop, before["origin"])
        payload["before"] = before
    command = f"cd {shlex.quote(app_dir)} && " + shlex.join(
        ["python3", "-B", "-", "--remote", json.dumps(payload, separators=(",", ":"))]
    )
    result = subprocess.run(["ssh", "deploy-target", command], input=Path(__file__).read_bytes(),
                            capture_output=True, timeout=150)
    if not result.stdout:
        raise ValueError("Could not read the switched release from the deployment host")
    report = json.loads(result.stdout)
    if result.returncode or report.get("status") != "passed":
        raise ValueError(report.get("error", "The switched release is unconfirmed"))
    return report


def main():
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument("--remote")
    parser.add_argument("--app-dir")
    parser.add_argument("--source-commit")
    parser.add_argument("--run-id")
    parser.add_argument("--proof")
    parser.add_argument("--public-download")
    parser.add_argument("--stage", choices=("record", "verify"))
    args = parser.parse_args()
    if args.remote:
        return remote(**json.loads(args.remote))
    if (not all((args.app_dir, args.source_commit, args.run_id)) or bool(args.proof) != bool(args.public_download)
            or (args.proof and args.stage)):
        parser.error("App directory, source commit and run ID are required; publication also requires both proofs")
    return call_remote(args.app_dir, args.source_commit, args.run_id,
                       proof=args.proof, public_download=args.public_download, stage=args.stage)


if __name__ == "__main__":
    try:
        print(json.dumps(main()))
    except (KeyError, OSError, TypeError, ValueError, subprocess.TimeoutExpired) as error:
        print(json.dumps({"status": "failed", "error": str(error)}))
        sys.exit(1)
