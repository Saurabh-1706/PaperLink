import type { UnitOfWork } from "@/lib/server/db/session";
import { GridFSStorage } from "./gridfs";

export function getStorage(session: UnitOfWork): GridFSStorage {
  return new GridFSStorage(session.db);
}
