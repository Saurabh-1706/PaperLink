/**
 * MongoDB client, index setup, and the Unit of Work every repository runs inside.
 * Port of backend/app/db/session.py.
 *
 * Atlas is always a replica set (even the free M0 tier), so — unlike the Python
 * version, which had to degrade gracefully against a standalone local mongod —
 * this always runs inside a real multi-document transaction. That is a genuine
 * simplification, not just a port: there is no MONGO_TRANSACTIONS flag here.
 *
 * The client is cached on the Node global so warm serverless invocations reuse the
 * same connection pool instead of opening a new one per request (the standard
 * pattern for MongoDB + Vercel/Next.js).
 */
import { MongoClient, type Db } from "mongodb";
import { settings } from "@/lib/server/config";
import { newId, type Entity } from "./base";

const INDEXES: Array<{ collection: string; keys: Record<string, 1>; unique: boolean }> = [
  { collection: "users", keys: { email: 1 }, unique: false },
  { collection: "users", keys: { organizationId: 1, email: 1 }, unique: true },
  { collection: "assessments", keys: { organizationId: 1 }, unique: false },
  { collection: "documents", keys: { organizationId: 1, assessmentId: 1 }, unique: false },
  {
    collection: "documents",
    keys: { organizationId: 1, assessmentId: 1, kind: 1, checksum: 1 },
    unique: true,
  },
  { collection: "pages", keys: { organizationId: 1, documentId: 1 }, unique: false },
  { collection: "pages", keys: { documentId: 1, pageNumber: 1 }, unique: true },
  { collection: "blocks", keys: { organizationId: 1, pageId: 1 }, unique: false },
  { collection: "questions", keys: { organizationId: 1, assessmentId: 1 }, unique: false },
  { collection: "question_regions", keys: { organizationId: 1, questionId: 1 }, unique: false },
  { collection: "answers", keys: { organizationId: 1, assessmentId: 1 }, unique: false },
  { collection: "answer_regions", keys: { organizationId: 1, answerId: 1 }, unique: false },
  {
    collection: "mappings",
    keys: { organizationId: 1, assessmentId: 1, reviewStatus: 1 },
    unique: false,
  },
  { collection: "grades", keys: { organizationId: 1, mappingId: 1 }, unique: false },
  { collection: "jobs", keys: { organizationId: 1, assessmentId: 1 }, unique: false },
];

declare global {
  // eslint-disable-next-line no-var
  var __mongoClientPromise: Promise<MongoClient> | undefined;
}

function getClientPromise(): Promise<MongoClient> {
  if (!global.__mongoClientPromise) {
    const client = new MongoClient(settings.mongoUri, { maxPoolSize: 10 });
    const connecting = client.connect();
    // A rejected promise is still a truthy cached value — without this, one failed
    // connection attempt (a transient network blip, Atlas hiccup, etc.) would wedge
    // every request for the rest of the process's life behind the same permanently-
    // rejected promise, since nothing would ever try `new MongoClient(...)` again.
    connecting.catch(() => {
      if (global.__mongoClientPromise === connecting) global.__mongoClientPromise = undefined;
    });
    global.__mongoClientPromise = connecting;
  }
  return global.__mongoClientPromise;
}

export async function getDatabase(): Promise<Db> {
  const client = await getClientPromise();
  return client.db(settings.mongoDbName);
}

export async function ensureIndexes(): Promise<void> {
  const db = await getDatabase();
  const byCollection = new Map<string, typeof INDEXES>();
  for (const spec of INDEXES) {
    const list = byCollection.get(spec.collection) ?? [];
    list.push(spec);
    byCollection.set(spec.collection, list);
  }

  for (const [collection, specs] of byCollection) {
    const coll = db.collection(collection);
    const declaredNames = new Set(specs.map(({ keys }) => indexName(keys)));
    for (const spec of specs) {
      await coll.createIndex(spec.keys, { unique: spec.unique });
    }
    // Drop anything left over from an earlier schema generation (e.g. a prior
    // snake_case naming convention) that isn't declared above — a stale unique
    // index on fields the current models don't populate silently 11000s every
    // insert past the first, since Mongo indexes the missing fields as null.
    const existing = await coll.listIndexes().toArray();
    for (const index of existing) {
      if (index.name === "_id_" || declaredNames.has(index.name!)) continue;
      await coll.dropIndex(index.name!);
    }
  }
}

function indexName(keys: Record<string, 1>): string {
  return Object.entries(keys)
    .map(([field, dir]) => `${field}_${dir}`)
    .join("_");
}

/**
 * Identity map + dirty check over a MongoDB database.
 *
 * Writes are flushed inside a short-lived multi-document transaction (Atlas is
 * always a replica set) so the batch of pages/blocks/etc. that make up one
 * logical change lands atomically. That transaction is scoped to `flush()`
 * itself, not to the request as a whole — an earlier version started it lazily
 * on the first read and held it open for the rest of the request, which meant
 * it was still open across `extractDocument()`'s OCR/LLM calls. Those can run
 * well past MongoDB's ~60s transaction lifetime limit, so the server would
 * abort the transaction out from under a still-running request and every
 * write after that point failed with `NoSuchTransaction`. Reads don't need
 * transactional isolation here (nothing reads back an uncommitted write from
 * earlier in the same request), so they run as plain, session-less finds.
 */
export class UnitOfWork {
  readonly db: Db;
  private readonly client: MongoClient;
  private identity = new Map<string, Entity & { __collection: string }>();
  private snapshots = new Map<string, Record<string, unknown> | undefined>();
  private deleted = new Map<string, { __collection: string; id: string }>();

  constructor(db: Db, client: MongoClient) {
    this.db = db;
    this.client = client;
  }

  private key(collection: string, id: string): string {
    return `${collection}:${id}`;
  }

  /** Register an entity read from Mongo, returning the instance already tracked if
   * there is one — two reads of the same row must not diverge in memory. */
  track<T extends Entity>(collection: string, entity: T): T {
    const key = this.key(collection, entity.id);
    const existing = this.identity.get(key);
    if (existing) return existing as unknown as T;
    const tagged = { ...entity, __collection: collection };
    this.identity.set(key, tagged);
    this.snapshots.set(key, toPlain(entity));
    return tagged as unknown as T;
  }

  add<T extends Entity>(collection: string, entity: T): T {
    const key = this.key(collection, entity.id);
    const tagged = { ...entity, __collection: collection };
    this.identity.set(key, tagged);
    this.snapshots.delete(key); // no snapshot -> treated as an insert on flush
    this.deleted.delete(key);
    return tagged as unknown as T;
  }

  delete(collection: string, id: string): void {
    const key = this.key(collection, id);
    this.identity.delete(key);
    this.snapshots.delete(key);
    this.deleted.set(key, { __collection: collection, id });
  }

  async flush(): Promise<void> {
    const deletes = [...this.deleted.values()];

    const writes: Array<{ key: string; collection: string; toWrite: Record<string, unknown> }> = [];
    for (const [key, entity] of this.identity) {
      const { __collection, ...rest } = entity;
      const document = toPlain(rest as unknown as Entity);
      const snapshot = this.snapshots.get(key);
      if (snapshot && shallowEqual(snapshot, document)) continue;
      if (snapshot) {
        (rest as Entity).updatedAt = new Date();
      }
      writes.push({ key, collection: __collection, toWrite: toPlain(rest as unknown as Entity) });
    }

    if (deletes.length === 0 && writes.length === 0) return;

    const clientSession = this.client.startSession();
    try {
      clientSession.startTransaction();
      for (const { __collection, id } of deletes) {
        await this.db.collection<MongoDoc>(__collection).deleteOne({ _id: id }, { session: clientSession });
      }
      for (const { collection, toWrite } of writes) {
        await this.db
          .collection<MongoDoc>(collection)
          .replaceOne({ _id: toWrite.id as string }, mongoDoc(toWrite), { upsert: true, session: clientSession });
      }
      await clientSession.commitTransaction();
    } catch (err) {
      await clientSession.abortTransaction().catch(() => undefined);
      throw err;
    } finally {
      await clientSession.endSession();
    }

    this.deleted.clear();
    for (const { key, toWrite } of writes) this.snapshots.set(key, toWrite);
  }

  async commit(): Promise<void> {
    await this.flush();
  }

  async rollback(): Promise<void> {
    // Writes already made it to Mongo transactionally inside their own flush()
    // call, so there is nothing left to abort here — this only discards the
    // in-memory identity map so a retried request starts clean.
    this.expireAll();
  }

  expireAll(): void {
    this.identity.clear();
    this.snapshots.clear();
    this.deleted.clear();
  }

  async close(): Promise<void> {
    this.expireAll();
  }
}

interface MongoDoc {
  _id: string;
  [key: string]: unknown;
}

function toPlain(entity: Entity): Record<string, unknown> {
  return JSON.parse(JSON.stringify(entity));
}

function mongoDoc(entity: Record<string, unknown>): Record<string, unknown> {
  const { id, ...rest } = entity;
  return { _id: id, ...rest };
}

function shallowEqual(a: Record<string, unknown>, b: Record<string, unknown>): boolean {
  return JSON.stringify(a) === JSON.stringify(b);
}

/** Request-scoped Unit of Work. Call `.close()` in a `finally` block. */
export async function openSession(): Promise<UnitOfWork> {
  const client = await getClientPromise();
  const db = client.db(settings.mongoDbName);
  return new UnitOfWork(db, client);
}

/** Runs `fn` inside a Unit of Work, committing on success and rolling back on throw. */
export async function withSession<T>(fn: (session: UnitOfWork) => Promise<T>): Promise<T> {
  const session = await openSession();
  try {
    const result = await fn(session);
    await session.commit();
    return result;
  } catch (err) {
    await session.rollback();
    throw err;
  } finally {
    await session.close();
  }
}

export { newId };
