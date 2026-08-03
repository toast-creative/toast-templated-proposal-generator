import { DBOS } from "@dbos-inc/dbos-sdk";
import { streamText } from "ai";
import type { ModelMessage, JSONValue, ToolSet } from "ai";
import { EventType } from "@shared/events";
import { emit } from "./bus";
import { model } from "./model";
import { runTool } from "./tools";
import { triageAgent, agents } from "./agents";
import {
  buildContext,
  summarize,
  estimateTokens,
  MAX_CONTEXT_TOKENS,
  KEEP_CONTEXT_TOKENS,
} from "./memory";

const MAX_STEPS = 30;

// Tools that require a human's go-ahead before they run.
const NEEDS_APPROVAL = new Set([
  "issueRefund",
  "createTemplateForUser",
  "createAndPopulateTemplateForUser",
]);
const APPROVAL_TIMEOUT_S = 86_400; // up to a day — a human approval is an unbounded wait

type ToolCall = {
  toolCallId: string;
  toolName: string;
  input: Record<string, unknown>;
};
type Turn = {
  text: string;
  toolCalls: ToolCall[];
  responseMessages: ModelMessage[];
};

type StoryPopulateSummary = {
  storiesCreated: number;
  pagesCreated: number;
  descriptionPages: string[];
  masonryPages: string[];
  fullPages: string[];
};

function errorMessage(error: unknown): string {
  if (error instanceof Error) {
    return error.message;
  }

  return String(error);
}

function isNoOutputGeneratedError(error: unknown): boolean {
  const message = errorMessage(error).toLowerCase();
  return message.includes("no output generated");
}

function summarizeWithoutModel(
  oldTurns: ModelMessage[][],
  priorSummary: string,
): string {
  const transcript = oldTurns
    .flat()
    .map((message) => {
      const content =
        typeof message.content === "string"
          ? message.content
          : JSON.stringify(message.content);
      return `${message.role}: ${content}`;
    })
    .join("\n")
    .slice(0, 2200);

  const merged = [
    priorSummary.trim(),
    transcript ? `Earlier compacted work:\n${transcript}` : "",
  ]
    .filter(Boolean)
    .join("\n\n");

  return merged.slice(0, 4000);
}

function looksLikeClarification(text: string): boolean {
  const normalized = text.trim();
  if (!normalized) return false;
  return (
    /[?]/.test(normalized) ||
    /\b(please|could you|can you|what would|which|who|when|where|would you|do you)\b/i.test(
      normalized,
    )
  );
}

function extractTemplateIdFromToolOutput(
  output: Record<string, unknown>,
): string | null {
  const directTemplateId = output.templateId;
  if (typeof directTemplateId === "string" && directTemplateId.trim()) {
    return directTemplateId.trim();
  }

  const nestedTemplate = output.template;
  if (nestedTemplate && typeof nestedTemplate === "object") {
    const candidate = (nestedTemplate as { id?: unknown }).id;
    if (typeof candidate === "string" && candidate.trim()) {
      return candidate.trim();
    }
  }

  return null;
}

function toStringArray(value: unknown): string[] {
  if (!Array.isArray(value)) {
    return [];
  }

  return value.filter((entry): entry is string => typeof entry === "string");
}

function extractStoryPopulateSummary(
  output: Record<string, unknown>,
): StoryPopulateSummary | null {
  const storiesCreated = output.storiesCreated;
  const pagesCreated = output.pagesCreated;

  if (typeof storiesCreated !== "number" || typeof pagesCreated !== "number") {
    return null;
  }

  return {
    storiesCreated,
    pagesCreated,
    descriptionPages: toStringArray(output.descriptionPages),
    masonryPages: toStringArray(output.masonryPages),
    fullPages: toStringArray(output.fullPages),
  };
}

function appendStorySummaryToFinalOutput(
  baseText: string,
  storySummary: StoryPopulateSummary | null,
): string {
  if (!storySummary) {
    return baseText;
  }

  const descriptionList =
    storySummary.descriptionPages.length > 0
      ? storySummary.descriptionPages.join(", ")
      : "None";
  const masonryList =
    storySummary.masonryPages.length > 0
      ? storySummary.masonryPages.join(", ")
      : "None";
  const fullList =
    storySummary.fullPages.length > 0
      ? storySummary.fullPages.join(", ")
      : "None";

  const storySection = [
    "",
    "Story pages updated as a separate step:",
    `- Stories created: ${storySummary.storiesCreated}`,
    `- Pages created: ${storySummary.pagesCreated}`,
    `- Description pages: ${descriptionList}`,
    `- Masonry pages: ${masonryList}`,
    `- Full pages: ${fullList}`,
  ].join("\n");

  return `${baseText.trimEnd()}\n${storySection}`;
}

// One model turn over the hydrated context, using the CURRENT agent's tools.
async function modelTurn(
  workflowId: string,
  systemPrompt: string,
  context: ModelMessage[],
  agentTools: ToolSet,
): Promise<Turn> {
  const result = streamText({
    model,
    system: systemPrompt,
    messages: context,
    tools: agentTools,
  });

  for await (const part of result.fullStream) {
    if (part.type === "text-delta") {
      await emit({ type: EventType.ModelDelta, workflowId, text: part.text });
    }
  }

  const rawCalls = await result.toolCalls;
  let text = "";
  try {
    text = await result.text;
  } catch (error) {
    // Tool-only turns are valid; some SDK paths throw when no text tokens exist.
    if (!isNoOutputGeneratedError(error)) {
      throw error;
    }
  }

  return {
    text,
    toolCalls: rawCalls.map((c) => ({
      toolCallId: c.toolCallId,
      toolName: c.toolName,
      input: c.input as Record<string, unknown>,
    })),
    responseMessages: (await result.response).messages,
  };
}

// Execute one tool. Run as a DBOS step so its side effect runs exactly once.
async function toolStep(
  workflowId: string,
  call: ToolCall,
): Promise<Record<string, unknown>> {
  await emit({
    type: EventType.ToolRequested,
    workflowId,
    toolCallId: call.toolCallId,
    name: call.toolName,
    args: call.input,
  });
  const output = await runTool(call.toolName, call.input, async (message) => {
    await emit({
      type: EventType.Log,
      workflowId,
      level: "info",
      message,
    });
  });
  await emit({
    type: EventType.ToolCompleted,
    workflowId,
    toolCallId: call.toolCallId,
    result: output,
  });
  return output;
}

function toolResultMessage(call: ToolCall, value: JSONValue): ModelMessage {
  return {
    role: "tool",
    content: [
      {
        type: "tool-result",
        toolCallId: call.toolCallId,
        toolName: call.toolName,
        output: { type: "json", value },
      },
    ],
  };
}

// THE DURABLE AGENT LOOP — now a general RUNTIME that runs any agent.
//
// The loop is identical to before, with two additions:
//   · it runs the CURRENT agent's prompt + tools (start: triage)
//   · the `handoff` tool isn't executed — the harness intercepts it and SWITCHES
//     the running agent, keeping the conversation. Control transfers laterally.
//
// `currentAgent` is rebuilt deterministically on recovery (the handoff is a
// consequence of a cached model decision), so this composes with durability.
async function agentWorkflow(input: string): Promise<string> {
  const workflowId = DBOS.workflowID ?? "unknown";
  await DBOS.runStep(
    () => emit({ type: EventType.WorkflowStarted, workflowId, input }),
    { name: "started" },
  );

  let currentAgent = triageAgent;
  let storyPopulateInvoked = false;
  let storyPopulateSummary: StoryPopulateSummary | null = null;
  const turns: ModelMessage[][] = [];
  let summary = "";

  try {
    let step = 0;
    while (step < MAX_STEPS) {
      // 1. Compact old turns once the window is over budget.
      if (estimateTokens(turns.flat()) > MAX_CONTEXT_TOKENS) {
        const old: ModelMessage[][] = [];
        while (
          turns.length > 1 &&
          estimateTokens(turns.flat()) > KEEP_CONTEXT_TOKENS
        ) {
          const oldest = turns.shift();
          if (oldest) old.push(oldest);
        }
        if (old.length > 0) {
          try {
            summary = await DBOS.runStep(() => summarize(old, summary), {
              name: `summarize-${step}`,
            });
          } catch (error) {
            const reason = errorMessage(error);
            summary = summarizeWithoutModel(old, summary);
            await DBOS.runStep(
              () =>
                emit({
                  type: EventType.Log,
                  workflowId,
                  level: "warn",
                  message: `Memory summarization failed; continued with fallback compaction. Reason: ${reason}`,
                }),
              { name: `summarize-fallback-${step}` },
            );
          }

          const contextTokens = estimateTokens(
            buildContext(currentAgent.systemPrompt, input, summary, turns),
          );
          await DBOS.runStep(
            () =>
              emit({
                type: EventType.MemoryCompacted,
                workflowId,
                summarizedTurns: old.length,
                contextTokens,
                summary,
              }),
            { name: `compacted-${step}` },
          );
        }
      }

      // 2 + 3. Hydrate the CURRENT agent's context and run one turn over it.
      const context = buildContext(
        currentAgent.systemPrompt,
        input,
        summary,
        turns,
      );
      const turn = await DBOS.runStep(
        () =>
          modelTurn(
            workflowId,
            currentAgent.systemPrompt,
            context,
            currentAgent.tools,
          ),
        {
          name: `model-${step}`,
        },
      );

      const turnMessages: ModelMessage[] = [...turn.responseMessages];

      if (turn.toolCalls.length === 0) {
        const finalOutput = appendStorySummaryToFinalOutput(
          turn.text,
          storyPopulateSummary,
        );

        await DBOS.runStep(
          () =>
            emit({
              type: EventType.ModelCompleted,
              workflowId,
              text: finalOutput,
            }),
          { name: `model-done-${step}` },
        );

        if (looksLikeClarification(turn.text)) {
          turns.push(turnMessages);
          const followup = await DBOS.recv<{ input: string }>(
            "user_input",
            APPROVAL_TIMEOUT_S,
          );
          if (followup) {
            turns.push([{ role: "user", content: followup.input }]);
            step++;
            continue;
          }
        }

        await DBOS.runStep(
          () =>
            emit({
              type: EventType.WorkflowCompleted,
              workflowId,
              output: finalOutput,
            }),
          { name: "completed" },
        );
        return finalOutput;
      }

      for (const call of turn.toolCalls) {
        if (
          call.toolName === "populateClientStoryPages" &&
          storyPopulateInvoked
        ) {
          turnMessages.push(
            toolResultMessage(call, {
              skipped: true,
              reason:
                "Story page population already executed for this workflow. Skipping duplicate call.",
            }),
          );
          continue;
        }

        if (call.toolName === "handoff") {
          // The harness intercepts handoff: switch the running agent, don't run a tool.
          const to = String(call.input.to ?? "");
          const reason = String(call.input.reason ?? "");
          const from = currentAgent.name;
          await DBOS.runStep(
            () =>
              emit({
                type: EventType.AgentHandoff,
                workflowId,
                from,
                to,
                reason,
              }),
            { name: `handoff-${call.toolCallId}` },
          );
          currentAgent = agents[to] ?? currentAgent;
          turnMessages.push(
            toolResultMessage(call, {
              ok: true,
              message: `You are now the ${to} specialist. Take over and FINISH the task by calling the tools you need — do the work, don't just acknowledge the handoff.`,
            }),
          );
        } else if (NEEDS_APPROVAL.has(call.toolName)) {
          // HUMAN-IN-THE-LOOP. Ask, then SUSPEND the (durable) workflow until a
          // human decides. recv() can wait minutes or days — and because the
          // workflow is durable, the process can crash and resume right here.
          await DBOS.runStep(
            () =>
              emit({
                type: EventType.ApprovalRequested,
                workflowId,
                toolCallId: call.toolCallId,
                action: call.toolName,
                args: call.input,
              }),
            { name: `approval-req-${call.toolCallId}` },
          );

          const decision = await DBOS.recv<{ approved: boolean }>(
            "approval",
            APPROVAL_TIMEOUT_S,
          );
          const approved = decision?.approved ?? false;

          await DBOS.runStep(
            () =>
              emit({
                type: EventType.ApprovalResolved,
                workflowId,
                toolCallId: call.toolCallId,
                approved,
              }),
            { name: `approval-res-${call.toolCallId}` },
          );

          if (approved) {
            const output = await DBOS.runStep(
              () => toolStep(workflowId, call),
              {
                name: `tool-${call.toolCallId}`,
              },
            );
            turnMessages.push(toolResultMessage(call, output as JSONValue));

            if (call.toolName === "populateClientStoryPages") {
              storyPopulateInvoked = true;
              storyPopulateSummary = extractStoryPopulateSummary(output);
            }

            const shouldAutoRunStoryStep =
              !storyPopulateInvoked &&
              (call.toolName === "createAndPopulateTemplateForUser" ||
                call.toolName === "createTemplateForUser");

            if (shouldAutoRunStoryStep) {
              const templateId = extractTemplateIdFromToolOutput(output);
              if (templateId) {
                const autoStoryCall: ToolCall = {
                  toolCallId: `${call.toolCallId}-story-populate`,
                  toolName: "populateClientStoryPages",
                  input: {
                    templateId,
                    maxCompanies: 6,
                    ...(typeof call.input.clientName === "string" &&
                    call.input.clientName.trim()
                      ? { clientName: call.input.clientName.trim() }
                      : {}),
                    ...(Array.isArray(call.input.serviceFocus)
                      ? { serviceFocus: call.input.serviceFocus }
                      : {}),
                    ...(Array.isArray(call.input.approvedClientNames)
                      ? { approvedClientNames: call.input.approvedClientNames }
                      : {}),
                  },
                };

                await DBOS.runStep(
                  () =>
                    emit({
                      type: EventType.Log,
                      workflowId,
                      level: "info",
                      message:
                        "Running story page population as a separate post-template step...",
                    }),
                  { name: `story-step-log-${call.toolCallId}` },
                );

                const storyOutput = await DBOS.runStep(
                  () => toolStep(workflowId, autoStoryCall),
                  {
                    name: `tool-${autoStoryCall.toolCallId}`,
                  },
                );

                storyPopulateInvoked = true;
                storyPopulateSummary = extractStoryPopulateSummary(storyOutput);
                const autoSummary = storyPopulateSummary
                  ? `Auto-ran populateClientStoryPages: created ${storyPopulateSummary.storiesCreated} stories and ${storyPopulateSummary.pagesCreated} pages.`
                  : "Auto-ran populateClientStoryPages as a separate post-template step.";
                turnMessages.push({
                  role: "assistant",
                  content: autoSummary,
                });
              } else {
                await DBOS.runStep(
                  () =>
                    emit({
                      type: EventType.Log,
                      workflowId,
                      level: "warn",
                      message:
                        "Could not auto-run story page population because template ID was missing from template tool output.",
                    }),
                  { name: `story-step-warn-${call.toolCallId}` },
                );
              }
            }
          } else {
            turnMessages.push(
              toolResultMessage(call, {
                approved: false,
                message:
                  "A human did NOT approve this action. Do not retry — tell the customer it needs manual review.",
              }),
            );
          }
        } else {
          const output = await DBOS.runStep(() => toolStep(workflowId, call), {
            name: `tool-${call.toolCallId}`,
          });
          turnMessages.push(toolResultMessage(call, output as JSONValue));

          if (call.toolName === "populateClientStoryPages") {
            storyPopulateInvoked = true;
            storyPopulateSummary = extractStoryPopulateSummary(output);
          }
        }
      }

      turns.push(turnMessages);
      step++;
    }

    await DBOS.runStep(
      () =>
        emit({
          type: EventType.WorkflowFailed,
          workflowId,
          error: `Hit the ${MAX_STEPS}-step limit without finishing.`,
        }),
      { name: "failed" },
    );
    return "";
  } catch (error) {
    const message = errorMessage(error);
    await DBOS.runStep(
      () =>
        emit({
          type: EventType.WorkflowFailed,
          workflowId,
          error: `Workflow crashed: ${message}`,
        }),
      { name: "failed-unhandled" },
    );
    return `Workflow failed: ${message}`;
  }
}

export const runAgentWorkflow = DBOS.registerWorkflow(agentWorkflow, {
  name: "agentWorkflow",
});
