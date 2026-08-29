import Link from "next/link";

export const metadata = { title: "Not permitted · VedaAI" };

export default function ForbiddenPage() {
  return (
    <div className="flex min-h-screen w-full flex-col items-center justify-center gap-4 bg-background px-gutter text-center">
      <div className="flex h-20 w-20 items-center justify-center rounded-full bg-error-container text-error">
        <span className="material-symbols-outlined text-[40px]">lock</span>
      </div>
      <h1 className="font-headline-lg text-on-surface tracking-tight">You don&apos;t have access to this</h1>
      <p className="font-body-md text-on-surface-variant max-w-md">
        Your role doesn&apos;t include this area. Ask an administrator if you think that&apos;s wrong.
      </p>
      <Link
        href="/dashboard"
        className="mt-2 flex items-center gap-2 rounded-full bg-primary px-5 py-2.5 font-label-md text-on-primary shadow-md transition-transform hover:scale-105 active:scale-95"
      >
        <span className="material-symbols-outlined text-[20px]">arrow_back</span>
        Back to dashboard
      </Link>
    </div>
  );
}
