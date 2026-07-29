import { anthropic } from "@ai-sdk/anthropic";

// The one place the model is configured.
//   - cheaper for a workshop → a "-haiku" variant (e.g. "claude-haiku-4-5")
//   - this default            → "claude-sonnet-4-5"
//
// The provider reads ANTHROPIC_API_KEY from the environment at request time
// (the server loads it from .dev.vars on startup).
export const model = anthropic("claude-sonnet-4-5");
