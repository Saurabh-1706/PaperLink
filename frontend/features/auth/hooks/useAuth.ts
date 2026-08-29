"use client";

import { useContext } from "react";
import { AuthContext, type AuthContextValue } from "../store/AuthProvider";
import type { Permission } from "@/lib/rbac/roles";

export function useAuth(): AuthContextValue {
  const ctx = useContext(AuthContext);
  if (!ctx) throw new Error("useAuth must be used inside <AuthProvider>.");
  return ctx;
}

/** Convenience for the common `can(...)` call in a component body. */
export function useHasPermission(permission: Permission): boolean {
  return useAuth().can(permission);
}
