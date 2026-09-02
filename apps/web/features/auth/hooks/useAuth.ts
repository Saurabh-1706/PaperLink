"use client";

import { useContext } from "react";
import { AuthContext, type AuthContextValue } from "../store/AuthProvider";

export function useAuth(): AuthContextValue {
  const ctx = useContext(AuthContext);
  if (!ctx) throw new Error("useAuth must be used inside <AuthProvider>.");
  return ctx;
}
