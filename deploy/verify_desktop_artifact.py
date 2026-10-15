"""Bind a Windows installer and its public download to an exact main commit."""
import argparse
import hashlib
import json
from pathlib import Path
import re
import sys
from urllib.parse import quote, urlsplit
from urllib.request import Request, urlopen


def installer_manifest(directory, version, source_commit):
    if not re.fullmatch(r"\d+\.\d+\.\d+(?:-[A-Za-z0-9.-]+)?", version):
        raise ValueError("Invalid desktop release version")
    if not re.fullmatch(r"[a-f0-9]{40}", source_commit):
        raise ValueError("A full source commit SHA is required")
    installers = sorted(Path(directory).glob("*.exe"))
    expected = f"Detachym-{version}-x64.exe"
    if len(installers) != 1 or installers[0].name != expected:
        raise ValueError(f"Expected exactly one installer named {expected}")
    installer = installers[0]
    if installer.is_symlink() or not installer.is_file() or installer.stat().st_size <= 0:
        raise ValueError("Installer must be a nonempty regular file")
    digest = hashlib.sha256()
    with installer.open("rb") as source:
        for chunk in iter(lambda: source.read(1024 * 1024), b""):
            digest.update(chunk)
    return {"version": version, "filename": expected, "bytes": installer.stat().st_size,
            "sha256": digest.hexdigest(), "sourceCommit": source_commit}


def verify_manifest(directory, manifest, version, source_commit):
    actual = installer_manifest(directory, version, source_commit)
    if any(manifest.get(key) != value for key, value in actual.items()):
        raise ValueError("Installer metadata, checksum or source commit does not match the manifest")
    return actual


def verify_public_release(base_url, manifest):
    parsed = urlsplit(base_url)
    if parsed.scheme != "https" or not parsed.netloc or parsed.username or parsed.password:
        raise ValueError("Public origin must use HTTPS without credentials")
    origin = f"{parsed.scheme}://{parsed.netloc}"
    with urlopen(f"{origin}/health/ready", timeout=20) as response:
        if json.load(response).get("status") != "ready":
            raise ValueError("Public backend is not ready")
    with urlopen(f"{origin}/api/v1/public/version/win-x64", timeout=20) as response:
        release = json.load(response)
    if release.get("available") is not True or any(
        release.get(key) != manifest[key] for key in ("version", "filename")
    ):
        raise ValueError("Public desktop version does not match the verified installer")
    download = f"{origin}/download/{quote(manifest['filename'])}"
    with urlopen(Request(download, method="HEAD"), timeout=20) as response:
        if response.status != 200 or response.headers.get("Content-Length") != str(manifest["bytes"]):
            raise ValueError("Public installer HEAD/Content-Length does not match the artifact")
    return {"status": "passed", "origin": origin, "version": manifest["version"],
            "filename": manifest["filename"], "bytes": manifest["bytes"],
            "sourceCommit": manifest["sourceCommit"]}


def main():
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument("--directory", required=True)
    parser.add_argument("--package", required=True)
    parser.add_argument("--source-commit", required=True)
    parser.add_argument("--manifest", required=True)
    parser.add_argument("--verify", action="store_true")
    parser.add_argument("--public-base-url")
    args = parser.parse_args()
    if args.public_base_url and not args.verify:
        raise ValueError("Public verification requires an existing verified manifest")
    package = json.loads(Path(args.package).read_text(encoding="utf-8-sig"))
    path = Path(args.manifest)
    if args.verify:
        manifest = verify_manifest(args.directory, json.loads(path.read_text(encoding="utf-8-sig")),
                                   package["version"], args.source_commit)
    else:
        manifest = installer_manifest(args.directory, package["version"], args.source_commit)
        path.write_text(json.dumps(manifest, indent=2) + "\n", encoding="utf-8")
    if args.public_base_url:
        print(json.dumps(verify_public_release(args.public_base_url, manifest)))
    else:
        print(json.dumps({"status": "passed", **manifest}))


if __name__ == "__main__":
    try:
        main()
    except Exception as error:
        print(json.dumps({"status": "failed", "error": str(error)}))
        sys.exit(1)
