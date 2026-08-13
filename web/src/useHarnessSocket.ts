import { useCallback, useEffect, useRef, useState } from "react";
import type { AgentEvent, ClientMessage } from "@shared/events";
import { getToken } from "./useAuth";

// The inspector's single source of truth: the harness event stream, received
// over one WebSocket. We also send commands (submit_task, ...) back over it.
// The session token rides along as a query param — the server rejects the
// handshake without a valid one.
// Dev: the harness runs on its own port. Production: same-origin as this bundle,
// so match the page's scheme — wss:// under HTTPS (plain ws:// would be blocked).
const WS_URL = import.meta.env.DEV
  ? `ws://${location.hostname}:8787/ws`
  : `${location.protocol === "https:" ? "wss:" : "ws:"}//${location.host}/ws`;

export function useHarnessSocket(enabled: boolean) {
  const [events, setEvents] = useState<AgentEvent[]>([]);
  const [connected, setConnected] = useState(false);
  const socketRef = useRef<WebSocket | null>(null);

  useEffect(() => {
    // Don't open the socket until we're logged in. Connecting without a token
    // gets a 4401 close, which triggers a reload — an infinite loop on the
    // login screen. Guard on both `enabled` and an actual token.
    const token = getToken();
    if (!enabled || !token) return;
    const socket = new WebSocket(`${WS_URL}?token=${encodeURIComponent(token)}`);
    socketRef.current = socket;

    socket.onopen = () => setConnected(true);
    socket.onclose = (e) => {
      setConnected(false);
      // Server rejected the token (e.g. it restarted). Drop it and re-login.
      if (e.code === 4401) {
        sessionStorage.removeItem("toast_proposal_token");
        location.reload();
      }
    };
    socket.onmessage = (e) => {
      const event = JSON.parse(e.data) as AgentEvent;
      setEvents((prev) => [...prev, event]);
    };

    return () => socket.close();
  }, [enabled]);

  const send = useCallback((message: ClientMessage) => {
    socketRef.current?.send(JSON.stringify(message));
  }, []);

  return { events, connected, send };
}
