"use client";

import { createContext, useCallback, useEffect, useMemo, useState } from "react";
import { authApi } from "../api/authApi";
import type { AuthUser, Credentials } from "@/types";

export interface AuthContextValue {
  user: AuthUser | null;
  isLoading: boolean;
  isAuthenticated: boolean;
  login: (credentials: Credentials) => Promise<AuthUser>;
  logout: () => Promise<void>;
}

export const AuthContext = createContext<AuthContextValue | null>(null);

export function AuthProvider({
  children,
  initialUser = null,
}: {
  children: React.ReactNode;
  /** Resolved on the server so the first paint already knows who is signed in. */
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
      isLoading,
      isAuthenticated: !!user,
      login,
      logout,
    }),
    [user, isLoading, login, logout]
  );

  return <AuthContext.Provider value={value}>{children}</AuthContext.Provider>;
}
