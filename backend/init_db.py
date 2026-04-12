import asyncio

from app.main import seed_initial_admin
from app.models.database import init_db


async def main():
    await init_db()
    await seed_initial_admin()
    print("Database initialized successfully")


if __name__ == "__main__":
    asyncio.run(main())
