import { NextRequest, NextResponse } from "next/server";
import { getProvider } from "@/lib/ai/provider";
import type { PageImage } from "@/lib/types";

export const runtime = "nodejs";
export const maxDuration = 60;

export async function POST(req: NextRequest) {
  try {
    const { pages } = (await req.json()) as { pages: PageImage[] };
    if (!pages?.length) return NextResponse.json({ error: "No pages provided" }, { status: 400 });

    const provider = getProvider();
    const questions = await provider.extractQuestions(pages);
    if (!questions.length) {
      return NextResponse.json(
        { error: "No questions could be extracted from the question paper. Try a clearer scan." },
        { status: 422 }
      );
    }
    return NextResponse.json({ questions });
  } catch (err: any) {
    return NextResponse.json({ error: err.message ?? "Unknown error" }, { status: 500 });
  }
}
