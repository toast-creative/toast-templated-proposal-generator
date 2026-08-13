import { useState, useCallback } from "react";

// Server-side master-password gate. The password is verified by the server,
// which returns a session token we store and send on every request / on the
// WebSocket handshake. The password itself never lives in the client bundle.
const STORAGE_KEY = "toast_proposal_token";

export const API_BASE = `http://${location.hostname}:8787`;

export function getToken(): string | null {
  return sessionStorage.getItem(STORAGE_KEY);
}

// Authorization header for calls to the protected API routes.
export function authHeader(): Record<string, string> {
  const token = getToken();
  return token ? { Authorization: `Bearer ${token}` } : {};
}

export function useAuth() {
  const [token, setToken] = useState<string | null>(() => getToken());

  const login = useCallback(async (password: string): Promise<boolean> => {
    const res = await fetch(`${API_BASE}/api/login`, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ password }),
    });
    if (!res.ok) return false;
    const { token } = (await res.json()) as { token: string };
    sessionStorage.setItem(STORAGE_KEY, token);
    setToken(token);
    return true;
  }, []);

  const logout = useCallback(() => {
    sessionStorage.removeItem(STORAGE_KEY);
    setToken(null);
  }, []);

  return { authed: token !== null, login, logout };
}
