"""Roles and the capability matrix (docs/05-rbac.md)."""
from __future__ import annotations

from enum import StrEnum

from app.core.errors import PermissionDeniedError


class Role(StrEnum):
    ADMIN = "admin"
    TEACHER = "teacher"
    REVIEWER = "reviewer"


class Permission(StrEnum):
    MANAGE_ORG = "manage_org"
    CREATE_ASSESSMENT = "create_assessment"
    UPLOAD_DOCUMENT = "upload_document"
    TRIGGER_PROCESSING = "trigger_processing"
    READ = "read"
    REVIEW_MAPPING = "review_mapping"
    GRADE = "grade"


_TEACHER = {
    Permission.CREATE_ASSESSMENT,
    Permission.UPLOAD_DOCUMENT,
    Permission.TRIGGER_PROCESSING,
    Permission.READ,
    Permission.GRADE,
    Permission.REVIEW_MAPPING,
}

ROLE_PERMISSIONS: dict[Role, set[Permission]] = {
    Role.ADMIN: {Permission.MANAGE_ORG} | _TEACHER,
    Role.TEACHER: set(_TEACHER),
    # Reviewer reads everything and resolves needs_review; no upload, no delete.
    Role.REVIEWER: {Permission.READ, Permission.REVIEW_MAPPING},
}


def has_permission(role: Role | str, permission: Permission) -> bool:
    try:
        return permission in ROLE_PERMISSIONS[Role(role)]
    except ValueError:
        return False


def assert_permission(role: Role | str, permission: Permission) -> None:
    if not has_permission(role, permission):
        raise PermissionDeniedError(f"Role '{role}' cannot perform '{permission}'.")
