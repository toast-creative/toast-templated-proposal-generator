import { randomUUID } from "node:crypto";
import type { Request, Response, NextFunction } from "express";
import { MASTER_PASSWORD } from "./env";

// In-memory set of valid session tokens. Single-process, so a plain Set is
// enough — tokens are minted on login and vanish on restart (forcing re-login,
// which is fine). Swap for a shared store if this ever runs multi-process.
const sessions = new Set<string>();

export function verifyPassword(password: unknown): boolean {
  return typeof password === "string" && password === MASTER_PASSWORD;
}

export function createSession(): string {
  const token = randomUUID();
  sessions.add(token);
  return token;
}

export function isValidSession(token: string | undefined | null): boolean {
  return typeof token === "string" && sessions.has(token);
}

// Pull the bearer token out of the Authorization header.
export function tokenFromRequest(req: Request): string | undefined {
  const header = req.header("authorization");
  if (header?.startsWith("Bearer ")) return header.slice("Bearer ".length);
  return undefined;
}

// Express middleware: reject requests without a valid session token.
export function requireAuth(req: Request, res: Response, next: NextFunction) {
  if (isValidSession(tokenFromRequest(req))) return next();
  res.status(401).json({ error: "unauthorized" });
}
