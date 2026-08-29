"""Authentication and user provisioning."""
from __future__ import annotations

from app.core.errors import AuthenticationError, ConflictError
from app.core.permissions import Role
from app.core.security import (
    create_access_token,
    create_refresh_token,
    decode_token,
    hash_password,
    verify_password,
)
from app.db.models import Organization, User
from app.db.repositories import UserRepository
from app.db.session import UnitOfWork


class AuthService:
    def __init__(self, session: UnitOfWork) -> None:
        self.session = session
        self.users = UserRepository(session)

    def create_organization(self, name: str) -> Organization:
        organization = Organization(name=name)
        self.session.add(organization)
        self.session.flush()
        return organization

    def create_user(
        self, organization_id: str, email: str, password: str, role: Role | str
    ) -> User:
        email = email.lower()
        if self.users.by_email(email) is not None:
            raise ConflictError("A user with that email already exists.", email=email)
        user = User(
            organization_id=organization_id,
            email=email,
            hashed_password=hash_password(password),
            role=str(Role(role)),
        )
        self.users.add(user)
        return user

    def login(self, email: str, password: str) -> tuple[str, str]:
        user = self.users.by_email(email.lower())
        if user is None or not verify_password(password, user.hashed_password):
            # Same error either way: never reveal whether an account exists.
            raise AuthenticationError("Invalid email or password.")
        return (
            create_access_token(user.id, user.organization_id, user.role),
            create_refresh_token(user.id, user.organization_id, user.role),
        )

    def refresh(self, refresh_token: str) -> tuple[str, str]:
        payload = decode_token(refresh_token, expected_type="refresh")
        return (
            create_access_token(str(payload["sub"]), str(payload["org"]), str(payload["role"])),
            create_refresh_token(str(payload["sub"]), str(payload["org"]), str(payload["role"])),
        )
