import argparse
import asyncio

from sqlalchemy import select

from app.core.security import get_password_hash
from app.models.database import UserPreference, async_session_maker, init_db
from app.models.user import User


async def ensure_preferences(user_id: int, session) -> None:
    result = await session.execute(select(UserPreference).where(UserPreference.user_id == user_id))
    if result.scalar_one_or_none():
        return
    session.add(UserPreference(user_id=user_id))


async def create_or_promote_admin(username: str, email: str | None, password: str | None) -> None:
    async with async_session_maker() as session:
        username_result = await session.execute(
            select(User).where(User.username == username)
        )
        username_user = username_result.scalar_one_or_none()

        email_user = None
        if email:
            email_result = await session.execute(
                select(User).where(User.email == email)
            )
            email_user = email_result.scalar_one_or_none()

        if username_user and email_user and username_user.id != email_user.id:
            raise SystemExit("Username and email belong to different users. Resolve the conflict first.")

        user = username_user or email_user
        if user:
            if email:
                user.email = email
            if password:
                user.hashed_password = get_password_hash(password)
            user.status = "active"
            user.is_active = True
            user.is_superuser = True
            await ensure_preferences(user.id, session)
            await session.commit()
            print(f"Promoted existing user '{user.username}' to admin.")
            return

        if not email or not password:
            raise SystemExit("Creating a new admin requires both --email and --password.")

        user = User(
            username=username,
            email=email,
            hashed_password=get_password_hash(password),
            status="active",
            is_active=True,
            is_superuser=True,
        )
        session.add(user)
        await session.flush()
        await ensure_preferences(user.id, session)
        await session.commit()
        print(f"Created admin user '{username}'.")


def parse_args() -> argparse.Namespace:
    parser = argparse.ArgumentParser(description="Create or promote a Detachym admin user.")
    parser.add_argument("--username", required=True, help="Username to create or promote.")
    parser.add_argument("--email", help="Email for the admin account.")
    parser.add_argument("--password", help="Password for the admin account.")
    return parser.parse_args()


async def main() -> None:
    args = parse_args()
    await init_db()
    await create_or_promote_admin(args.username, args.email, args.password)


if __name__ == "__main__":
    asyncio.run(main())
