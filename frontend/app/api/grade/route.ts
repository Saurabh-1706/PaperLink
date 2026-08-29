import { NextRequest, NextResponse } from "next/server";
import { getProvider } from "@/lib/ai/provider";
import { buildMappings, buildSummary } from "@/lib/mapping";
import type { Question, RawAnswerBlock } from "@/lib/types";

export const runtime = "nodejs";
export const maxDuration = 60;

export async function POST(req: NextRequest) {
  try {
    const { questions, rawAnswers } = (await req.json()) as {
      questions: Question[];
      rawAnswers: RawAnswerBlock[];
    };

    const { mappings, unmatched } = buildMappings(questions, rawAnswers);

    const answered = mappings
      .filter((m) => m.status === "answered")
      .map((m) => ({ questionNumber: m.questionNumber!, text: m.answerText ?? "" }));

    let grades: {
      questionNumber: string;
      isCorrect: boolean | null;
      score: number | null;
      maxScore: number | null;
      feedback: string;
    }[] = [];

    if (answered.length) {
      try {
        const provider = getProvider();
        grades = await provider.gradeAnswers(questions, answered);
      } catch {
        // Grading is best-effort — mapping/highlighting must still work if it fails.
        grades = [];
      }
    }

    const gradeMap = new Map(grades.map((g) => [g.questionNumber, g]));
    const gradedMappings = mappings.map((m) => {
      if (m.status !== "answered") return m;
      const g = gradeMap.get(m.questionNumber!);
      if (!g) return m;
      return { ...m, isCorrect: g.isCorrect, score: g.score, maxScore: g.maxScore, feedback: g.feedback };
    });

    const summary = buildSummary(questions, gradedMappings, unmatched);

    return NextResponse.json({
      mappings: [...gradedMappings, ...unmatched],
      summary,
    });
  } catch (err: any) {
    return NextResponse.json({ error: err.message ?? "Unknown error" }, { status: 500 });
  }
}
