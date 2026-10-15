from datetime import UTC, datetime
from pathlib import Path
from stat import S_ISREG

from fastapi import APIRouter

from app.core.config import settings
from app.schemas.public import DesktopReleaseResponse

router = APIRouter(prefix="/public", tags=["public"])


@router.get("/version/win-x64", response_model=DesktopReleaseResponse)
async def get_windows_release() -> DesktopReleaseResponse:
    release_path = Path(settings.DOWNLOAD_DIR) / settings.DESKTOP_RELEASE_FILE
    published_at = None
    try:
        release_stat = release_path.stat()
    except FileNotFoundError:
        release_stat = None
    available = release_stat is not None and S_ISREG(release_stat.st_mode)
    if available:
        published_at = datetime.fromtimestamp(release_stat.st_mtime, tz=UTC)

    return DesktopReleaseResponse(
        platform="win-x64",
        version=settings.DESKTOP_RELEASE_VERSION,
        filename=settings.DESKTOP_RELEASE_FILE,
        download_url=f"{settings.DESKTOP_DOWNLOAD_BASE}/{settings.DESKTOP_RELEASE_FILE}",
        available=available,
        published_at=published_at,
    )
