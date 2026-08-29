"use client";

import { createContext, useCallback, useEffect, useMemo, useState } from "react";
import { authApi } from "../api/authApi";
import { hasPermission } from "@/lib/rbac/permissions";
import type { Permission, Role } from "@/lib/rbac/roles";
import type { AuthUser, Credentials } from "@/types";

export interface AuthContextValue {
  user: AuthUser | null;
  role: Role | null;
  isLoading: boolean;
  isAuthenticated: boolean;
  login: (credentials: Credentials) => Promise<AuthUser>;
  logout: () => Promise<void>;
  can: (permission: Permission) => boolean;
}

export const AuthContext = createContext<AuthContextValue | null>(null);

export function AuthProvider({
  children,
  initialUser = null,
}: {
  children: React.ReactNode;
  /** Resolved on the server so the first paint already knows the role. */
  initialUser?: AuthUser | null;
}) {
  const [user, setUser] = useState<AuthUser | null>(initialUser);
  const [isLoading, setIsLoading] = useState(initialUser === null);

  useEffect(() => {
    if (initialUser) return;
    const controller = new AbortController();
    authApi.session(controller.signal).then((resolved) => {
      if (controller.signal.aborted) return;
      setUser(resolved);
      setIsLoading(false);
    });
    return () => controller.abort();
  }, [initialUser]);

  const login = useCallback(async (credentials: Credentials) => {
    const authenticated = await authApi.login(credentials);
    setUser(authenticated);
    return authenticated;
  }, []);

  const logout = useCallback(async () => {
    await authApi.logout().catch(() => undefined);
    setUser(null);
  }, []);

  const value = useMemo<AuthContextValue>(
    () => ({
      user,
      role: user?.role ?? null,
      isLoading,
      isAuthenticated: !!user,
      login,
      logout,
      can: (permission: Permission) => hasPermission(user?.role, permission),
    }),
    [user, isLoading, login, logout]
  );

  return <AuthContext.Provider value={value}>{children}</AuthContext.Provider>;
}
