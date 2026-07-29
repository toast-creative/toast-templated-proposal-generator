import { config } from "dotenv";

// Load .dev.vars into process.env. This module is imported FIRST in the server
// (before anything that reads env at load time, like harness/db.ts) because ES
// module imports are evaluated before top-level statements.
config({ path: ".dev.vars" });

export const TEMPLATED_API_BASE_URL = process.env.TEMPLATED_API_BASE_URL ?? "";
export const TEMPLATED_API_KEY = process.env.TEMPLATED_API_KEY ?? "";
export const TEMPLATED_COOKIE =
  process.env.TEMPLATED_COOKIE ?? process.env.TEMPLATED_API_COOKIE ?? "";
export const TEMPLATED_MAIN_TEMPLATE_ID =
  process.env.TEMPLATED_MAIN_TEMPLATE_ID ?? "";
