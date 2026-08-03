import { anthropic } from "@ai-sdk/anthropic";
import { openai } from "@ai-sdk/openai";

const hasOpenAiKey = Boolean(process.env.OPENAI_API_KEY?.trim());
const hasAnthropicKey = Boolean(process.env.ANTHROPIC_API_KEY?.trim());

if (!hasOpenAiKey && !hasAnthropicKey) {
  throw new Error(
    "Missing model provider credentials. Set OPENAI_API_KEY (preferred) or ANTHROPIC_API_KEY in .dev.vars.",
  );
}

// Prefer OpenAI by default (matches project docs), fall back to Anthropic.
export const model = hasOpenAiKey
  ? openai(process.env.OPENAI_MODEL?.trim() || "gpt-5.5")
  : anthropic(process.env.ANTHROPIC_MODEL?.trim() || "claude-sonnet-4-5");
