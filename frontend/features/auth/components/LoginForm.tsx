"use client";

import { useState } from "react";
import { useRouter, useSearchParams } from "next/navigation";
import { errorMessage } from "@/lib/api/errors";
import { useAuth } from "../hooks/useAuth";

export default function LoginForm() {
  const { login } = useAuth();
  const router = useRouter();
  const next = useSearchParams().get("next") ?? "/dashboard";

  const [email, setEmail] = useState("");
  const [password, setPassword] = useState("");
  const [error, setError] = useState<string | null>(null);
  const [submitting, setSubmitting] = useState(false);

  async function handleSubmit(e: React.FormEvent) {
    e.preventDefault();
    setError(null);
    setSubmitting(true);
    try {
      await login({ email, password });
      router.replace(next);
      router.refresh();
    } catch (err) {
      setError(errorMessage(err, "Could not sign in."));
      setSubmitting(false);
    }
  }

  return (
    <form
      onSubmit={handleSubmit}
      className="w-full max-w-md rounded-3xl border border-outline-variant/30 bg-surface-container-lowest p-8 shadow-sm"
    >
      <div className="mb-8 flex flex-col items-center gap-3 text-center">
        {/* eslint-disable-next-line @next/next/no-img-element */}
        <img alt="VedaAI Logo" className="h-10 w-auto object-contain" src="/veda_ai_logo.png" />
        <h1 className="font-headline-lg text-on-surface tracking-tight">Sign in to VedaAI</h1>
        <p className="font-body-md text-on-surface-variant">
          Use your organization account to continue.
        </p>
      </div>

      <label className="mb-4 block">
        <span className="font-label-sm text-on-surface-variant uppercase tracking-wider">Email</span>
        <input
          type="email"
          value={email}
          onChange={(e) => setEmail(e.target.value)}
          required
          autoComplete="email"
          className="mt-1.5 w-full rounded-xl border border-outline-variant/50 bg-surface-container-low px-4 py-3 font-body-md text-on-surface outline-none transition-shadow focus:ring-2 focus:ring-primary/50"
        />
      </label>

      <label className="mb-6 block">
        <span className="font-label-sm text-on-surface-variant uppercase tracking-wider">Password</span>
        <input
          type="password"
          value={password}
          onChange={(e) => setPassword(e.target.value)}
          required
          autoComplete="current-password"
          className="mt-1.5 w-full rounded-xl border border-outline-variant/50 bg-surface-container-low px-4 py-3 font-body-md text-on-surface outline-none transition-shadow focus:ring-2 focus:ring-primary/50"
        />
      </label>

      {error && (
        <div className="mb-6 rounded-xl border border-error bg-error-container p-3 text-center font-label-md text-on-error-container">
          <span className="material-symbols-outlined mr-2 inline-block align-bottom text-[18px]">error</span>
          {error}
        </div>
      )}

      <button
        type="submit"
        disabled={submitting}
        className="flex w-full items-center justify-center gap-2 rounded-full bg-primary px-6 py-3.5 font-label-md text-on-primary shadow-md transition-transform hover:scale-[1.02] active:scale-95 disabled:pointer-events-none disabled:opacity-60"
      >
        <span className="material-symbols-outlined text-[20px]">{submitting ? "sync" : "login"}</span>
        {submitting ? "Signing in…" : "Sign in"}
      </button>
    </form>
  );
}
