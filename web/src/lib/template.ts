import { EventType, type AgentEvent } from "@shared/events";

// The template the agent has produced so far, distilled from the event stream.
export type DetectedTemplate = {
  id: string;
  editableUrl: string;
};

// Scan the harness event stream for the most recently produced Templated
// template. The proposal tools return the new template on their tool.completed
// result — under `templateId`, a nested `template.id`, or an `editableUrl` we
// can parse. We take the LAST match so the editor always shows the freshest
// template (e.g. after story pages are populated onto an existing one).
export function findLatestTemplate(
  events: AgentEvent[],
): DetectedTemplate | null {
  let found: DetectedTemplate | null = null;
  for (const ev of events) {
    if (ev.type !== EventType.ToolCompleted) continue;
    const detected = extractTemplate(ev.result);
    if (detected) found = detected;
  }
  return found;
}

function extractTemplate(result: unknown): DetectedTemplate | null {
  if (!result || typeof result !== "object") return null;
  const record = result as Record<string, unknown>;

  const editableUrl =
    typeof record.editableUrl === "string" ? record.editableUrl : undefined;

  const nested = record.template;
  const nestedId =
    nested && typeof nested === "object"
      ? (nested as Record<string, unknown>).id
      : undefined;

  const id =
    (typeof record.templateId === "string" && record.templateId) ||
    (typeof nestedId === "string" && nestedId) ||
    (editableUrl ? idFromUrl(editableUrl) : "") ||
    "";

  if (!id) return null;
  return {
    id,
    editableUrl: editableUrl || `https://app.templated.io/template/${id}`,
  };
}

function idFromUrl(url: string): string {
  const match = url.match(/\/template\/([^/?#]+)/);
  return match ? match[1] : "";
}

// A human-facing summary of a provisioned proposal, distilled from the structured
// tool-completion events. It's built incrementally: createAndPopulateTemplateForUser
// fills the header + counts, and a later populateClientStoryPages step (if any) fills
// in `story`. Both completions carry the same template id, so they MERGE into one card.
export type ProposalSummary = {
  templateId: string;
  editableUrl: string;
  templateName?: string;
  client?: string;
  folderName?: string;
  serviceFocus?: string[];
  clientCount?: number;
  logoCount?: number;
  story?: {
    storiesCreated: number;
    pagesCreated: number;
    descriptionPages: string[];
    masonryPages: string[];
    fullPages: string[];
  };
};

// The tools whose completions we turn into a proposal card.
export const PROPOSAL_TOOL_NAMES = [
  "createAndPopulateTemplateForUser",
  "populateClientStoryPages",
];

function str(value: unknown): string | undefined {
  return typeof value === "string" && value.trim() ? value : undefined;
}

function strArray(value: unknown): string[] {
  return Array.isArray(value)
    ? value.filter((entry): entry is string => typeof entry === "string")
    : [];
}

function record(value: unknown): Record<string, unknown> | null {
  return value && typeof value === "object"
    ? (value as Record<string, unknown>)
    : null;
}

// Turn ONE proposal tool completion into a partial summary. `args` is the matching
// tool-request input (serviceFocus/clientName are inputs, not in the result). Returns
// null if the completion isn't a proposal tool or lacks a resolvable template id.
export function extractProposalSummary(
  toolName: string,
  args: unknown,
  result: unknown,
): ProposalSummary | null {
  const res = record(result);
  if (!res) return null;
  const input = record(args);

  const editableUrl = str(res.editableUrl);

  if (toolName === "createAndPopulateTemplateForUser") {
    const template = record(res.template);
    const folder = record(res.folder);
    const id =
      str(template?.id) || (editableUrl ? idFromUrl(editableUrl) : "");
    if (!id) return null;
    const selectedClients = Array.isArray(res.selectedClients)
      ? res.selectedClients
      : undefined;
    const uploadedLogos = Array.isArray(res.uploadedLogos)
      ? res.uploadedLogos
      : undefined;
    return {
      templateId: id,
      editableUrl: editableUrl || `https://app.templated.io/template/${id}`,
      templateName: str(template?.name),
      client: str(input?.clientName),
      folderName: str(res.username) || str(folder?.name),
      serviceFocus: strArray(input?.serviceFocus),
      clientCount: selectedClients?.length,
      logoCount: uploadedLogos?.length,
    };
  }

  if (toolName === "populateClientStoryPages") {
    const id = str(res.templateId) || (editableUrl ? idFromUrl(editableUrl) : "");
    if (!id) return null;
    if (
      typeof res.storiesCreated !== "number" ||
      typeof res.pagesCreated !== "number"
    ) {
      return null;
    }
    return {
      templateId: id,
      editableUrl: editableUrl || `https://app.templated.io/template/${id}`,
      story: {
        storiesCreated: res.storiesCreated,
        pagesCreated: res.pagesCreated,
        descriptionPages: strArray(res.descriptionPages),
        masonryPages: strArray(res.masonryPages),
        fullPages: strArray(res.fullPages),
      },
    };
  }

  return null;
}

// True while at least one workflow is still open. We only reveal the editor once
// the whole workflow has finished — mid-run the template isn't done being built.
export function isWorkflowRunning(events: AgentEvent[]): boolean {
  let open = 0;
  for (const ev of events) {
    if (ev.type === EventType.WorkflowStarted) open++;
    else if (
      ev.type === EventType.WorkflowCompleted ||
      ev.type === EventType.WorkflowFailed
    ) {
      open = Math.max(0, open - 1);
    }
  }
  return open > 0;
}
