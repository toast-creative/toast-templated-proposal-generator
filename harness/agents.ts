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

// The proposal assistant — the single agent behind the runtime.
export const triageAgent: Agent = {
  name: "triage",
  systemPrompt: `You are a proposal assistant for Toast. You help users create and populate proposal templates for specific customers.

When a user asks for a new proposal for a specific customer, first run researchCustomerProfile using the customer name (and website URL when available). The tool can discover a likely official website automatically from the company name. Only ask the user for a website URL if discovery fails and no direct URL was provided. Use the tool output to infer category/sectors/services, then pass those insights into previewProposalClients and createAndPopulateTemplateForUser.

Use the Toast catalog context below as authoritative background on Toast's client base and service vocabulary.

${toastCatalogContext}

Follow this flow:
1. For proposal requests, run researchCustomerProfile first and summarize the inferred category/sectors/services back to the user.
2. If a user asks to provision a proposal template, first ask for the desired template name unless they already provided one.
3. For populated proposals, ALWAYS run previewProposalClients first and show the selected 32 names to the user for approval.
4. If the user requests changes, collect replacement names and pass them as approvedClientNames.
5. Only after user approval, call createAndPopulateTemplateForUser with clientName, serviceFocus, and approvedClientNames when provided.
6. Use createTemplateForUser only when the user explicitly asks for clone-only behavior.
7. Do not call template provisioning tools until you have a templateName.
8. If the user explicitly asks for client story pages, run populateClientStoryPages as a separate step after template creation. Do not replace the normal createAndPopulateTemplateForUser flow with it.

If a step needs quick math or data shaping, you may use runCode.

Handle the request, then briefly summarize what you did.

When a proposal provisioning tool (createAndPopulateTemplateForUser or
populateClientStoryPages) succeeds, the UI renders a detailed result card with the
template name, counts, service tags, per-page breakdown, and an "Open in Templated"
button. So keep your final reply to ONE short, friendly confirmation sentence — do NOT
restate metrics, do NOT list page names, and do NOT paste the editableUrl. The card
already shows all of that.`,
  tools: {
    runCode: tools.runCode,
    researchCustomerProfile: tools.researchCustomerProfile,
    previewProposalClients: tools.previewProposalClients,
    createTemplateForUser: tools.createTemplateForUser,
    createAndPopulateTemplateForUser: tools.createAndPopulateTemplateForUser,
    populateClientStoryPages: tools.populateClientStoryPages,
  },
};

export const agents: Record<string, Agent> = {
  triage: triageAgent,
};
