import { drizzle } from "drizzle-orm/postgres-js";
import postgres from "postgres";
import { pgTable, bigserial, jsonb } from "drizzle-orm/pg-core";
import type { AgentEvent } from "@shared/events";

const connectionString = process.env.DATABASE_URL;
if (!connectionString) {
  throw new Error("DATABASE_URL is not set — copy .dev.vars.example to .dev.vars.");
}

// postgres.js connection. Managed Postgres (RDS/Neon) requires SSL but presents
// a CA that isn't in Node's trust store, so when the URL asks for SSL we pass an
// explicit ssl object: encrypted, but without CA verification. This also lets a
// single DATABASE_URL work for both drivers — the pg driver DBOS uses needs
// sslmode=no-verify in the URL, and postgres.js's ssl object overrides that. For
// local dev (docker-compose uses sslmode=disable) we leave SSL off entirely.
// We keep the pool small — this is the durable event log, not a high-traffic DB.
const wantsSsl = /[?&]sslmode=(?!disable)/.test(connectionString);
const client = postgres(connectionString, {
  max: 5,
  ...(wantsSsl ? { ssl: { rejectUnauthorized: false } } : {}),
});
export const db = drizzle(client);

// The DURABLE event log. In Lesson 1 the event stream lived in a memory array
// that vanished on restart. Now every event is a row here, so the inspector can
// replay the whole timeline — including work that happened before a crash.
export const eventLog = pgTable("event_log", {
  seq: bigserial("seq", { mode: "number" }).primaryKey(), // global order
  data: jsonb("data").$type<AgentEvent>().notNull(),
});

// Create the table on boot. Keeps the workshop migration-free; in a real app
// you'd use Drizzle migrations instead.
export async function ensureSchema(): Promise<void> {
  await client`
    CREATE TABLE IF NOT EXISTS event_log (
      seq  bigserial PRIMARY KEY,
      data jsonb NOT NULL
    )
  `;
}

// Wipe the durable log (the "Clear" button in the inspector). Wired up in the
// memory lesson.
export async function clearEventLog(): Promise<void> {
  await client`TRUNCATE event_log`;
}
