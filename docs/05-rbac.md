# RBAC & Tenancy

**Status:** Implemented (Phase 1)
**Module:** `app/core/permissions.py`, `app/modules/auth/`

```
Organization
 └── Users
      ├── Admin
      ├── Teacher
      └── Reviewer
```

## Roles

| Role | Can |
|---|---|
| **Admin** | Manage the organization and its users, plus everything a Teacher can do |
| **Teacher** | Create assessments, upload documents, trigger processing, grade |
| **Reviewer** | Read everything in the org; resolve `needs_review` mappings. **No upload, no delete** |

The Reviewer role exists because the mapping engine deliberately produces
`needs_review` states rather than guessing. Someone must be able to resolve those
without being able to alter the source documents.

## Tenant scoping

Every resource carries `organization_id`, `created_by` and (where applicable)
`assessment_id`.

Two mechanisms, belt and braces:

1. **`TenantScope` dependency** — resolves `organization_id` from the JWT on every route.
2. **Org-scoped repository base** — every repository method takes `organization_id` as a
   required argument, and the base class **asserts in code** that a query carries an org
   filter. Convention alone is not enough; the assert is what survives a careless
   `session.query()` added six months from now.

## 404, not 403

Cross-tenant access returns **404**. A 403 tells the caller the resource exists, which
leaks the existence of another organization's assessments.

## What must never happen

> Never expose another tenant's documents, questions, answers or results.

This includes the page-image route — a rendered answer sheet is as sensitive as the text
extracted from it.

## Verification

The Phase 1 exit criterion is an integration suite that walks **every route** as org B
against org A's resources and asserts 404 on each. It runs in CI, not by hand.
