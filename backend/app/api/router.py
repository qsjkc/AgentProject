from fastapi import APIRouter

from app.api.v1 import admin, auth, chat, public, rag, tools, users

api_router = APIRouter()

api_router.include_router(auth.router)
api_router.include_router(chat.router)
api_router.include_router(rag.router)
api_router.include_router(users.router)
api_router.include_router(admin.router)
api_router.include_router(public.router)
api_router.include_router(tools.router)
