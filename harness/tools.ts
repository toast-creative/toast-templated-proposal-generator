import { tool } from "ai";
import { readFile } from "node:fs/promises";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { z } from "zod";
import { runInSandbox, type SandboxApi } from "./sandbox";
import {
  createAndPopulateTemplateForUser,
  createTemplateForUser,
  previewProposalClients,
  type TemplateProgressReporter,
} from "../scripts/create-template";

interface MetadataProject {
  slug?: string;
  name?: string;
  client?: string | null;
  sectors?: string[];
  services?: string[];
}

interface MetadataPayload {
  category_counts?: Record<string, number>;
  projects?: MetadataProject[];
  categories?: Record<string, MetadataProject[]>;
}

interface ToastCatalog {
  categories: string[];
  services: string[];
  sectors: string[];
  clientLabels: string[];
}

const NON_OFFICIAL_HOST_HINTS = [
  "wikipedia.org",
  "linkedin.com",
  "facebook.com",
  "instagram.com",
  "x.com",
  "twitter.com",
  "youtube.com",
  "tiktok.com",
  "reddit.com",
  "crunchbase.com",
  "bloomberg.com",
  "reuters.com",
  "glassdoor.com",
];

const CURRENT_FILE_PATH = fileURLToPath(import.meta.url);
const REPO_ROOT = path.resolve(path.dirname(CURRENT_FILE_PATH), "..");
const METADATA_FILE_PATH = path.join(
  REPO_ROOT,
  "data",
  "toast_clients_with_metadata.json",
);

function uniqueNormalized(values: string[]): string[] {
  return [...new Set(values.map((value) => value.trim()).filter(Boolean))].sort(
    (left, right) => left.localeCompare(right),
  );
}

function stripHtml(html: string): string {
  const withoutScripts = html
    .replace(/<script[^>]*>[\s\S]*?<\/script>/gi, " ")
    .replace(/<style[^>]*>[\s\S]*?<\/style>/gi, " ")
    .replace(/<noscript[^>]*>[\s\S]*?<\/noscript>/gi, " ");

  const withoutTags = withoutScripts.replace(/<[^>]+>/g, " ");

  return withoutTags
    .replace(/&nbsp;/gi, " ")
    .replace(/&amp;/gi, "&")
    .replace(/&quot;/gi, '"')
    .replace(/&#39;/gi, "'")
    .replace(/\s+/g, " ")
    .trim();
}

function findMatches(text: string, candidates: string[], max = 12): string[] {
  const lower = text.toLowerCase();
  const matches = candidates.filter((candidate) => {
    const normalized = candidate.toLowerCase();
    return normalized.length >= 3 && lower.includes(normalized);
  });

  return matches.slice(0, max);
}

function extractTitle(html: string): string | null {
  const match = html.match(/<title[^>]*>([\s\S]*?)<\/title>/i);
  if (!match) {
    return null;
  }

  return stripHtml(match[1]);
}

function normalizeCompanyTokens(companyName: string): string[] {
  return companyName
    .toLowerCase()
    .replace(/[^a-z0-9\s]/g, " ")
    .split(/\s+/)
    .map((token) => token.trim())
    .filter((token) => token.length >= 3);
}

function domainBodyFromHost(host: string): string {
  const cleanedHost = host.toLowerCase().replace(/^www\./, "");
  const parts = cleanedHost.split(".");
  if (parts.length <= 2) {
    return parts[0] ?? cleanedHost;
  }

  return parts.slice(0, -1).join(".");
}

function scoreOfficialWebsiteCandidate(url: URL, companyName: string): number {
  const host = url.hostname.toLowerCase();
  const body = domainBodyFromHost(host).replace(/[^a-z0-9]/g, "");
  const tokens = normalizeCompanyTokens(companyName);
  const collapsedName = tokens.join("");

  let score = 0;

  if (collapsedName && body.includes(collapsedName)) {
    score += 140;
  }

  for (const token of tokens) {
    if (body.includes(token)) {
      score += 30;
    }
  }

  if (url.pathname === "/" || url.pathname === "") {
    score += 10;
  }

  if (NON_OFFICIAL_HOST_HINTS.some((hint) => host.includes(hint))) {
    score -= 250;
  }

  return score;
}

function safeParseUrl(value: string): URL | null {
  try {
    return new URL(value);
  } catch {
    return null;
  }
}

function decodeDuckDuckGoHref(href: string): string | null {
  const direct = safeParseUrl(href);
  if (direct) {
    if (!/duckduckgo\.com$/i.test(direct.hostname)) {
      return href;
    }

    const encoded = direct.searchParams.get("uddg");
    return encoded ? decodeURIComponent(encoded) : null;
  }

  const relativeMatch = href.match(/uddg=([^&]+)/i);
  if (!relativeMatch) {
    return null;
  }

  return decodeURIComponent(relativeMatch[1]);
}

async function readToastCatalog(): Promise<ToastCatalog> {
  const payload = JSON.parse(
    await readFile(METADATA_FILE_PATH, "utf8"),
  ) as MetadataPayload;

  const projects = Array.isArray(payload.projects)
    ? payload.projects
    : Object.values(payload.categories ?? {}).flat();

  const categories = uniqueNormalized(
    Object.keys(payload.category_counts ?? {}),
  );
  const sectors = uniqueNormalized(
    projects.flatMap((project) => project.sectors ?? []),
  );
  const services = uniqueNormalized(
    projects.flatMap((project) => project.services ?? []),
  );
  const clientLabels = uniqueNormalized(
    projects.flatMap((project) => [
      project.client ?? "",
      project.name ?? "",
      project.slug ?? "",
    ]),
  );

  return {
    categories,
    services,
    sectors,
    clientLabels,
  };
}

let toastCatalogPromise: Promise<ToastCatalog> | null = null;

function getToastCatalog(): Promise<ToastCatalog> {
  if (!toastCatalogPromise) {
    toastCatalogPromise = readToastCatalog();
  }

  return toastCatalogPromise;
}

async function discoverOfficialWebsite(
  companyName: string,
): Promise<{ officialWebsiteUrl: string | null; candidates: string[] }> {
  const discovered: string[] = [];

  try {
    const clearbitResponse = await fetch(
      `https://autocomplete.clearbit.com/v1/companies/suggest?query=${encodeURIComponent(
        companyName,
      )}`,
    );
    if (clearbitResponse.ok) {
      const payload = (await clearbitResponse.json()) as Array<{
        domain?: string;
      }>;

      for (const item of payload) {
        if (!item.domain) {
          continue;
        }
        discovered.push(`https://${item.domain}`);
      }
    }
  } catch {
    // Keep fallback discovery resilient when third-party lookups fail.
  }

  try {
    const ddgResponse = await fetch(
      `https://duckduckgo.com/html/?q=${encodeURIComponent(`${companyName} official website`)}`,
      {
        headers: {
          "User-Agent":
            "Mozilla/5.0 (compatible; toast-proposal-agent/1.0; +https://toast.au)",
        },
      },
    );

    if (ddgResponse.ok) {
      const html = await ddgResponse.text();
      const hrefMatches = html.match(/href="([^"]+)"/gi) ?? [];

      for (const hrefRaw of hrefMatches.slice(0, 100)) {
        const href = hrefRaw.replace(/^href="/i, "").replace(/"$/, "");
        const decoded = decodeDuckDuckGoHref(href);
        if (decoded) {
          discovered.push(decoded);
        }
      }
    }
  } catch {
    // Keep fallback discovery resilient when search lookup fails.
  }

  const uniqueCandidates = [...new Set(discovered)]
    .map((value) => value.trim())
    .filter((value) => /^https?:\/\//i.test(value));

  let bestUrl: string | null = null;
  let bestScore = Number.NEGATIVE_INFINITY;

  for (const candidate of uniqueCandidates) {
    const parsed = safeParseUrl(candidate);
    if (!parsed) {
      continue;
    }

    const score = scoreOfficialWebsiteCandidate(parsed, companyName);
    if (score > bestScore) {
      bestScore = score;
      bestUrl = parsed.toString();
    }
  }

  return {
    officialWebsiteUrl: bestUrl,
    candidates: uniqueCandidates.slice(0, 25),
  };
}

async function fetchCustomerPage(url: string): Promise<{
  url: string;
  title: string | null;
  text: string;
}> {
  const response = await fetch(url, {
    headers: {
      "User-Agent":
        "Mozilla/5.0 (compatible; toast-proposal-agent/1.0; +https://toast.au)",
    },
  });

  if (!response.ok) {
    throw new Error(
      `Could not fetch ${url}: ${response.status} ${response.statusText}`,
    );
  }

  const html = await response.text();
  const text = stripHtml(html);

  return {
    url,
    title: extractTitle(html),
    text,
  };
}

async function researchCustomerProfile(args: {
  websiteUrl?: string;
  relatedContent?: string[];
  customerName?: string;
}): Promise<Record<string, unknown>> {
  const toastCatalog = await getToastCatalog();
  const normalizedName = args.customerName?.trim();
  const explicitWebsite = args.websiteUrl?.trim();

  if (!explicitWebsite && !normalizedName) {
    throw new Error(
      "researchCustomerProfile requires either websiteUrl or customerName.",
    );
  }

  const discovered =
    !explicitWebsite && normalizedName
      ? await discoverOfficialWebsite(normalizedName)
      : { officialWebsiteUrl: null, candidates: [] };

  const primaryWebsite = explicitWebsite || discovered.officialWebsiteUrl;

  if (!primaryWebsite) {
    throw new Error(
      `Could not discover an official website for ${normalizedName}. Ask the user for the company website URL.`,
    );
  }

  const urls = [primaryWebsite, ...(args.relatedContent ?? [])]
    .map((value) => value.trim())
    .filter(Boolean);

  const pages = await Promise.all(
    urls.map(async (url) => {
      try {
        return await fetchCustomerPage(url);
      } catch (error) {
        const message = error instanceof Error ? error.message : String(error);
        return {
          url,
          title: null,
          text: "",
          error: message,
        };
      }
    }),
  );

  const combinedText = pages
    .map((page) => page.text)
    .filter(Boolean)
    .join(" ")
    .slice(0, 80_000);

  const detectedCategories = findMatches(
    combinedText,
    toastCatalog.categories,
    8,
  );
  const detectedSectors = findMatches(combinedText, toastCatalog.sectors, 10);
  const detectedServices = findMatches(combinedText, toastCatalog.services, 20);

  const matchedToastClients = args.customerName
    ? findMatches(args.customerName, toastCatalog.clientLabels, 5)
    : [];

  return {
    customerName: normalizedName ?? null,
    discoveredWebsiteUrl: explicitWebsite
      ? null
      : discovered.officialWebsiteUrl,
    discoveryCandidates: discovered.candidates,
    analyzedUrls: pages.map((page) => ({
      url: page.url,
      title: page.title,
      textExtractLength: page.text.length,
      error: "error" in page ? page.error : null,
    })),
    detectedCategories,
    detectedSectors,
    detectedServices,
    matchedToastClients,
    summarySnippet: combinedText.slice(0, 1200),
  };
}

// ── Canned data the read tools serve ────────────────────────────────────────

type Charge = { id: string; amount: number; date: string; description: string };

// Note the planted duplicate: ch_001 and ch_002 are the same charge.
export const CHARGES: Record<string, Charge[]> = {
  cus_88121: [
    {
      id: "ch_001",
      amount: 4900,
      date: "2026-05-01",
      description: "Pro plan — monthly",
    },
    {
      id: "ch_002",
      amount: 4900,
      date: "2026-05-01",
      description: "Pro plan — monthly",
    },
    {
      id: "ch_003",
      amount: 1500,
      date: "2026-04-18",
      description: "Extra seats",
    },
  ],
};

const KNOWLEDGE_BASE: Record<string, string> = {
  billing:
    "Double charges are usually a duplicate authorization that drops off in 3–5 days. If it already settled, refund immediately.",
  refund: "Refunds post in 5–10 business days. Pro accounts can be expedited.",
  export:
    "The Safari export failure is a known bug (TICKET-4412). Workaround: use Chrome or the CSV export.",
  pricing:
    "Team plans are $20/seat/mo with a volume discount at 25+ seats. For 50+ seats, send the pricing PDF.",
};

export function searchKB(query: string): string[] {
  const q = query.toLowerCase();
  const hits = Object.entries(KNOWLEDGE_BASE)
    .filter(([key]) => q.includes(key))
    .map(([, article]) => article);
  return hits.length ? hits : ["No exact match — use your judgment."];
}

// ── The read/compute API exposed INTO the sandbox (Code Mode) ────────────────
//
// When the agent writes code, these are the functions it can call. They're
// read-only: a re-run (after a crash) is harmless, so the whole runCode step can
// stay a single durable unit without risking duplicate side effects.
const sandboxApi: SandboxApi = {
  getCharges: async (customerId: string) => CHARGES[customerId] ?? [],
  searchKnowledgeBase: async (query: string) => searchKB(query),
};

// ── The tool SCHEMAS the model sees ─────────────────────────────────────────

export const tools = {
  // Code Mode: instead of chaining a dozen tool calls (each round-tripping
  // through the model), the agent writes ONE program that fetches and analyzes.
  runCode: tool({
    description: [
      "Run a JavaScript program (an async function body) to fetch and analyze data.",
      "Available inside the program:",
      "  • await tools.getCharges(customerId) → [{ id, amount (cents), date, description }]",
      "  • await tools.searchKnowledgeBase(query) → string[]",
      "  • console.log(...) for debugging",
      "Use `return` to return your result (any JSON value).",
    ].join("\n"),
    inputSchema: z.object({ code: z.string() }),
  }),

  classifyItem: tool({
    description: "Classify a work item into a category.",
    inputSchema: z.object({
      itemId: z.string(),
      category: z.enum(["billing", "technical", "sales", "other"]),
    }),
  }),
  draftReply: tool({
    description: "Write a draft reply for a work item. Does not send anything.",
    inputSchema: z.object({ itemId: z.string(), message: z.string() }),
  }),
  sendReply: tool({
    description:
      "Send the drafted reply to the customer. This really emails them.",
    inputSchema: z.object({ itemId: z.string(), draftId: z.string() }),
  }),

  createTemplateForUser: tool({
    description:
      "Clone-only mode: create a new Templated folder and duplicate the main template for a specific client, without populating proposal layers. Ask the user for the template name if one was not provided, and only call this tool after you have a templateName.",
    inputSchema: z.object({
      username: z.string(),
      templateName: z.string().min(1),
    }),
  }),

  createAndPopulateTemplateForUser: tool({
    description:
      "Preferred mode for proposal creation: create a new Templated folder, duplicate the main template, select proposal clients, upload their logos, and populate presentation + clients-detail layers. Ask the user for the template name if one was not provided, and only call this tool after you have a templateName.",
    inputSchema: z.object({
      username: z.string(),
      templateName: z.string().min(1),
      clientName: z.string().optional(),
      serviceFocus: z.array(z.string()).optional(),
      approvedClientNames: z.array(z.string()).optional(),
    }),
  }),

  previewProposalClients: tool({
    description:
      "Suggest the 32 proposal client names (with logo compatibility) before creating a template so the user can approve or request changes.",
    inputSchema: z.object({
      clientName: z.string().optional(),
      serviceFocus: z.array(z.string()).optional(),
      approvedClientNames: z.array(z.string()).optional(),
    }),
  }),

  researchCustomerProfile: tool({
    description:
      "Fetch and analyze a customer profile for proposals. You can provide only customerName and the tool will discover a likely official website automatically. Then it extracts and categorizes likely sectors/services using the Toast client and service catalog.",
    inputSchema: z
      .object({
        websiteUrl: z.string().url().optional(),
        relatedContent: z.array(z.string().url()).max(5).optional(),
        customerName: z.string().optional(),
      })
      .refine((value) => Boolean(value.websiteUrl || value.customerName), {
        message: "Provide at least one of websiteUrl or customerName",
      }),
  }),

  // Privileged: only the billing specialist gets this. Moves real money.
  issueRefund: tool({
    description:
      "Issue a refund to the customer. IRREVERSIBLE — this moves real money.",
    inputSchema: z.object({
      customerId: z.string(),
      chargeId: z.string(),
      amountCents: z.number(),
    }),
  }),

  // Hand the conversation to a specialist agent. The harness intercepts this —
  // it switches the running agent rather than executing a tool.
  handoff: tool({
    description:
      "Hand off the conversation to a specialist agent when the task needs a capability you don't have (e.g. issuing a refund → billing).",
    inputSchema: z.object({ to: z.enum(["billing"]), reason: z.string() }),
  }),
};

// ── The harness-owned executor ──────────────────────────────────────────────
//
// `runCode` is mediated: it never runs in the host process, only in the sandbox.
// The side-effecting tools (sendReply) still run here as normal durable steps.
export async function runTool(
  name: string,
  args: Record<string, unknown>,
  reportProgress?: TemplateProgressReporter,
): Promise<Record<string, unknown>> {
  switch (name) {
    case "runCode":
      return runInSandbox(String(args.code ?? ""), sandboxApi);
    case "getCharges":
      return { charges: CHARGES[String(args.customerId)] ?? [] };
    case "searchKnowledgeBase":
      return { articles: searchKB(String(args.query ?? "")) };
    case "classifyItem":
      return { ok: true, itemId: args.itemId, category: args.category };
    case "draftReply":
      return { ok: true, draftId: `draft-${args.itemId}` };
    case "sendReply":
      return { sent: true, itemId: args.itemId, draftId: args.draftId };
    case "createTemplateForUser":
      return (await createTemplateForUser(
        String(args.username ?? ""),
        typeof args.templateName === "string" && args.templateName.trim()
          ? args.templateName.trim()
          : undefined,
      )) as unknown as Record<string, unknown>;
    case "createAndPopulateTemplateForUser":
      return (await createAndPopulateTemplateForUser(
        String(args.username ?? ""),
        typeof args.templateName === "string" && args.templateName.trim()
          ? args.templateName.trim()
          : undefined,
        {
          clientName:
            typeof args.clientName === "string" && args.clientName.trim()
              ? args.clientName.trim()
              : undefined,
          serviceFocus: Array.isArray(args.serviceFocus)
            ? args.serviceFocus
                .filter((value): value is string => typeof value === "string")
                .map((value) => value.trim())
                .filter(Boolean)
            : undefined,
          approvedClientNames: Array.isArray(args.approvedClientNames)
            ? args.approvedClientNames
                .filter((value): value is string => typeof value === "string")
                .map((value) => value.trim())
                .filter(Boolean)
            : undefined,
        },
        reportProgress,
      )) as unknown as Record<string, unknown>;
    case "previewProposalClients":
      return (await previewProposalClients({
        clientName:
          typeof args.clientName === "string" && args.clientName.trim()
            ? args.clientName.trim()
            : undefined,
        serviceFocus: Array.isArray(args.serviceFocus)
          ? args.serviceFocus
              .filter((value): value is string => typeof value === "string")
              .map((value) => value.trim())
              .filter(Boolean)
          : undefined,
        approvedClientNames: Array.isArray(args.approvedClientNames)
          ? args.approvedClientNames
              .filter((value): value is string => typeof value === "string")
              .map((value) => value.trim())
              .filter(Boolean)
          : undefined,
      })) as unknown as Record<string, unknown>;
    case "researchCustomerProfile":
      return await researchCustomerProfile({
        websiteUrl:
          typeof args.websiteUrl === "string" && args.websiteUrl.trim()
            ? args.websiteUrl.trim()
            : undefined,
        relatedContent: Array.isArray(args.relatedContent)
          ? args.relatedContent
              .filter((value): value is string => typeof value === "string")
              .map((value) => value.trim())
              .filter(Boolean)
          : undefined,
        customerName:
          typeof args.customerName === "string" && args.customerName.trim()
            ? args.customerName.trim()
            : undefined,
      });
    case "issueRefund":
      return {
        refunded: true,
        customerId: args.customerId,
        chargeId: args.chargeId,
        amountCents: args.amountCents,
      };
    default:
      throw new Error(`unknown tool: ${name}`);
  }
}
