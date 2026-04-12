from datetime import datetime
from pathlib import Path

from fastapi import APIRouter

from app.core.config import settings
from app.schemas.public import DesktopReleaseResponse

router = APIRouter(prefix="/public", tags=["public"])


@router.get("/version/win-x64", response_model=DesktopReleaseResponse)
async def get_windows_release() -> DesktopReleaseResponse:
    release_path = Path(settings.DOWNLOAD_DIR) / settings.DESKTOP_RELEASE_FILE
    published_at = None
    if release_path.exists():
        published_at = datetime.fromtimestamp(release_path.stat().st_mtime)

    return DesktopReleaseResponse(
        platform="win-x64",
        version=settings.DESKTOP_RELEASE_VERSION,
        filename=settings.DESKTOP_RELEASE_FILE,
        download_url=f"{settings.DESKTOP_DOWNLOAD_BASE}/{settings.DESKTOP_RELEASE_FILE}",
        available=release_path.exists(),
        published_at=published_at,
    )
