from fastapi import APIRouter, Depends
from app.services.llm.service import llm_service
from app.core.security import get_current_user
from app.models.user import User

router = APIRouter(prefix="/tools", tags=["工具"])


@router.get("/providers")
async def get_providers(current_user: User = Depends(get_current_user)):
    return {
        "current": llm_service.current_provider,
        "available": llm_service.available_providers
    }


@router.get("/weather")
async def get_weather(city: str = "Beijing"):
    return {
        "city": city,
        "weather": "Sunny",
        "temperature": "25°C",
        "note": "天气工具将在后续阶段实现真实API调用"
    }
