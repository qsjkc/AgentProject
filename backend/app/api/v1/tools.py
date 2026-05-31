from fastapi import APIRouter, Depends

from app.core.security import get_current_user, get_internal_service_identity
from app.models.user import User
from app.services.llm.service import llm_service
from app.services.tools.weather import weather_service

router = APIRouter(prefix="/tools", tags=["工具"])


@router.get("/providers")
async def get_providers(current_user: User = Depends(get_current_user)):
    return {
        "current": llm_service.current_provider,
        "available": llm_service.available_providers,
    }


@router.get("/weather")
async def get_weather(city: str = "Beijing"):
    return await weather_service.get_weather(city)


@router.get("/internal/weather")
async def get_internal_weather(
    city: str = "Beijing",
    _: str = Depends(get_internal_service_identity),
):
    return await weather_service.get_weather(city)
