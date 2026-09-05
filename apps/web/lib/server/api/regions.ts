/**
 * Region assembly for read routes. Port of backend/app/api/v1/regions.py.
 *
 * A mapped answer that continues onto a later page owns regions on several rows;
 * the UI must receive all of them, so continuation children are folded in here.
 */
import type { UnitOfWork } from "@/lib/server/db/session";
import { AnswerRegionRepository, AnswerRepository } from "@/lib/server/db/repositories";
import type { Answer } from "@/lib/server/db/models";
import type { Region } from "@/lib/server/modules/common";

/** Regions per answer id, including every continuation segment of that answer. */
export async function answerRegions(
  session: UnitOfWork,
  organizationId: string,
  assessmentId: string
): Promise<Map<string, Region[]>> {
  const rows: Answer[] = await new AnswerRepository(session).forAssessment(organizationId, assessmentId);
  const regionRows = await new AnswerRegionRepository(session).forAnswers(organizationId, rows.map((r) => r.id));

  const byRow = new Map<string, Region[]>();
  for (const region of regionRows) {
    const list = byRow.get(region.answerId) ?? [];
    list.push({
      page: region.pageNumber,
      bbox: { x1: region.bbox[0], y1: region.bbox[1], x2: region.bbox[2], y2: region.bbox[3] },
    });
    byRow.set(region.answerId, list);
  }

  const byExternal = new Map(rows.map((row) => [row.externalId, row]));
  const children = new Map<string, Answer[]>();
  for (const row of rows) {
    if (row.isContinuationOf && byExternal.has(row.isContinuationOf)) {
      const parent = byExternal.get(row.isContinuationOf)!;
      const list = children.get(parent.id) ?? [];
      list.push(row);
      children.set(parent.id, list);
    }
  }

  const out = new Map<string, Region[]>();
  for (const row of rows) {
    const collected = [...(byRow.get(row.id) ?? [])];
    const cursor: Answer[] = [row];
    while (cursor.length > 0) {
      const current = cursor.pop()!;
      for (const child of children.get(current.id) ?? []) {
        collected.push(...(byRow.get(child.id) ?? []));
        cursor.push(child);
      }
    }
    collected.sort((a, b) => (a.page !== b.page ? a.page - b.page : a.bbox.y1 - b.bbox.y1));
    out.set(row.id, collected);
  }
  return out;
}
