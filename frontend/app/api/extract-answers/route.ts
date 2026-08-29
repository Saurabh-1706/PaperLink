import { NextRequest, NextResponse } from "next/server";
import { getAnswerProvider } from "@/lib/ai/provider";
import type { PageImage, Question, RawAnswerBlock } from "@/types";

export const runtime = "nodejs";
// Rate-limit retries in lib/ai/*.ts can each wait up to ~45s, and a multi-page
// sheet makes multiple sequential batch calls — raised from 60 so a document
// needing more than one retry-backoff doesn't get killed by the function
// timeout before it ever surfaces the underlying error. Confirm your hosting
// plan actually allows this (Vercel Hobby caps functions at 10s regardless of
// this setting; Pro/Enterprise or fluid compute needed for 120s+).
export const maxDuration = 180;

// Answer sheets can run to dozens of pages. Sending them all to the vision
// model in a single call forces it to process every page serially within one
// response and makes it more likely to hit output-token limits on large
// sheets (see the truncation-recovery logic in lib/ai/shared.ts). Splitting
// into small batches keeps each individual call smaller and more reliable —
// safe to do because buildMappings (lib/mapping.ts) already merges answer
// blocks by question number regardless of which call produced them,
// including ones that span a batch boundary.
//
// Batches run sequentially, not concurrently: free-tier rate limits on some
// vision models are as low as 5 requests/minute *per model* (see the 429
// retry logic in lib/ai/gemini.ts), and firing every batch at once for a
// large answer sheet reliably blows through that in a single document.
// Sequential calls naturally space requests out over the document's
// processing time instead of bursting them all in the same second.
const BATCH_SIZE = 4;

export async function POST(req: NextRequest) {
  try {
    const { pages, questions } = (await req.json()) as { pages: PageImage[]; questions: Question[] };
    if (!pages?.length) return NextResponse.json({ error: "No pages provided" }, { status: 400 });
    if (!questions?.length) return NextResponse.json({ error: "No questions provided" }, { status: 400 });

    const provider = getAnswerProvider();

    const batches: PageImage[][] = [];
    for (let i = 0; i < pages.length; i += BATCH_SIZE) batches.push(pages.slice(i, i + BATCH_SIZE));

    const rawAnswers: RawAnswerBlock[] = [];
    for (let batchIndex = 0; batchIndex < batches.length; batchIndex++) {
      const offset = batchIndex * BATCH_SIZE;
      const blocks = await provider.extractAnswers(batches[batchIndex], questions);
      // Each provider's prompt numbers "page" 0-based *within the batch it
      // was given* (see lib/ai/shared.ts / gemini.ts) — remap back to the
      // full document's page indices before merging results together.
      for (const b of blocks) {
        rawAnswers.push({ ...b, regions: b.regions.map((r) => ({ ...r, page: r.page + offset })) });
      }
    }

    return NextResponse.json({ rawAnswers });
  } catch (err: any) {
    return NextResponse.json({ error: err.message ?? "Unknown error" }, { status: 500 });
  }
}
