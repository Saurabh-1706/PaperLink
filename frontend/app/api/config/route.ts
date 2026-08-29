import { NextResponse } from "next/server";

export const runtime = "nodejs";

/** Lets the client know which AI provider(s) are active without exposing keys. */
export async function GET() {
  const provider = (process.env.AI_PROVIDER || "").toLowerCase();
  // Answer extraction can run on a different provider than the rest of the
  // pipeline (see ANSWER_PROVIDER in lib/ai/provider.ts) — the client needs
  // to know which one specifically, since only Gemini has native bounding-box
  // grounding and should skip the coordinate-grid overlay other providers need.
  const answerProvider = (process.env.ANSWER_PROVIDER || "").toLowerCase() || provider;
  return NextResponse.json({ provider, answerProvider });
}
