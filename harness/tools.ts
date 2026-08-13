import { tool } from "ai";
import { readFile } from "node:fs/promises";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { z } from "zod";
import { runInSandbox, type SandboxApi } from "./sandbox";
import {
  createAndPopulateTemplateForUser,
  populateClientStoryPages,
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

// ── The read/compute API exposed INTO the sandbox (Code Mode) ────────────────
//
// When the agent writes code, these are the functions it can call. Kept empty
// for now — runCode is still available as generic compute infra, and read-only
// functions can be added here later without changing the durable loop.
const sandboxApi: SandboxApi = {};

// ── The tool SCHEMAS the model sees ─────────────────────────────────────────

export const tools = {
  // Code Mode: instead of chaining a dozen tool calls (each round-tripping
  // through the model), the agent writes ONE program that fetches and analyzes.
  runCode: tool({
    description: [
      "Run a JavaScript program (an async function body) to compute or analyze data.",
      "Available inside the program:",
      "  • console.log(...) for debugging",
      "Use `return` to return your result (any JSON value).",
    ].join("\n"),
    inputSchema: z.object({ code: z.string() }),
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

  populateClientStoryPages: tool({
    description:
      "Populate story pages for the best matching clients as a separate post-template step. Copies story template pages, fills text/image layers, verifies page creation, and returns created story/page counts.",
    inputSchema: z.object({
      templateId: z.string().min(1),
      clientName: z.string().optional(),
      serviceFocus: z.array(z.string()).optional(),
      approvedClientNames: z.array(z.string()).optional(),
      maxCompanies: z.number().int().min(1).max(12).optional(),
    }),
  }),

};

// ── The harness-owned executor ──────────────────────────────────────────────
//
// `runCode` is mediated: it never runs in the host process, only in the sandbox.
// The proposal tools run here as normal durable steps.
export async function runTool(
  name: string,
  args: Record<string, unknown>,
  reportProgress?: TemplateProgressReporter,
): Promise<Record<string, unknown>> {
  switch (name) {
    case "runCode":
      return runInSandbox(String(args.code ?? ""), sandboxApi);
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
    case "populateClientStoryPages":
      return (await populateClientStoryPages(
        typeof args.templateId === "string" ? args.templateId.trim() : "",
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
          maxCompanies:
            typeof args.maxCompanies === "number" &&
            Number.isFinite(args.maxCompanies)
              ? Math.trunc(args.maxCompanies)
              : undefined,
        },
        reportProgress,
      )) as unknown as Record<string, unknown>;
    default:
      throw new Error(`unknown tool: ${name}`);
  }
}
