import { useEffect, useState } from "react";
import { EventType, type AgentEvent, type ClientMessage } from "@shared/events";
import {
  ChatContainerContent,
  ChatContainerRoot,
} from "@/components/ui/chat-container";
import { Markdown } from "@/components/ui/markdown";
import { Tool, type ToolPart } from "@/components/ui/tool";
import {
  PromptInput,
  PromptInputAction,
  PromptInputActions,
  PromptInputTextarea,
} from "@/components/ui/prompt-input";
import { Button } from "@/components/ui/button";
import { TextDotsLoader } from "@/components/ui/loader";
import { ArrowUp, Eraser, ShieldAlert } from "lucide-react";
import { cn } from "@/lib/utils";
import { API_BASE, authHeader } from "@/useAuth";
import {
  extractProposalSummary,
  PROPOSAL_TOOL_NAMES,
  type ProposalSummary,
} from "@/lib/template";
import { ProposalSummaryCard } from "./ProposalSummaryCard";

// The left pane is a PROJECTION of the harness event stream. It never talks to
// the model — it renders whatever events have arrived so far.
type Turn =
  | { id: string; role: "user"; text: string }
  | { id: string; role: "assistant"; text: string }
  | { id: string; role: "tool"; part: ToolPart }
  | { id: string; role: "proposal"; summary: ProposalSummary }
  | {
      id: string;
      role: "approval";
      workflowId: string;
      action: string;
      args: unknown;
      state: "pending" | "approved" | "rejected";
    }
  | { id: string; role: "log"; level: string; text: string };

type AgentActivity =
  | { state: "idle" }
  | { state: "thinking" }
  | { state: "running_tool"; toolName: string }
  | { state: "awaiting_approval" }
  | { state: "awaiting_input" };

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

function getActivity(
  events: AgentEvent[],
  workflowId: string | null,
): AgentActivity {
  if (!workflowId) {
    return { state: "idle" };
  }

  const workflowEvents = events.filter(
    (event) => "workflowId" in event && event.workflowId === workflowId,
  );

  if (workflowEvents.length === 0) {
    return { state: "idle" };
  }

  const pendingTools = new Map<string, string>();
  const pendingApprovals = new Set<string>();
  let awaitingInput = false;
  let sawModelDelta = false;

  for (const event of workflowEvents) {
    switch (event.type) {
      case EventType.ToolRequested:
        pendingTools.set(event.toolCallId, event.name);
        awaitingInput = false;
        break;
      case EventType.ToolCompleted:
      case EventType.ToolFailed:
        pendingTools.delete(event.toolCallId);
        awaitingInput = false;
        break;
      case EventType.ApprovalRequested:
        pendingApprovals.add(event.toolCallId);
        awaitingInput = false;
        break;
      case EventType.ApprovalResolved:
        pendingApprovals.delete(event.toolCallId);
        awaitingInput = false;
        break;
      case EventType.ModelDelta:
        sawModelDelta = true;
        awaitingInput = false;
        break;
      case EventType.ModelCompleted:
        awaitingInput = looksLikeClarification(event.text);
        sawModelDelta = false;
        break;
      case EventType.WorkflowCompleted:
      case EventType.WorkflowFailed:
      case EventType.Log:
        awaitingInput = false;
        break;
    }
  }

  if (pendingApprovals.size > 0) {
    return { state: "awaiting_approval" };
  }

  if (pendingTools.size > 0) {
    const [toolName] = [...pendingTools.values()].slice(-1);
    return { state: "running_tool", toolName };
  }

  if (awaitingInput) {
    return { state: "awaiting_input" };
  }

  if (sawModelDelta) {
    return { state: "thinking" };
  }

  // While the workflow is still open and no blocking state is present,
  // default to thinking because the next model/tool step may be imminent.
  return { state: "thinking" };
}

function toTranscript(events: AgentEvent[]): {
  turns: Turn[];
  running: boolean;
} {
  const turns: Turn[] = [];
  let assistant: Extract<Turn, { role: "assistant" }> | null = null;
  const toolsById = new Map<string, Extract<Turn, { role: "tool" }>>();
  const approvalsById = new Map<string, Extract<Turn, { role: "approval" }>>();
  // One proposal card per template id: the template step and the later story-pages
  // step both complete with the same id, so their summaries merge into one card.
  const proposalsById = new Map<
    string,
    Extract<Turn, { role: "proposal" }>
  >();
  let open = 0;

  for (const ev of events) {
    switch (ev.type) {
      case EventType.WorkflowStarted:
        open++;
        assistant = null;
        turns.push({ id: ev.id, role: "user", text: ev.input });
        break;
      case EventType.WorkflowCompleted:
      case EventType.WorkflowFailed:
        open = Math.max(0, open - 1);
        assistant = null;
        break;
      case EventType.ModelDelta:
        if (!assistant) {
          assistant = { id: ev.id, role: "assistant", text: "" };
          turns.push(assistant);
        }
        assistant.text += ev.text;
        break;
      case EventType.ModelCompleted:
        if (assistant) assistant.text = ev.text;
        else turns.push({ id: ev.id, role: "assistant", text: ev.text });
        assistant = null;
        break;
      case EventType.ToolRequested: {
        const turn: Extract<Turn, { role: "tool" }> = {
          id: ev.id,
          role: "tool",
          part: {
            type: ev.name,
            state: "input-available",
            input: ev.args as Record<string, unknown>,
            toolCallId: ev.toolCallId,
          },
        };
        toolsById.set(ev.toolCallId, turn);
        turns.push(turn);
        assistant = null;
        break;
      }
      case EventType.ToolCompleted: {
        const turn = toolsById.get(ev.toolCallId);
        if (turn) {
          turn.part = {
            ...turn.part,
            state: "output-available",
            output: ev.result as Record<string, unknown>,
          };
        }
        // Turn a proposal tool's structured result into a human-facing card,
        // merging into any existing card for the same template.
        if (turn && PROPOSAL_TOOL_NAMES.includes(turn.part.type)) {
          const summary = extractProposalSummary(
            turn.part.type,
            turn.part.input,
            ev.result,
          );
          if (summary) {
            const existing = proposalsById.get(summary.templateId);
            if (existing) {
              Object.assign(existing.summary, summary);
            } else {
              const proposalTurn: Extract<Turn, { role: "proposal" }> = {
                id: ev.id,
                role: "proposal",
                summary,
              };
              proposalsById.set(summary.templateId, proposalTurn);
              turns.push(proposalTurn);
            }
          }
        }
        break;
      }
      case EventType.ToolFailed: {
        const turn = toolsById.get(ev.toolCallId);
        if (turn)
          turn.part = {
            ...turn.part,
            state: "output-error",
            errorText: ev.error,
          };
        break;
      }
      case EventType.ApprovalRequested: {
        assistant = null;
        const turn: Extract<Turn, { role: "approval" }> = {
          id: ev.id,
          role: "approval",
          workflowId: ev.workflowId,
          action: ev.action,
          args: ev.args,
          state: "pending",
        };
        approvalsById.set(ev.toolCallId, turn);
        turns.push(turn);
        break;
      }
      case EventType.ApprovalResolved: {
        const turn = approvalsById.get(ev.toolCallId);
        if (turn) turn.state = ev.approved ? "approved" : "rejected";
        break;
      }
      case EventType.Log:
        turns.push({
          id: ev.id,
          role: "log",
          level: ev.level,
          text: ev.message,
        });
        break;
    }
  }

  return { turns, running: open > 0 };
}

export function TaskPane({
  events,
  send,
}: {
  events: AgentEvent[];
  send: (message: ClientMessage) => void;
}) {
  const [input, setInput] = useState("");
  const [activeWorkflowId, setActiveWorkflowId] = useState<string | null>(null);
  const { turns, running } = toTranscript(events);
  const activity = getActivity(events, activeWorkflowId);

  const loaderText =
    activity.state === "running_tool"
      ? `Running ${activity.toolName}`
      : activity.state === "awaiting_approval"
        ? "Awaiting approval"
        : activity.state === "awaiting_input"
          ? "Awaiting your input"
          : "Thinking";

  const inputLoading =
    activity.state === "thinking" || activity.state === "running_tool";

  useEffect(() => {
    let currentWorkflowId: string | null = null;
    for (const event of events) {
      if (event.type === EventType.WorkflowStarted) {
        currentWorkflowId = event.workflowId;
      } else if (
        event.type === EventType.WorkflowCompleted ||
        event.type === EventType.WorkflowFailed
      ) {
        if (currentWorkflowId === event.workflowId) {
          currentWorkflowId = null;
        }
      }
    }
    setActiveWorkflowId(currentWorkflowId);
  }, [events]);

  function submit() {
    const text = input.trim();
    if (!text) return;

    if (activeWorkflowId && running) {
      send({
        type: "continue_task",
        workflowId: activeWorkflowId,
        input: text,
      });
    } else {
      send({
        type: "submit_task",
        input: text,
      });
    }

    setInput("");
  }

  async function clearMemory() {
    // The route is wired up in the memory lesson; degrade gracefully before then.
    await fetch(`${API_BASE}/api/clear`, {
      method: "POST",
      headers: { ...authHeader() },
    }).catch(() => {});
    location.reload(); // simplest reset: reconnect and replay the now-empty log
  }

  return (
    <section className="flex h-full min-h-0 flex-col border-r">
      <div className="flex items-center justify-between border-b px-4 py-2.5">
        <h2 className="text-sm font-medium">Agent</h2>
        <Button
          variant="ghost"
          size="sm"
          className="text-muted-foreground h-7 gap-1.5 text-xs"
          onClick={clearMemory}
        >
          <Eraser className="size-3.5" /> Clear
        </Button>
      </div>

      <ChatContainerRoot className="min-h-0 flex-1">
        <ChatContainerContent className="space-y-5 px-4 py-5">
          {turns.length === 0 && (
            <p className="text-muted-foreground text-sm">
              Give the agent an objective to begin.
            </p>
          )}
          {turns.map((turn) => (
            <TurnView key={turn.id} turn={turn} />
          ))}
          {running && (
            <div className="px-1">
              <TextDotsLoader text={loaderText} />
            </div>
          )}
        </ChatContainerContent>
      </ChatContainerRoot>

      <div className="border-t p-3">
        <PromptInput
          value={input}
          onValueChange={setInput}
          onSubmit={submit}
          isLoading={inputLoading}
        >
          <PromptInputTextarea
            className="dark:bg-transparent"
            placeholder="Give the agent an objective…"
          />
          <PromptInputActions className="flex items-center justify-end pt-2">
            <PromptInputAction tooltip="Run">
              <Button
                size="icon"
                className="size-8 rounded-full"
                onClick={submit}
                disabled={!input.trim()}
              >
                <ArrowUp className="size-4" />
              </Button>
            </PromptInputAction>
          </PromptInputActions>
        </PromptInput>
      </div>
    </section>
  );
}

const PROSE = "prose prose-sm dark:prose-invert max-w-none";

function ApprovalCard({ turn }: { turn: Extract<Turn, { role: "approval" }> }) {
  function decide(approved: boolean) {
    fetch(`${API_BASE}/api/approve/${turn.workflowId}`, {
      method: "POST",
      headers: { "Content-Type": "application/json", ...authHeader() },
      body: JSON.stringify({ approved }),
    }).catch(() => {});
  }

  const summary = JSON.stringify(turn.args);

  return (
    <div className="rounded-lg border border-amber-500/40 bg-amber-500/5 p-3">
      <div className="mb-1.5 flex items-center gap-2 text-sm font-medium">
        <ShieldAlert className="size-4 text-amber-500" /> Approval required
        <span className="text-muted-foreground font-mono text-xs">
          {turn.action}
        </span>
      </div>
      <p className="text-muted-foreground mb-3 text-sm">{summary}</p>
      {turn.state === "pending" ? (
        <div className="flex gap-2">
          <Button size="sm" onClick={() => decide(true)}>
            Approve
          </Button>
          <Button size="sm" variant="outline" onClick={() => decide(false)}>
            Reject
          </Button>
        </div>
      ) : (
        <div
          className={cn(
            "text-sm font-medium",
            turn.state === "approved" ? "text-emerald-600" : "text-destructive",
          )}
        >
          {turn.state === "approved" ? "✓ Approved" : "✗ Rejected"}
        </div>
      )}
    </div>
  );
}

function TurnView({ turn }: { turn: Turn }) {
  switch (turn.role) {
    case "user":
      return (
        <div className="flex justify-end">
          <div className="bg-primary text-primary-foreground max-w-[85%] rounded-2xl px-4 py-2.5 text-sm whitespace-pre-wrap">
            {turn.text}
          </div>
        </div>
      );
    case "assistant":
      return <Markdown className={PROSE}>{turn.text}</Markdown>;
    case "tool":
      return <Tool toolPart={turn.part} />;
    case "proposal":
      return <ProposalSummaryCard summary={turn.summary} />;
    case "approval":
      return <ApprovalCard turn={turn} />;
    case "log":
      return (
        <p
          className={cn(
            "px-1 text-xs",
            turn.level === "error"
              ? "text-destructive"
              : turn.level === "warn"
                ? "text-amber-600"
                : "text-muted-foreground",
          )}
        >
          {turn.text}
        </p>
      );
  }
}
