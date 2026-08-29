import { Suspense } from "react";
import LoginForm from "@/features/auth/components/LoginForm";

export const metadata = { title: "Sign in · VedaAI" };

export default function LoginPage() {
  return (
    <div className="flex min-h-screen w-full items-center justify-center bg-background px-gutter py-12">
      <Suspense>
        <LoginForm />
      </Suspense>
    </div>
  );
}
