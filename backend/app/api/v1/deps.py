"""Request dependencies: authentication, tenant scope, role checks."""
from __future__ import annotations

from dataclasses import dataclass
from typing import Annotated

from fastapi import Depends, Header

from app.core.errors import AuthenticationError
from app.core.permissions import Permission, assert_permission
from app.core.security import decode_token
from app.db.session import UnitOfWork, get_session
from app.storage.base import StorageBackend
from app.storage.factory import get_storage


@dataclass(frozen=True)
class Principal:
    user_id: str
    organization_id: str
    role: str


def current_principal(authorization: Annotated[str | None, Header()] = None) -> Principal:
    if not authorization or not authorization.lower().startswith("bearer "):
        raise AuthenticationError()
    payload = decode_token(authorization.split(" ", 1)[1], expected_type="access")
    return Principal(
        user_id=str(payload["sub"]),
        organization_id=str(payload["org"]),
        role=str(payload["role"]),
    )


PrincipalDep = Annotated[Principal, Depends(current_principal)]
SessionDep = Annotated[UnitOfWork, Depends(get_session)]
StorageDep = Annotated[StorageBackend, Depends(get_storage)]


def require(permission: Permission):
    """`TenantScope` + role gate in one dependency: every route resolves the org from
    the token, never from the request body."""

    def dependency(principal: PrincipalDep) -> Principal:
        assert_permission(principal.role, permission)
        return principal

    return dependency
