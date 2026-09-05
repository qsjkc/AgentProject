"""Verify release migrations and services using an owned, disposable PostgreSQL.

Run from backend/: python scripts/verify_postgres_release.py --report ../P1L-postgres-verification.json
Requires Docker and the backend requirements. Never connects to configured business databases.
"""

import argparse
import asyncio
import json
import os
from pathlib import Path
import secrets
import subprocess
import sys
import time
from uuid import uuid4


ROOT = Path(__file__).resolve().parents[1]


def command(*args, env=None, timeout=120):
    result = subprocess.run(
        args, cwd=ROOT, env=env, capture_output=True, text=True,
        encoding="utf-8", errors="replace", timeout=timeout,
    )
    if result.returncode:
        # Do not echo connection strings or environment values in reports.
        raise RuntimeError(f"{Path(args[0]).name} exited {result.returncode}: {result.stderr[-3000:]}")
    return result.stdout.strip()


async def probe():
    """Run in a subprocess so cached settings only see the disposable database."""
    sys.path.insert(0, str(ROOT))
    from sqlalchemy import inspect, select, text
    from app.models.database import (
        Base, PetRelationship, User, async_session_maker, engine,
    )
    from app.services.pet_relationships import (
        acknowledge_pet_relationship_milestone, award_pet_relationship,
        claim_pet_relationship_milestone, get_pet_weekly_summary,
    )
    from app.services.pet_retention import get_weekly_review_funnel

    try:
        async with engine.begin() as connection:
            revision = (await connection.execute(text("select version_num from alembic_version"))).scalar_one()
            assert revision == "014", revision

            def compare_columns(sync_connection):
                inspector = inspect(sync_connection)
                for table in Base.metadata.sorted_tables:
                    actual = {column["name"] for column in inspector.get_columns(table.name)}
                    assert set(table.columns.keys()) <= actual, table.name

            await connection.run_sync(compare_columns)
        async with async_session_maker() as session:
            user = (await session.execute(select(User).where(User.username == "release-fixture"))).scalar_one()
            user_id = user.id
            relationship = (await session.execute(select(PetRelationship).where(
                PetRelationship.user_id == user_id, PetRelationship.pet_type == "pig",
            ))).scalar_one()
            assert relationship.intimacy_xp == 99
            result = await award_pet_relationship(
                session, user_id=user_id, pet_type="pig", action="poke",
                idempotency_key="p1l-level-two",
            )
            assert result["relationship"]["level"] == 2, result

        tokens = [str(uuid4()), str(uuid4())]

        async def claim(token):
            async with async_session_maker() as session:
                return await claim_pet_relationship_milestone(
                    session, user_id=user_id, pet_type="pig", claim_token=token,
                )

        claims = await asyncio.gather(*(claim(token) for token in tokens))
        winners = [item for item in claims if item]
        assert len(winners) == 1, "Concurrent clients must have one milestone winner"
        winner = winners[0]
        async with async_session_maker() as session:
            receipt = await acknowledge_pet_relationship_milestone(
                session, milestone_id=winner["id"], user_id=user_id,
                pet_type="pig", claim_token=winner["claim_token"],
            )
            assert receipt["acknowledged_at"]
            duplicate = await acknowledge_pet_relationship_milestone(
                session, milestone_id=winner["id"], user_id=user_id,
                pet_type="pig", claim_token=winner["claim_token"],
            )
            assert duplicate["acknowledged_at"] == receipt["acknowledged_at"]
            summary = await get_pet_weekly_summary(session, user_id=user_id, pet_type="pig")
            assert summary["pet_type"] == "pig"
            await get_weekly_review_funnel(session, pet_type="pig", limit=12)
        return {
            "schema_revision": revision, "orm_columns_present": True,
            "old_relationship_readable": True, "reward_write": True,
            "concurrent_milestone_winners": len(winners), "ack_idempotent": True,
            "weekly_summary_and_funnel_readable": True,
        }
    finally:
        await engine.dispose()


def verify(image, report_path):
    name = f"detachym-release-check-{uuid4().hex[:12]}"
    password = secrets.token_hex(16)
    container_id = None
    report = {"status": "running", "image": image, "checks": {}, "container_removed": False}
    try:
        container_id = command(
            "docker", "run", "--rm", "--name", name,
            "--label", "detachym.owner=postgres-release-check",
            "-e", f"POSTGRES_PASSWORD={password}", "-e", "POSTGRES_DB=p1l_empty",
            "-p", "127.0.0.1::5432", "-d", image,
        )
        deadline = time.monotonic() + 45
        while True:
            try:
                command("docker", "exec", container_id, "pg_isready", "-U", "postgres", timeout=10)
                break
            except RuntimeError:
                if time.monotonic() >= deadline:
                    raise
                time.sleep(0.5)
        address = command("docker", "port", container_id, "5432/tcp")
        assert address.startswith("127.0.0.1:"), address
        port = int(address.rsplit(":", 1)[1])

        def environment(database):
            return {
                **os.environ,
                "DATABASE_URL": f"postgresql+asyncpg://postgres:{password}@127.0.0.1:{port}/{database}",
                "DEBUG": "false", "SMTP_USER": "", "SMTP_PASSWORD": "",
                "REMINDER_EMAIL_WORKER_ENABLED": "false",
                "REMINDER_RECURRENCE_WORKER_ENABLED": "false",
            }

        def sql(database, statement):
            return command("docker", "exec", container_id, "psql", "-v", "ON_ERROR_STOP=1",
                           "-U", "postgres", "-d", database, "-Atc", statement)

        def migrate(database, action, revision):
            command(sys.executable, "-m", "alembic", action, revision, env=environment(database))

        migrate("p1l_empty", "upgrade", "head")
        assert sql("p1l_empty", "select version_num from alembic_version") == "014"
        report["checks"]["empty_to_head"] = True
        sql("postgres", "create database p1l_upgrade")
        migrate("p1l_upgrade", "upgrade", "010")
        sql("p1l_upgrade", """
            insert into users (username,email,hashed_password,created_at,updated_at)
            values ('release-fixture','release@example.test','not-a-login-hash',now(),now());
            insert into pet_relationships (user_id,pet_type,intimacy_xp,created_at,updated_at)
            select id,'pig',99,now(),now() from users where username='release-fixture';
            insert into reminders (user_id,pet_type,title,remind_at,created_at,updated_at,email_enabled,email_status)
            select id,'pig','release reminder',now(),now(),now(),false,'disabled'
            from users where username='release-fixture';
        """)
        fingerprint_sql = """
            select json_build_object(
                'users',(select json_agg(row(id,username,email)) from users),
                'pets',(select json_agg(row(user_id,pet_type,intimacy_xp)) from pet_relationships),
                'reminders',(select json_agg(row(user_id,title,status)) from reminders)
            )::text
        """
        before = sql("p1l_upgrade", fingerprint_sql)
        command("docker", "exec", container_id, "pg_dump", "-U", "postgres",
                "-d", "p1l_upgrade", "-Fc", "-f", "/tmp/p1l-before-upgrade.dump")
        migrate("p1l_upgrade", "upgrade", "head")
        assert sql("p1l_upgrade", fingerprint_sql) == before
        report["checks"]["010_to_014_preserves_data"] = True
        migrate("p1l_upgrade", "downgrade", "010")
        assert sql("p1l_upgrade", fingerprint_sql) == before
        migrate("p1l_upgrade", "upgrade", "head")
        report["checks"]["synthetic_upgrade_downgrade_upgrade"] = True
        probe_output = command(sys.executable, str(Path(__file__).resolve()), "--probe",
                               env=environment("p1l_upgrade"))
        report["checks"]["postgres_services"] = json.loads(probe_output.splitlines()[-1])

        # Restore the pre-upgrade backup into a distinct database. A rollback in
        # production requires the matching old app; downgrade alone is not a backup.
        sql("postgres", "create database p1l_restore")
        command("docker", "exec", container_id, "pg_restore", "--exit-on-error",
                "-U", "postgres", "-d", "p1l_restore", "/tmp/p1l-before-upgrade.dump")
        assert sql("p1l_restore", "select version_num from alembic_version") == "010"
        assert sql("p1l_restore", fingerprint_sql) == before
        sql("p1l_restore", "update reminders set title='restored write' where title='release reminder'")
        assert sql("p1l_restore", "select count(*) from reminders where title='restored write'") == "1"
        report["checks"]["backup_restore_read_write"] = True
        report["status"] = "passed"
    except Exception as error:
        report["status"] = "failed"
        report["error"] = str(error).replace(password, "[redacted]")
    finally:
        if container_id:
            try:
                # Only the exact ID created by this invocation, with no host mounts.
                command("docker", "rm", "-f", "-v", container_id)
                report["container_removed"] = True
            except Exception as error:
                report["status"] = "failed"
                report["cleanup_error"] = str(error).replace(password, "[redacted]")
        serialized = json.dumps(report, ensure_ascii=False, indent=2)
        if report_path:
            Path(report_path).resolve().write_text(serialized + "\n", encoding="utf-8")
        print(serialized)
    return report["status"] == "passed"


if __name__ == "__main__":
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument("--image", default="postgres:14-alpine")
    parser.add_argument("--report")
    parser.add_argument("--probe", action="store_true", help=argparse.SUPPRESS)
    args = parser.parse_args()
    if args.probe:
        print(json.dumps(asyncio.run(probe())))
    else:
        sys.exit(0 if verify(args.image, args.report) else 1)
