"""Exercise release orchestration without Docker, app imports, or database access."""

import importlib.util
import json
from pathlib import Path
from urllib.parse import urlsplit

import pytest


SCRIPT = Path(__file__).resolve().parents[1] / "scripts" / "verify_postgres_release.py"
spec = importlib.util.spec_from_file_location("postgres_release_verifier", SCRIPT)
verifier = importlib.util.module_from_spec(spec)
spec.loader.exec_module(verifier)


def migration_graph(tmp_path, revisions):
    scripts = tmp_path / "alembic"
    versions = scripts / "versions"
    versions.mkdir(parents=True)
    (tmp_path / "alembic.ini").write_text("[alembic]\n", encoding="utf-8")
    # env.py must never be executed just to inspect revision metadata.
    (scripts / "env.py").write_text("raise AssertionError('env.py executed')\n", encoding="utf-8")
    for revision, previous in revisions:
        (versions / f"{revision}_fixture.py").write_text(
            f"revision = {revision!r}\ndown_revision = {previous!r}\n", encoding="utf-8",
        )


def test_head_resolution_uses_current_graph_without_running_environment(tmp_path, monkeypatch):
    migration_graph(tmp_path, [("007", None), ("999", "007")])
    monkeypatch.setattr(verifier, "ROOT", tmp_path)
    assert verifier.get_migration_head() == "999"


@pytest.mark.parametrize("revisions", [[], [("001", None), ("002", None)]])
def test_head_resolution_rejects_missing_or_multiple_heads(tmp_path, monkeypatch, revisions):
    migration_graph(tmp_path, revisions)
    monkeypatch.setattr(verifier, "ROOT", tmp_path)
    with pytest.raises(RuntimeError, match="Expected one Alembic migration head"):
        verifier.get_migration_head()


class FakeOwnedPostgres:
    def __init__(self, head, *, corrupt_upgrade=False):
        self.head = head
        self.corrupt_upgrade = corrupt_upgrade
        self.revisions = {}
        self.migrations = []
        self.environments = []
        self.statements = []
        self.removed = []
        self.backup_created = False
        self.backup_restored = False

    def command(self, *args, env=None, timeout=120):
        if args[:2] == ("docker", "run"):
            assert args[args.index("-p") + 1] == "127.0.0.1::5432"
            assert "--rm" in args and "detachym.owner=postgres-release-check" in args
            return "owned-container-id"
        if args[:2] == ("docker", "port"):
            return "127.0.0.1:54321"
        if args[:2] == ("docker", "rm"):
            self.removed.append(args[-1])
            return "owned-container-id"
        if args[:3] == ("docker", "exec", "owned-container-id"):
            if args[3] == "pg_isready":
                return "accepting connections"
            if args[3] == "pg_dump":
                self.backup_created = True
                return ""
            if args[3] == "pg_restore":
                assert self.backup_created
                self.backup_restored = True
                self.revisions["p1l_restore"] = verifier.HISTORICAL_REVISION
                return ""
            assert args[3] == "psql", args
            database = args[args.index("-d") + 1]
            statement = args[-1]
            self.statements.append((database, statement))
            if statement == "select version_num from alembic_version":
                return self.revisions[database]
            if "select json_build_object" in statement:
                assert "'preferences'" in statement
                if self.corrupt_upgrade and self.revisions[database] == self.head:
                    return "changed historical data"
                return "historical users, pets, reminders and cat/dog/pig preferences"
            if statement.startswith("select count(*)"):
                assert self.backup_restored
                return "1"
            return ""
        if args[1:3] == ("-m", "alembic"):
            database = urlsplit(env["DATABASE_URL"]).path.lstrip("/")
            action, target = args[3:5]
            self.migrations.append((database, action, target))
            self.environments.append(env)
            self.revisions[database] = self.head if target == "head" else target
            return ""
        if args[-1] == "--probe":
            self.environments.append(env)
            return json.dumps({"schema_revision": self.head, "new_preferences_default_to_pig": True})
        raise AssertionError(f"Unexpected external command: {args!r}")


@pytest.mark.parametrize("head", ["015", "999"])
def test_owned_postgres_flow_tracks_head_and_preserves_rollback_checks(tmp_path, monkeypatch, head):
    fake = FakeOwnedPostgres(head)
    monkeypatch.setattr(verifier, "get_migration_head", lambda: head)
    monkeypatch.setattr(verifier, "command", fake.command)
    report_path = tmp_path / "report.json"
    assert verifier.verify("postgres:test-fixture", report_path)
    report = json.loads(report_path.read_text(encoding="utf-8"))
    assert report["schema_head"] == head
    assert report["checks"][f"010_to_{head}_preserves_data"]
    assert report["checks"]["synthetic_upgrade_downgrade_upgrade"]
    assert report["checks"]["backup_restore_read_write"]
    assert fake.migrations == [
        ("p1l_empty", "upgrade", "head"), ("p1l_upgrade", "upgrade", "010"),
        ("p1l_upgrade", "upgrade", "head"), ("p1l_upgrade", "downgrade", "010"),
        ("p1l_upgrade", "upgrade", "head"),
    ]
    defaults = [(database, "pig" if "DISTINCT FROM 'pig'" in statement else "cat")
                for database, statement in fake.statements if "DECLARE fixture_user_id" in statement]
    assert defaults == [
        ("p1l_empty", "pig"), ("p1l_upgrade", "pig"), ("p1l_upgrade", "cat"),
        ("p1l_upgrade", "pig"), ("p1l_restore", "cat"),
    ]
    for environment in fake.environments:
        assert environment["DETACHYM_ENV_FILE"] == ""
        assert environment["SMTP_USER"] == environment["SMTP_PASSWORD"] == ""
        assert urlsplit(environment["DATABASE_URL"]).hostname == "127.0.0.1"
        assert not Path(environment["LOG_DIR"]).parent.exists(), "Owned temporary runtime must be removed"
    seed = next(statement for _, statement in fake.statements if "release-fixture','release@example.test" in statement)
    assert "'cat'" in seed and "'dog'" in seed and "'pig'" in seed
    assert fake.removed == ["owned-container-id"]
    assert fake.backup_created and fake.backup_restored and report["container_removed"]


def test_data_mismatch_fails_and_still_removes_only_owned_container(tmp_path, monkeypatch):
    fake = FakeOwnedPostgres("015", corrupt_upgrade=True)
    monkeypatch.setattr(verifier, "get_migration_head", lambda: "015")
    monkeypatch.setattr(verifier, "command", fake.command)
    report_path = tmp_path / "failed.json"
    assert not verifier.verify("postgres:test-fixture", report_path)
    report = json.loads(report_path.read_text(encoding="utf-8"))
    assert report["status"] == "failed"
    assert fake.removed == ["owned-container-id"]
    assert not fake.backup_restored
