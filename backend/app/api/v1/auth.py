from __future__ import annotations

from fastapi import APIRouter

from app.api.v1.deps import SessionDep
from app.modules.auth.service import AuthService
from app.schemas.api import LoginRequest, RefreshRequest, TokenPair

router = APIRouter(prefix="/auth", tags=["auth"])


@router.post("/login", response_model=TokenPair)
def login(payload: LoginRequest, session: SessionDep) -> TokenPair:
    access, refresh = AuthService(session).login(payload.email, payload.password)
    return TokenPair(access_token=access, refresh_token=refresh)


@router.post("/refresh", response_model=TokenPair)
def refresh(payload: RefreshRequest, session: SessionDep) -> TokenPair:
    access, new_refresh = AuthService(session).refresh(payload.refresh_token)
    return TokenPair(access_token=access, refresh_token=new_refresh)
