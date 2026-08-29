from __future__ import annotations

from fastapi import APIRouter

from app.api.v1 import assessments, auth, documents, mappings

api_router = APIRouter(prefix="/api/v1")
api_router.include_router(auth.router)
api_router.include_router(assessments.router)
api_router.include_router(documents.router)
api_router.include_router(mappings.router)
