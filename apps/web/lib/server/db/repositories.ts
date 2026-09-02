/**
 * Org-scoped repositories. Port of backend/app/db/repositories/{base,repositories}.py.
 *
 * `organizationId` is a required argument on every method, and every query is built
 * through `scoped()`, which asserts the filter carries it. This is a hard rule
 * (CLAUDE.md: "Repositories take organization_id as a required argument; the base
 * class asserts the query carries the org filter before it reaches Mongo"), not a
 * convention — the assert is what survives a careless query added later.
 */
import type { Filter, Sort } from "mongodb";
import { NotFoundError } from "@/lib/server/errors";
import type { Entity } from "./base";
import { fromMongo } from "./base";
import type { UnitOfWork } from "./session";
import type {
  Answer,
  AnswerRegion,
  Assessment,
  Block,
  Document,
  GradeRow,
  Job,
  MappingRow,
  Page,
  Question,
  QuestionRegion,
  User,
} from "./models";

function assertOrgFilter(query: Record<string, unknown>): void {
  if (!query.organizationId) {
    throw new Error("query is missing its organization scope");
  }
}

abstract class OrgScopedRepository<T extends Entity> {
  protected abstract collectionName: string;
  constructor(protected session: UnitOfWork) {}

  private get collection() {
    return this.session.db.collection(this.collectionName);
  }

  protected scoped(organizationId: string, filters: Record<string, unknown> = {}): Record<string, unknown> {
    if (!organizationId) throw new Error("organizationId is required on every repository query");
    const query: Record<string, unknown> = { organizationId };
    for (const [field, value] of Object.entries(filters)) {
      if (value !== undefined && value !== null) query[field] = value;
    }
    assertOrgFilter(query);
    return query;
  }

  private hydrate(doc: Record<string, unknown> | null): T | null {
    if (!doc) return null;
    return this.session.track(this.collectionName, fromMongo<T>(doc));
  }

  private hydrateAll(docs: Record<string, unknown>[]): T[] {
    return docs.map((d) => this.hydrate(d) as T);
  }

  async findOne(query: Record<string, unknown>): Promise<T | null> {
    assertOrgFilter(query);
    const doc = await this.collection.findOne(query as Filter<Record<string, unknown>>, {
      session: this.session.session,
    });
    return this.hydrate(doc as Record<string, unknown> | null);
  }

  async find(query: Record<string, unknown>, sort?: Sort): Promise<T[]> {
    assertOrgFilter(query);
    let cursor = this.collection.find(query as Filter<Record<string, unknown>>, {
      session: this.session.session,
    });
    if (sort) cursor = cursor.sort(sort);
    const docs = await cursor.toArray();
    return this.hydrateAll(docs as unknown as Record<string, unknown>[]);
  }

  async get(organizationId: string, entityId: string): Promise<T | null> {
    return this.findOne(this.scoped(organizationId, { _id: entityId }));
  }

  async getOrThrow(organizationId: string, entityId: string): Promise<T> {
    const entity = await this.get(organizationId, entityId);
    if (!entity) {
      // 404, not 403 — a 403 would confirm the resource exists in another org.
      throw new NotFoundError("Resource not found.", { id: entityId });
    }
    return entity;
  }

  async list(organizationId: string, filters: Record<string, unknown> = {}): Promise<T[]> {
    return this.find(this.scoped(organizationId, filters));
  }

  add(entity: T): T {
    const withOrg = entity as unknown as { organizationId?: string };
    if (!withOrg.organizationId) throw new Error("cannot persist an entity without organizationId");
    return this.session.add(this.collectionName, entity);
  }

  async delete(organizationId: string, entityId: string): Promise<void> {
    await this.getOrThrow(organizationId, entityId);
    this.session.delete(this.collectionName, entityId);
  }
}

export class UserRepository extends OrgScopedRepository<User> {
  protected collectionName = "users";

  /** Login is the one lookup that cannot be org-scoped: the caller has no token yet. */
  async byEmail(email: string): Promise<User | null> {
    const doc = await this.session.db.collection("users").findOne({
      email: email.toLowerCase(),
      isActive: true,
    });
    return doc ? this.session.track("users", fromMongo<User>(doc as Record<string, unknown>)) : null;
  }
}

export class AssessmentRepository extends OrgScopedRepository<Assessment> {
  protected collectionName = "assessments";
}

export class DocumentRepository extends OrgScopedRepository<Document> {
  protected collectionName = "documents";

  byChecksum(organizationId: string, assessmentId: string, kind: string, checksum: string) {
    return this.findOne(this.scoped(organizationId, { assessmentId, kind, checksum }));
  }
}

export class PageRepository extends OrgScopedRepository<Page> {
  protected collectionName = "pages";

  byNumber(organizationId: string, documentId: string, pageNumber: number) {
    return this.findOne(this.scoped(organizationId, { documentId, pageNumber }));
  }

  forDocument(organizationId: string, documentId: string) {
    return this.find(this.scoped(organizationId, { documentId }), { pageNumber: 1 });
  }
}

export class BlockRepository extends OrgScopedRepository<Block> {
  protected collectionName = "blocks";

  forPage(organizationId: string, pageId: string) {
    return this.find(this.scoped(organizationId, { pageId }), { readingOrder: 1 });
  }
}

export class QuestionRepository extends OrgScopedRepository<Question> {
  protected collectionName = "questions";

  forAssessment(organizationId: string, assessmentId: string) {
    return this.find(this.scoped(organizationId, { assessmentId }), { orderIndex: 1 });
  }
}

export class QuestionRegionRepository extends OrgScopedRepository<QuestionRegion> {
  protected collectionName = "question_regions";

  forQuestions(organizationId: string, questionIds: string[]) {
    if (!questionIds.length) return Promise.resolve([]);
    return this.find(this.scoped(organizationId, { questionId: { $in: questionIds } }));
  }
}

export class AnswerRepository extends OrgScopedRepository<Answer> {
  protected collectionName = "answers";

  forAssessment(organizationId: string, assessmentId: string) {
    return this.find(this.scoped(organizationId, { assessmentId }));
  }
}

export class AnswerRegionRepository extends OrgScopedRepository<AnswerRegion> {
  protected collectionName = "answer_regions";

  forAnswers(organizationId: string, answerIds: string[]) {
    if (!answerIds.length) return Promise.resolve([]);
    return this.find(this.scoped(organizationId, { answerId: { $in: answerIds } }));
  }
}

export class MappingRepository extends OrgScopedRepository<MappingRow> {
  protected collectionName = "mappings";

  forAssessment(organizationId: string, assessmentId: string, reviewStatus?: string) {
    return this.find(this.scoped(organizationId, { assessmentId, reviewStatus }));
  }

  async clearForAssessment(organizationId: string, assessmentId: string) {
    const rows = await this.forAssessment(organizationId, assessmentId);
    for (const row of rows) this.session.delete(this.collectionName, row.id);
  }
}

export class GradeRepository extends OrgScopedRepository<GradeRow> {
  protected collectionName = "grades";

  forMappings(organizationId: string, mappingIds: string[]) {
    if (!mappingIds.length) return Promise.resolve([]);
    return this.find(this.scoped(organizationId, { mappingId: { $in: mappingIds } }));
  }
}

export class JobRepository extends OrgScopedRepository<Job> {
  protected collectionName = "jobs";

  forAssessment(organizationId: string, assessmentId: string) {
    return this.find(this.scoped(organizationId, { assessmentId }));
  }
}
