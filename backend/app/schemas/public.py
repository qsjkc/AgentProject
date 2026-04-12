from datetime import datetime
from typing import Optional

from pydantic import BaseModel


class DesktopReleaseResponse(BaseModel):
    platform: str
    version: str
    filename: str
    download_url: str
    available: bool
    published_at: Optional[datetime] = None
