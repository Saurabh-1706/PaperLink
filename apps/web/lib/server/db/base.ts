/**
 * Entity base shape. Port of backend/app/db/base.py — plain objects, not an ORM;
 * MongoDB stores them whole. `UnitOfWork` (./session.ts) is what tracks and writes
 * them; an entity never talks to the driver itself.
 */
import { randomUUID } from "crypto";

export function newId(): string {
  return randomUUID().replace(/-/g, "");
}

export interface Entity {
  id: string;
  createdAt: Date;
  updatedAt: Date;
}

export interface OrgOwned extends Entity {
  organizationId: string;
  createdBy: string | null;
}

export function newEntity(): Entity {
  const now = new Date();
  return { id: newId(), createdAt: now, updatedAt: now };
}

export function newOrgOwned(organizationId: string, createdBy: string | null = null): OrgOwned {
  return { ...newEntity(), organizationId, createdBy };
}

/** Entity -> Mongo document: `id` becomes `_id`. */
export function toMongo<T extends Entity>(entity: T): Record<string, unknown> {
  const { id, ...rest } = entity as unknown as Record<string, unknown>;
  return { _id: id, ...rest };
}

/** Mongo document -> Entity: `_id` becomes `id`. Unknown keys pass through untouched
 * (a schemaless store outlives any one version of this code — see base.py's
 * from_mongo, which drops unknown keys instead; we keep them since TS has no runtime
 * field list to filter against, and callers only ever read the fields they know). */
export function fromMongo<T extends Entity>(doc: Record<string, unknown>): T {
  const { _id, ...rest } = doc;
  return { id: _id as string, ...rest } as T;
}
