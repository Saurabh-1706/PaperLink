import { endpoints } from "@/lib/api/endpoints";
import { http } from "@/lib/api/httpClient";
import type { AuthUser, Credentials } from "@/types";

interface SessionResponse {
  user: AuthUser;
}

export const authApi = {
  login: (credentials: Credentials) =>
    http.post<SessionResponse>(endpoints.auth.login, credentials).then((r) => r.user),

  logout: () => http.post<{ ok: true }>(endpoints.auth.logout),

  /** Resolves to null when there is no session, rather than throwing. */
  session: async (signal?: AbortSignal): Promise<AuthUser | null> => {
    try {
      const { user } = await http.get<SessionResponse>(endpoints.auth.session, { signal });
      return user;
    } catch {
      return null;
    }
  },
};
