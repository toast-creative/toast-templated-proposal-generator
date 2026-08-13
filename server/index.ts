// MUST be first: loads .dev.vars before any module that reads env at load time.
import "./env";

import { DBOS } from "@dbos-inc/dbos-sdk";
import express from "express";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { createServer } from "node:http";
import { WebSocketServer, type WebSocket } from "ws";
import { ensureSchema, clearEventLog } from "../harness/db";
import { subscribe, history } from "../harness/bus";
import { runAgentWorkflow } from "../harness/runtime";
import type { ClientMessage } from "@shared/events";
import {
  createSession,
  isValidSession,
  requireAuth,
  verifyPassword,
} from "./auth";

const PORT = Number(process.env.PORT ?? 8787);

async function main() {
  await ensureSchema();

  // Point DBOS at the same Postgres for its checkpoint store, then launch it.
  // launch() ALSO recovers any workflows that were mid-flight when the process
  // last died, resuming each from its last completed step.
  DBOS.setConfig({
    name: "harness",
    systemDatabaseUrl: process.env.DATABASE_URL,
  });
  await DBOS.launch();

  const app = express();
  app.use(express.json());
  app.use((req, res, next) => {
    res.setHeader("Access-Control-Allow-Origin", "*"); // inspector runs on a different port
    res.setHeader("Access-Control-Allow-Headers", "Content-Type, Authorization");
    res.setHeader("Access-Control-Allow-Methods", "GET,POST,OPTIONS");
    if (req.method === "OPTIONS") return res.sendStatus(204);
    next();
  });
  app.get("/health", (_req, res) => res.json({ ok: true }));

  // Master-password login: verify the password and mint a session token.
  // Everything below /api (and the WebSocket) requires that token.
  app.post("/api/login", (req, res) => {
    if (!verifyPassword(req.body?.password)) {
      return res.status(401).json({ error: "invalid password" });
    }
    res.json({ token: createSession() });
  });

  // Clear the durable log. The inspector calls this, then reloads.
  app.post("/api/clear", requireAuth, async (_req, res) => {
    await clearEventLog();
    res.json({ ok: true });
  });

  // Human-in-the-loop: deliver an approval decision to a suspended workflow.
  // DBOS.send wakes its recv() — even days later, even after a restart.
  app.post("/api/approve/:workflowId", requireAuth, async (req, res) => {
    const approved = Boolean(req.body?.approved);
    await DBOS.send(String(req.params.workflowId), { approved }, "approval");
    res.json({ ok: true });
  });

  // In production the backend also serves the built inspector (vite build →
  // web/dist), so the UI, API, and WebSocket all share one origin. This is what
  // lets the frontend use relative/same-origin URLs and upgrade to wss:// behind
  // TLS. Registered AFTER the /api routes so it only catches unmatched paths.
  const webDist = path.resolve(fileURLToPath(import.meta.url), "../../web/dist");
  app.use(express.static(webDist));
  app.get(/.*/, (_req, res) => res.sendFile(path.join(webDist, "index.html")));

  const server = createServer(app);
  const wss = new WebSocketServer({ server, path: "/ws" });

  // Forward every emitted event to all connected inspectors.
  subscribe((event) => {
    const data = JSON.stringify(event);
    for (const client of wss.clients) {
      if (client.readyState === client.OPEN) client.send(data);
    }
  });

  wss.on("connection", async (socket: WebSocket, request) => {
    // Gate the socket on the same session token. The browser can't set headers
    // on a WebSocket, so it arrives as a ?token= query param.
    const token = new URL(
      request.url ?? "",
      "http://localhost",
    ).searchParams.get("token");
    if (!isValidSession(token)) {
      socket.close(4401, "unauthorized");
      return;
    }

    // Register the message handler FIRST — history() is an async DB read, and the
    // client sends as soon as it connects.
    socket.on("message", async (raw) => {
      let message: ClientMessage;
      try {
        message = JSON.parse(raw.toString());
      } catch {
        return;
      }

      if (message.type === "submit_task") {
        await DBOS.startWorkflow(runAgentWorkflow)(message.input);
      } else if (message.type === "continue_task") {
        await DBOS.send(
          message.workflowId,
          { input: message.input },
          "user_input",
        );
      }
    });

    // Replay the durable timeline (including a workflow DBOS is recovering).
    for (const event of await history()) socket.send(JSON.stringify(event));
  });

  server.listen(PORT, () => {
    console.log(
      `harness server listening on http://localhost:${PORT}  (ws: /ws)`,
    );
  });
}

main().catch((error) => {
  console.error("failed to start:", error);
  process.exit(1);
});
