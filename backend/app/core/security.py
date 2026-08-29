"""Password hashing and JWT issuing/verification."""
from __future__ import annotations

import time
import uuid
from typing import Any

import jwt
from argon2 import PasswordHasher
from argon2.exceptions import VerificationError, VerifyMismatchError

from app.core.config import settings
from app.core.errors import AuthenticationError

_hasher = PasswordHasher()


def hash_password(password: str) -> str:
    return _hasher.hash(password)


def verify_password(password: str, hashed: str) -> bool:
    try:
        return _hasher.verify(hashed, password)
    except (VerifyMismatchError, VerificationError):
        return False


def _encode(subject: str, org_id: str, role: str, ttl: int, token_type: str) -> str:
    now = int(time.time())
    payload = {
        "sub": subject,
        "org": org_id,
        "role": role,
        "type": token_type,
        "iat": now,
        "exp": now + ttl,
        "jti": uuid.uuid4().hex,
    }
    return jwt.encode(payload, settings.jwt_secret, algorithm=settings.jwt_algorithm)


def create_access_token(subject: str, org_id: str, role: str) -> str:
    return _encode(subject, org_id, role, settings.jwt_access_ttl_seconds, "access")


def create_refresh_token(subject: str, org_id: str, role: str) -> str:
    return _encode(subject, org_id, role, settings.jwt_refresh_ttl_seconds, "refresh")


def decode_token(token: str, expected_type: str = "access") -> dict[str, Any]:
    try:
        payload = jwt.decode(token, settings.jwt_secret, algorithms=[settings.jwt_algorithm])
    except jwt.PyJWTError as exc:  # expired, malformed, or bad signature
        raise AuthenticationError("Token is invalid or expired.") from exc
    if payload.get("type") != expected_type:
        raise AuthenticationError("Wrong token type.")
    return payload
