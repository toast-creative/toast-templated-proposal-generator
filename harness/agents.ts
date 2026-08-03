import { readFile } from "node:fs/promises";
import path from "node:path";
import { fileURLToPath } from "node:url";
import type { ToolSet } from "ai";
import { tools } from "./tools";

// An agent is just a name, a system prompt, and the subset of tools it's allowed
// to use. The runtime runs ANY agent through the same durable loop — so adding a
// specialist is data, not new machinery.
export type Agent = {
  name: string;
  systemPrompt: string;
  tools: ToolSet;
};

interface MetadataProject {
  slug?: string;
  name?: string;
  client?: string | null;
  sectors?: string[];
  services?: string[];
}

interface MetadataPayload {
  total_projects?: number;
  category_counts?: Record<string, number>;
  categories?: Record<string, MetadataProject[]>;
  projects?: MetadataProject[];
}

const CURRENT_FILE_PATH = fileURLToPath(import.meta.url);
const REPO_ROOT = path.resolve(path.dirname(CURRENT_FILE_PATH), "..");
const METADATA_FILE_PATH = path.join(
  REPO_ROOT,
  "data",
  "toast_clients_with_metadata.json",
);

function formatProjectLabel(project: MetadataProject): string {
  const clientName = project.client?.trim();
  return (
    clientName || project.name?.trim() || project.slug?.trim() || "Unknown"
  );
}

function uniqueValues(values: string[]): string[] {
  return [...new Set(values.map((value) => value.trim()).filter(Boolean))].sort(
    (left, right) => left.localeCompare(right),
  );
}

function formatToastCatalogContext(payload: MetadataPayload): string {
  const categoryCounts = Object.entries(payload.category_counts ?? {})
    .sort((left, right) => left[0].localeCompare(right[0]))
    .map(([category, count]) => `${category} (${count})`)
    .join(", ");

  const projects = Array.isArray(payload.projects)
    ? payload.projects
    : Object.values(payload.categories ?? {}).flat();

  const clientLines = projects.map((project) => {
    const label = formatProjectLabel(project);
    const sectors = uniqueValues(project.sectors ?? []).join("; ") || "Other";
    const services =
      uniqueValues(project.services ?? []).join("; ") || "None listed";
    return `- ${label} | slug: ${project.slug ?? "unknown"} | sectors: ${sectors} | services: ${services}`;
  });

  const serviceNames = uniqueValues(
    projects.flatMap((project) => project.services ?? []),
  );

  return [
    "Use this Toast catalog context as the source of truth for Toast clients and Toast services.",
    `Total projects: ${payload.total_projects ?? projects.length}`,
    categoryCounts
      ? `Category counts: ${categoryCounts}`
      : "Category counts: unavailable",
    serviceNames.length
      ? `Toast services observed across the catalog: ${serviceNames.join(", ")}`
      : "Toast services observed across the catalog: unavailable",
    "Toast client index:",
    ...clientLines,
  ].join("\n");
}

const toastCatalogContext = formatToastCatalogContext(
  JSON.parse(await readFile(METADATA_FILE_PATH, "utf8")) as MetadataPayload,
);

// The generalist. Note what it does NOT have: issueRefund. It can talk about a
// refund, but it isn't allowed to move money — that's the whole reason it hands
// off.
export const triageAgent: Agent = {
  name: "triage",
  systemPrompt: `You are a support triage agent.

When a user asks for a new proposal for a specific customer, first run researchCustomerProfile using the customer name (and website URL when available). The tool can discover a likely official website automatically from the company name. Only ask the user for a website URL if discovery fails and no direct URL was provided. Use the tool output to infer category/sectors/services, then pass those insights into previewProposalClients and createAndPopulateTemplateForUser.

Use the Toast catalog context below as authoritative background on Toast's client base and service vocabulary.

${toastCatalogContext}

For each work item:
1. Classify it with classifyItem.
2. If it needs data lookup or math, use runCode (you have tools.getCharges and tools.searchKnowledgeBase inside it).
3. Draft a reply with draftReply, then send it with sendReply.
4. For proposal requests, run researchCustomerProfile first and summarize the inferred category/sectors/services back to the user.
5. If a user asks to provision a proposal template, first ask for the desired template name unless they already provided one.
6. For populated proposals, ALWAYS run previewProposalClients first and show the selected 32 names to the user for approval.
7. If the user requests changes, collect replacement names and pass them as approvedClientNames.
8. Only after user approval, call createAndPopulateTemplateForUser with clientName, serviceFocus, and approvedClientNames when provided.
9. Use createTemplateForUser only when the user explicitly asks for clone-only behavior.
10. Do not call template provisioning tools until you have a templateName.
11. After a template provisioning tool succeeds, always share the returned editableUrl with the user.

IMPORTANT: you are NOT allowed to issue refunds. If a customer needs an actual
refund (money moved back), hand off to the billing specialist with
handoff({ to: "billing", reason }). Do not draft or send anything yourself in
that case — let billing take over.

Handle the items, then briefly summarize what you did.`,
  tools: {
    classifyItem: tools.classifyItem,
    runCode: tools.runCode,
    draftReply: tools.draftReply,
    sendReply: tools.sendReply,
    researchCustomerProfile: tools.researchCustomerProfile,
    previewProposalClients: tools.previewProposalClients,
    createAndPopulateTemplateForUser: tools.createAndPopulateTemplateForUser,
    handoff: tools.handoff,
  },
};

// The specialist. It has the privileged issueRefund tool and a stricter policy.
// Plausibly owned by the finance team and used by other systems too — which is
// exactly when a handoff (vs. just adding a tool) is worth it.
export const billingAgent: Agent = {
  name: "billing",
  systemPrompt: `You are the billing & refunds specialist. issueRefund is
IRREVERSIBLE and moves real money, so be careful — but it IS your job.

When a refund is needed, ALWAYS do all of this — never just describe it:
1. Use runCode (tools.getCharges) to verify the duplicate charge and the exact amount.
2. Issue the refund by CALLING issueRefund(customerId, chargeId, amountCents).
3. Draft and send a confirmation with draftReply + sendReply.

Then briefly summarize what you did. Do not stop after only acknowledging — act.`,
  tools: {
    runCode: tools.runCode,
    issueRefund: tools.issueRefund,
    draftReply: tools.draftReply,
    sendReply: tools.sendReply,
  },
};

export const agents: Record<string, Agent> = {
  triage: triageAgent,
  billing: billingAgent,
};
