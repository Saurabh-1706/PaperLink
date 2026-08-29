import Link from "next/link";
import { Can } from "@/components/rbac/Can";
import { getServerSession } from "@/lib/auth/serverSession";

export const metadata = { title: "Dashboard · VedaAI" };

export default function DashboardPage() {
  const user = getServerSession();

  return (
    <div className="animate-fade-in-up w-full max-w-4xl mx-auto px-gutter py-16">
      <h1 className="font-headline-xl text-headline-xl text-on-surface">
        Welcome back{user ? `, ${user.name.split(" ")[0]}` : ""}
      </h1>
      <p className="mt-4 font-body-lg text-body-lg text-on-surface-variant max-w-2xl">
        Digitize a question paper and a student answer sheet, map every answer to its
        question, and review the result with the original handwriting side by side.
      </p>

      <div className="mt-12 flex flex-wrap gap-4">
        <Can
          permission="upload_document"
          fallback={
            <Link
              href="/assessments"
              className="group flex items-center gap-4 rounded-full bg-primary px-8 py-4 text-on-primary shadow-lg shadow-primary/20 transition-transform hover:scale-105 active:scale-95"
            >
              <div className="font-headline-md text-headline-md">Review Assessments</div>
              <span className="material-symbols-outlined text-[32px] transition-transform group-hover:translate-x-1">
                arrow_forward
              </span>
            </Link>
          }
        >
          <Link
            href="/assessments"
            className="group flex items-center gap-4 rounded-full bg-primary px-8 py-4 text-on-primary shadow-lg shadow-primary/20 transition-transform hover:scale-105 active:scale-95"
          >
            <div className="font-headline-md text-headline-md">New Assessment</div>
            <span className="material-symbols-outlined text-[32px] transition-transform group-hover:translate-x-1">
              arrow_forward
            </span>
          </Link>
        </Can>

        <Link
          href="/library"
          className="group flex items-center gap-3 rounded-2xl border border-outline-variant/40 bg-white/80 px-8 py-4 shadow-sm backdrop-blur-md transition-all hover:bg-surface-container-low hover:shadow-md"
        >
          <div className="flex h-10 w-10 items-center justify-center rounded-xl bg-tertiary-container/10 transition-colors group-hover:bg-tertiary-container/20">
            <span className="material-symbols-outlined text-tertiary">library_books</span>
          </div>
          <div className="text-left">
            <div className="font-label-md text-label-md text-on-surface">Browse Library</div>
            <div className="font-label-sm text-label-sm text-on-surface-variant">
              Documents from past classes
            </div>
          </div>
        </Link>
      </div>
    </div>
  );
}
