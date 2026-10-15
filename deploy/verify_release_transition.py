"""Reject an older application or a target missing the live database revision."""
import ast
import json
from pathlib import Path
import re
import sys


def version_key(value):
    match = re.fullmatch(
        r"(?:DetachymAgentPet|v)?(\d+)\.(\d+)(?:\.(\d+))?(?:-(alpha|beta|rc)\.(\d+))?",
        str(value),
    )
    if not match:
        raise ValueError(f"Cannot compare release version: {value!r}")
    major, minor, patch, stage, number = match.groups()
    return (int(major), int(minor), int(patch or 0), {"alpha": 0, "beta": 1, "rc": 2, None: 3}[stage], int(number or 0))


def migration_revisions(directory):
    revisions = set()
    for path in directory.glob("*.py"):
        for node in ast.parse(path.read_text(encoding="utf-8-sig")).body:
            if isinstance(node, ast.AnnAssign):
                targets = [node.target]
            elif isinstance(node, ast.Assign):
                targets = node.targets
            else:
                continue
            if any(isinstance(target, ast.Name) and target.id == "revision" for target in targets):
                value = ast.literal_eval(node.value)
                if not isinstance(value, str) or not value:
                    raise ValueError(f"Invalid revision in {path.name}")
                revisions.add(value)
    if not revisions:
        raise ValueError("Target has no migration revisions")
    return revisions


def verify_transition(current, target_version, target_revisions):
    current_version = current.get("version")
    current_revisions = current.get("revisions")
    if not isinstance(current_revisions, list) or not current_revisions or not all(
        isinstance(revision, str) and revision for revision in current_revisions
    ):
        raise ValueError("Live database revisions are missing; refusing an unverified deployment")
    if version_key(target_version) < version_key(current_version):
        raise ValueError(f"Refusing application downgrade: {current_version} -> {target_version}")
    missing = set(current_revisions) - set(target_revisions)
    if missing:
        raise ValueError(f"Target cannot recognize live database revisions: {', '.join(sorted(missing))}")
    return {"status": "passed", "currentVersion": current_version, "targetVersion": target_version,
            "databaseRevisions": current_revisions}


async def inspect_running():
    # Runs inside the existing backend container, before runtime files are changed.
    from app.core.config import settings
    from app.models.database import async_session_maker, engine
    from sqlalchemy import text
    try:
        async with async_session_maker() as session:
            revisions = list((await session.execute(text("SELECT version_num FROM alembic_version"))).scalars())
        return {"version": settings.DESKTOP_RELEASE_VERSION, "revisions": revisions}
    finally:
        await engine.dispose()


if __name__ == "__main__":
    try:
        if sys.argv[1:] == ["--inspect-running"]:
            import asyncio
            result = asyncio.run(inspect_running())
        else:
            if len(sys.argv) != 2:
                raise ValueError("Usage: verify_release_transition.py CURRENT_STATE.json")
            root = Path(__file__).resolve().parent.parent
            current = json.loads(Path(sys.argv[1]).read_text(encoding="utf-8-sig"))
            target = json.loads((root / "desktop/package.json").read_text(encoding="utf-8-sig"))
            result = verify_transition(current, target["version"], migration_revisions(root / "backend/alembic/versions"))
        print(json.dumps(result))
    except Exception as error:
        print(json.dumps({"status": "failed", "error": str(error)}))
        sys.exit(1)
