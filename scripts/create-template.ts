import {
  TEMPLATED_API_BASE_URL,
  TEMPLATED_API_KEY,
  TEMPLATED_COOKIE,
  TEMPLATED_EDITOR_BASE_URL,
  TEMPLATED_MAIN_TEMPLATE_ID,
} from "../server/env";
import { readFile, readdir } from "node:fs/promises";
import path from "node:path";
import { fileURLToPath } from "node:url";

interface TemplatedFolder {
  id: string;
  name?: string;
  [key: string]: unknown;
}

interface TemplatedTemplate {
  id: string;
  name?: string;
  [key: string]: unknown;
}

interface TemplatedFolderListResponse {
  folders?: TemplatedFolder[];
  data?: TemplatedFolder[];
  items?: TemplatedFolder[];
  [key: string]: unknown;
}

interface WorkflowResult {
  username: string;
  folder: TemplatedFolder;
  template: TemplatedTemplate;
}

interface ProposalClientEntry {
  slug: string;
  displayName: string;
  logoFilePath: string;
  primarySector: string;
  category: string;
  score: number;
}

interface PopulateTemplateOptions {
  clientName?: string;
  serviceFocus?: string[];
}

interface ClientSelectionOptions extends PopulateTemplateOptions {
  approvedClientNames?: string[];
}

interface ProposalLayerPayload {
  pages: Array<{
    page: string;
    layers: Record<string, Record<string, string | number>>;
  }>;
}

interface ProposalTemplateResult extends WorkflowResult {
  editableUrl: string;
  verificationSummary: string;
  selectedClients: ProposalClientEntry[];
  uploadedLogos: Array<{
    slug: string;
    displayName: string;
    logoFilePath: string;
    logoUrl: string;
  }>;
  appliedLayers: {
    presentation: string[];
    clientsDetail: string[];
  };
}

export type TemplateProgressReporter = (
  message: string,
) => void | Promise<void>;

export interface ProposalClientPreview {
  selectedClients: Array<{
    slug: string;
    name: string;
    sector: string;
    category: string;
  }>;
}

interface MetadataProject {
  slug?: string;
  name?: string;
  client?: string | null;
  category?: string;
  sectors?: string[];
  services?: string[];
  description?: string;
}

interface MetadataPayload {
  projects?: MetadataProject[];
  categories?: Record<string, MetadataProject[]>;
}

interface MetadataCatalog {
  projects: MetadataProject[];
  categoryBySlug: Map<string, string>;
}

interface SeedProfile {
  category?: string;
  sectors: string[];
  services: string[];
}

const CLIENTS_PER_PAGE = 32;
const CLIENTS_PER_COLUMN = 16;
const LOGO_GRID_COLUMNS = 4;
const LOGO_GRID_ROWS = 5;
const LOGO_GRID_TOTAL = LOGO_GRID_COLUMNS * LOGO_GRID_ROWS;
const LOGO_WIDTH = 152;
const LOGO_HEIGHT = 81;
const TEMPLATED_REQUEST_TIMEOUT_MS = 45_000;
const MAX_DISPLAY_NAME_LENGTH = 35;

const CURRENT_FILE_PATH = fileURLToPath(import.meta.url);
const REPO_ROOT = path.resolve(path.dirname(CURRENT_FILE_PATH), "..");
const METADATA_FILE_PATH = path.join(
  REPO_ROOT,
  "data",
  "toast_clients_with_metadata.json",
);
const LOGOS_DIRECTORY_PATH = path.join(REPO_ROOT, "data", "clients-logos");

class TemplatedApiError extends Error {
  public readonly status: number;
  public readonly response: unknown;

  constructor(message: string, status: number, response: unknown) {
    super(message);
    this.name = "TemplatedApiError";
    this.status = status;
    this.response = response;
  }
}

async function templatedRequest<T>(
  path: string,
  options: RequestInit = {},
): Promise<T> {
  if (!TEMPLATED_API_KEY) {
    throw new Error("Missing TEMPLATED_API_KEY environment variable.");
  }

  const controller = new AbortController();
  const timeout = setTimeout(() => {
    controller.abort(
      new Error(
        `Templated request timed out after ${TEMPLATED_REQUEST_TIMEOUT_MS}ms`,
      ),
    );
  }, TEMPLATED_REQUEST_TIMEOUT_MS);

  let response: Response;
  try {
    response = await fetch(`${TEMPLATED_API_BASE_URL}${path}`, {
      ...options,
      signal: controller.signal,
      headers: {
        Authorization: `Bearer ${TEMPLATED_API_KEY}`,
        ...(TEMPLATED_COOKIE ? { Cookie: TEMPLATED_COOKIE } : {}),
        ...options.headers,
      },
    });
  } finally {
    clearTimeout(timeout);
  }

  const responseText = await response.text();

  let responseBody: unknown = null;

  if (responseText) {
    try {
      responseBody = JSON.parse(responseText);
    } catch {
      responseBody = responseText;
    }
  }

  if (!response.ok) {
    throw new TemplatedApiError(
      `Templated API request failed: ${response.status} ${response.statusText}`,
      response.status,
      responseBody,
    );
  }

  return responseBody as T;
}

function normalizeKey(value: string): string {
  return value.toLowerCase().replace(/[^a-z0-9]/g, "");
}

function cleanDisplayName(value: string): string {
  const normalized = value.replace(/\s+/g, " ").trim();

  const replacements: Array<[RegExp, string]> = [
    [/\bnsw\b/gi, "NSW"],
    [/\bwwf\b/gi, "WWF"],
    [/\bux\/ui\b/gi, "UX/UI"],
    [/\bgov(?:ern)?ment\b/gi, "Government"],
    [/\blj\b/gi, "LJ"],
  ];

  let output = normalized;
  for (const [pattern, replacement] of replacements) {
    output = output.replace(pattern, replacement);
  }

  // Remove standalone years and year ranges that are usually campaign labels.
  output = output.replace(
    /\b(?:19|20)\d{2}(?:\s*[-\/]\s*(?:19|20)\d{2})?\b/g,
    "",
  );

  // If a name is a list of multiple organizations, keep the first one.
  const commaSeparated = output
    .split(/[,;]+/)
    .map((part) => part.trim())
    .filter(Boolean);
  if (commaSeparated.length > 1) {
    output = commaSeparated[0] ?? output;
  } else if (output.length > 45 && /\s+&\s+/.test(output)) {
    // Avoid over-trimming short legitimate names like "Marks & Spencer".
    output = output.split(/\s+&\s+/)[0] ?? output;
  }

  output = output
    .replace(/\(\s*\)/g, "")
    .replace(/\s{2,}/g, " ")
    .replace(/[\s,;:\-\/]+$/g, "")
    .trim();

  if (output.length > MAX_DISPLAY_NAME_LENGTH) {
    const slice = output.slice(0, MAX_DISPLAY_NAME_LENGTH + 1);
    const lastSpace = slice.lastIndexOf(" ");
    output = (lastSpace >= 16 ? slice.slice(0, lastSpace) : slice).trim();
  }

  return output;
}

function primarySector(project: MetadataProject): string {
  const first = Array.isArray(project.sectors) ? project.sectors[0] : undefined;
  return first && first.trim() ? first.trim() : "Other";
}

function scoreProject(project: MetadataProject, displayName: string): number {
  const hasNamedClient = Boolean(project.client && project.client.trim());
  const sectorCount = Array.isArray(project.sectors)
    ? project.sectors.length
    : 0;
  const serviceCount = Array.isArray(project.services)
    ? project.services.length
    : 0;
  const descriptionLength = (project.description ?? "").trim().length;
  const nameLength = displayName.length;

  return (
    (hasNamedClient ? 120 : 60) +
    sectorCount * 8 +
    serviceCount * 2 +
    Math.min(40, Math.floor(descriptionLength / 120)) +
    Math.min(20, Math.floor(nameLength / 6))
  );
}

function serviceFocusBoost(
  project: MetadataProject,
  normalizedServiceFocus: string[],
): number {
  if (normalizedServiceFocus.length === 0) {
    return 0;
  }

  const services = Array.isArray(project.services)
    ? project.services.map((service) => service.toLowerCase())
    : [];

  let score = 0;
  for (const focus of normalizedServiceFocus) {
    if (services.some((service) => service.includes(focus))) {
      score += 40;
      continue;
    }

    if (
      focus.includes("seo") &&
      services.some((service) =>
        /digital|content|marketing|copywriting|social/i.test(service),
      )
    ) {
      score += 20;
      continue;
    }

    if (
      /(web|website|development|dev)/.test(focus) &&
      services.some((service) =>
        /ux\/ui|web design|wireframing|prototyping/i.test(service),
      )
    ) {
      score += 20;
      continue;
    }

    if (
      /(design|branding|brand)/.test(focus) &&
      services.some((service) => /visual|logo|identity|brand/i.test(service))
    ) {
      score += 20;
      continue;
    }
  }

  return score;
}

function normalizeProjectCategoryMap(
  categories: Record<string, MetadataProject[]> | undefined,
): Map<string, string> {
  const categoryBySlug = new Map<string, string>();

  for (const [categoryName, projects] of Object.entries(categories ?? {})) {
    for (const project of projects ?? []) {
      const slug = project.slug?.trim();
      if (!slug) {
        continue;
      }

      categoryBySlug.set(normalizeKey(slug), categoryName);
    }
  }

  return categoryBySlug;
}

async function readMetadataCatalog(): Promise<MetadataCatalog> {
  const raw = await readFile(METADATA_FILE_PATH, "utf8");
  const payload = JSON.parse(raw) as MetadataPayload;
  const categoryBySlug = normalizeProjectCategoryMap(payload.categories);
  const projects = Array.isArray(payload.projects)
    ? payload.projects
    : Object.values(payload.categories ?? {}).flat();

  return {
    projects: projects.map((project) => {
      const slug = project.slug?.trim();
      const category = slug
        ? categoryBySlug.get(normalizeKey(slug))
        : undefined;

      return {
        ...project,
        category: project.category ?? category,
      };
    }),
    categoryBySlug,
  };
}

function findSeedProject(
  clientName: string | undefined,
  projects: MetadataProject[],
): MetadataProject | undefined {
  const normalizedClientName = clientName?.trim();
  if (!normalizedClientName) {
    return undefined;
  }

  const normalizedTarget = normalizeKey(normalizedClientName);
  if (!normalizedTarget) {
    return undefined;
  }

  const exactMatch = projects.find((project) => {
    const candidates = [project.slug, project.name, project.client].filter(
      (value): value is string => Boolean(value && value.trim()),
    );

    return candidates.some((value) => normalizeKey(value) === normalizedTarget);
  });

  if (exactMatch) {
    return exactMatch;
  }

  return projects.find((project) => {
    const candidates = [project.slug, project.name, project.client].filter(
      (value): value is string => Boolean(value && value.trim()),
    );

    return candidates.some((value) => {
      const normalizedValue = normalizeKey(value);
      return (
        normalizedValue.includes(normalizedTarget) ||
        normalizedTarget.includes(normalizedValue)
      );
    });
  });
}

function buildSeedProfile(
  seedProject: MetadataProject | undefined,
): SeedProfile {
  return {
    category: seedProject?.category,
    sectors: (seedProject?.sectors ?? [])
      .map((value) => value.trim().toLowerCase())
      .filter(Boolean),
    services: (seedProject?.services ?? [])
      .map((value) => value.trim().toLowerCase())
      .filter(Boolean),
  };
}

function similarityBoost(
  candidate: MetadataProject,
  seedProfile: SeedProfile,
): number {
  let score = 0;

  if (
    seedProfile.category &&
    candidate.category &&
    candidate.category === seedProfile.category
  ) {
    score += 120;
  }

  const candidateSectors = new Set(
    (candidate.sectors ?? [])
      .map((value) => value.trim().toLowerCase())
      .filter(Boolean),
  );

  for (const sector of seedProfile.sectors) {
    if (candidateSectors.has(sector)) {
      score += 30;
    }
  }

  const candidateServices = new Set(
    (candidate.services ?? [])
      .map((value) => value.trim().toLowerCase())
      .filter(Boolean),
  );

  for (const service of seedProfile.services) {
    if (candidateServices.has(service)) {
      score += 8;
    }
  }

  return score;
}

function createContainSvgAsset(
  logoFilePath: string,
  sourceBytes: Uint8Array,
): { fileName: string; bytes: Uint8Array; contentType: string } {
  const baseName = path.basename(logoFilePath, path.extname(logoFilePath));
  const sourceExt = path.extname(logoFilePath).toLowerCase();
  const sourceContentTypeByExt: Record<string, string> = {
    ".png": "image/png",
    ".jpg": "image/jpeg",
    ".jpeg": "image/jpeg",
    ".webp": "image/webp",
    ".svg": "image/svg+xml",
  };
  const sourceContentType =
    sourceContentTypeByExt[sourceExt] ?? "application/octet-stream";
  const sourceDataUri = `data:${sourceContentType};base64,${Buffer.from(
    sourceBytes,
  ).toString("base64")}`;

  const svg = `<?xml version="1.0" encoding="UTF-8"?>
<svg xmlns="http://www.w3.org/2000/svg" width="${LOGO_WIDTH}" height="${LOGO_HEIGHT}" viewBox="0 0 ${LOGO_WIDTH} ${LOGO_HEIGHT}">
  <image href="${sourceDataUri}" x="0" y="0" width="100%" height="100%" preserveAspectRatio="xMidYMid meet" />
</svg>`;

  return {
    fileName: `${baseName}-contain.svg`,
    bytes: new TextEncoder().encode(svg),
    contentType: "image/svg+xml",
  };
}

async function readLogoIndex(): Promise<Map<string, string>> {
  const logoFiles = await readdir(LOGOS_DIRECTORY_PATH);
  const logoIndex = new Map<string, string>();

  for (const logoFile of logoFiles) {
    const ext = path.extname(logoFile).toLowerCase();
    if (![".png", ".jpg", ".jpeg", ".webp", ".svg"].includes(ext)) {
      continue;
    }

    const fileStem = path.basename(logoFile, ext);
    const key = normalizeKey(fileStem);

    if (!key) {
      continue;
    }

    if (!logoIndex.has(key)) {
      logoIndex.set(key, path.join(LOGOS_DIRECTORY_PATH, logoFile));
    }
  }

  return logoIndex;
}

function resolveLogoPath(
  project: MetadataProject,
  logoIndex: Map<string, string>,
): string | null {
  const candidates = [project.slug, project.client, project.name]
    .filter((value): value is string => Boolean(value && value.trim()))
    .map((value) => normalizeKey(value));

  for (const key of candidates) {
    const direct = logoIndex.get(key);
    if (direct) {
      return direct;
    }
  }

  return null;
}

function normalizeApprovedName(value: string): string {
  return normalizeKey(cleanDisplayName(value));
}

function applyApprovedClientOverrides(
  rankedCandidates: ProposalClientEntry[],
  approvedClientNames: string[],
): ProposalClientEntry[] {
  if (approvedClientNames.length === 0) {
    return rankedCandidates;
  }

  const byDisplayName = new Map<string, ProposalClientEntry[]>();
  const bySlug = new Map<string, ProposalClientEntry[]>();

  for (const candidate of rankedCandidates) {
    const nameKey = normalizeApprovedName(candidate.displayName);
    const slugKey = normalizeKey(candidate.slug);

    const nameList = byDisplayName.get(nameKey) ?? [];
    nameList.push(candidate);
    byDisplayName.set(nameKey, nameList);

    const slugList = bySlug.get(slugKey) ?? [];
    slugList.push(candidate);
    bySlug.set(slugKey, slugList);
  }

  const selected: ProposalClientEntry[] = [];
  const usedSlugs = new Set<string>();
  const usedDisplayNames = new Set<string>();

  for (const rawName of approvedClientNames) {
    const normalized = normalizeApprovedName(rawName);
    if (!normalized) {
      continue;
    }

    const slugMatches = bySlug.get(normalized) ?? [];
    const nameMatches = byDisplayName.get(normalized) ?? [];
    const matches = [...slugMatches, ...nameMatches];

    const chosen = matches.find((candidate) => {
      const nameKey = normalizeApprovedName(candidate.displayName);
      return !usedSlugs.has(candidate.slug) && !usedDisplayNames.has(nameKey);
    });
    if (!chosen) {
      continue;
    }

    const chosenNameKey = normalizeApprovedName(chosen.displayName);
    selected.push(chosen);
    usedSlugs.add(chosen.slug);
    usedDisplayNames.add(chosenNameKey);

    if (selected.length === CLIENTS_PER_PAGE) {
      return selected;
    }
  }

  for (const candidate of rankedCandidates) {
    const nameKey = normalizeApprovedName(candidate.displayName);
    if (usedSlugs.has(candidate.slug)) {
      continue;
    }
    if (usedDisplayNames.has(nameKey)) {
      continue;
    }

    selected.push(candidate);
    usedSlugs.add(candidate.slug);
    usedDisplayNames.add(nameKey);

    if (selected.length === CLIENTS_PER_PAGE) {
      break;
    }
  }

  return selected;
}

async function selectProposalClients(
  options: ClientSelectionOptions,
): Promise<ProposalClientEntry[]> {
  const [catalog, logoIndex] = await Promise.all([
    readMetadataCatalog(),
    readLogoIndex(),
  ]);
  const { projects } = catalog;
  const normalizedServiceFocus = (options.serviceFocus ?? [])
    .map((value) => value.trim().toLowerCase())
    .filter(Boolean);
  const seedProfile = buildSeedProfile(
    findSeedProject(options.clientName, projects),
  );

  const dedupe = new Set<string>();
  const candidates: ProposalClientEntry[] = [];

  for (const project of projects) {
    const slug = project.slug?.trim();
    const projectName = project.name?.trim();

    if (!slug || !projectName) {
      continue;
    }

    const logoFilePath = resolveLogoPath(project, logoIndex);
    if (!logoFilePath) {
      continue;
    }

    const sourceDisplayName =
      project.client && project.client.trim() ? project.client : projectName;
    const displayName = cleanDisplayName(sourceDisplayName);
    const dedupeKey = normalizeKey(displayName);
    const category = project.category ?? "Other";

    if (dedupe.has(dedupeKey)) {
      continue;
    }

    dedupe.add(dedupeKey);
    candidates.push({
      slug,
      displayName,
      logoFilePath,
      primarySector: primarySector(project),
      category,
      score:
        scoreProject(project, displayName) +
        serviceFocusBoost(project, normalizedServiceFocus) +
        similarityBoost(project, seedProfile),
    });
  }

  candidates.sort((a, b) => b.score - a.score);

  const selected: ProposalClientEntry[] = [];
  const sectorCount = new Map<string, number>();
  const sectorSoftCap = 6;

  for (const candidate of candidates) {
    const currentCount = sectorCount.get(candidate.primarySector) ?? 0;
    if (currentCount >= sectorSoftCap) {
      continue;
    }

    selected.push(candidate);
    sectorCount.set(candidate.primarySector, currentCount + 1);

    if (selected.length === CLIENTS_PER_PAGE) {
      break;
    }
  }

  if (selected.length < CLIENTS_PER_PAGE) {
    for (const candidate of candidates) {
      if (selected.some((entry) => entry.slug === candidate.slug)) {
        continue;
      }

      selected.push(candidate);

      if (selected.length === CLIENTS_PER_PAGE) {
        break;
      }
    }
  }

  if (selected.length < CLIENTS_PER_PAGE) {
    throw new Error(
      `Could not select ${CLIENTS_PER_PAGE} proposal clients with logos. Selected ${selected.length}.`,
    );
  }

  const approvedNames = (options.approvedClientNames ?? [])
    .map((value) => value.trim())
    .filter(Boolean);
  const withOverrides = applyApprovedClientOverrides(
    selected.slice(0, CLIENTS_PER_PAGE),
    approvedNames,
  );

  return withOverrides.slice(0, CLIENTS_PER_PAGE);
}

function extractUploadUrl(payload: unknown): string | null {
  if (!payload || typeof payload !== "object") {
    return null;
  }

  const data = payload as Record<string, unknown>;
  const urlCandidates = [
    data.url,
    data.path,
    data.image_url,
    data.imageUrl,
    data.src,
    (data.upload as Record<string, unknown> | undefined)?.url,
    (data.upload as Record<string, unknown> | undefined)?.path,
    (data.upload as Record<string, unknown> | undefined)?.image_url,
    (data.data as Record<string, unknown> | undefined)?.url,
    (data.data as Record<string, unknown> | undefined)?.path,
    (data.data as Record<string, unknown> | undefined)?.image_url,
  ];

  for (const candidate of urlCandidates) {
    if (typeof candidate === "string" && candidate.trim()) {
      return candidate;
    }
  }

  return null;
}

async function uploadLogoAsset(
  logoFilePath: string,
  tags: string[],
): Promise<string> {
  const bytes = await readFile(logoFilePath);
  const wrappedAsset = createContainSvgAsset(logoFilePath, bytes);
  const formData = new FormData();

  formData.append(
    "file",
    new Blob([Buffer.from(wrappedAsset.bytes)], {
      type: wrappedAsset.contentType,
    }),
    wrappedAsset.fileName,
  );
  for (const tag of tags) {
    formData.append("tags", tag);
  }

  let uploadResponse: unknown;
  try {
    uploadResponse = await templatedRequest<unknown>("/upload", {
      method: "POST",
      body: formData,
    });
  } catch (error) {
    if (error instanceof TemplatedApiError) {
      const responseText =
        typeof error.response === "string"
          ? error.response
          : JSON.stringify(error.response);
      throw new Error(
        `Logo upload failed for ${wrappedAsset.fileName}: ${error.message}. Response: ${responseText}`,
      );
    }
    throw error;
  }

  const uploadUrl = extractUploadUrl(uploadResponse);
  if (!uploadUrl) {
    throw new Error(
      `Logo upload did not return a URL for ${wrappedAsset.fileName}: ${JSON.stringify(
        uploadResponse,
      )}`,
    );
  }

  return uploadUrl;
}

async function uploadClientLogos(
  selectedClients: ProposalClientEntry[],
  reportProgress?: TemplateProgressReporter,
): Promise<Array<ProposalClientEntry & { logoUrl: string }>> {
  const uploaded: Array<ProposalClientEntry & { logoUrl: string }> = [];

  for (const client of selectedClients) {
    const progressMessage = `Uploading logo for ${client.displayName} (${client.slug})...`;
    console.log(progressMessage);
    if (reportProgress) {
      await reportProgress(progressMessage);
    }
    const logoUrl = await uploadLogoAsset(client.logoFilePath, [
      "proposal",
      "clients-detail",
      client.slug,
    ]);

    uploaded.push({ ...client, logoUrl });
  }

  return uploaded;
}

function buildLayerPayload(
  selectedClients: ProposalClientEntry[],
  uploadedLogos: Array<ProposalClientEntry & { logoUrl: string }>,
  options: PopulateTemplateOptions,
): ProposalLayerPayload {
  const today = new Date();
  const month = today
    .toLocaleString("en-US", { month: "short", timeZone: "UTC" })
    .toUpperCase();
  const year = String(today.getUTCFullYear());
  const leadName = options.clientName?.trim() || "Texcoco";

  const presentationLayers: Record<string, Record<string, string | number>> = {
    client_name: {
      layer: "client_name",
      type: "text",
      text: leadName,
    },
    month: {
      layer: "month",
      type: "text",
      text: month,
    },
    year: {
      layer: "year",
      type: "text",
      text: year,
    },
  };

  const clientsDetailLayers: Record<
    string,
    Record<string, string | number>
  > = {};

  for (let i = 0; i < CLIENTS_PER_COLUMN; i += 1) {
    const col1 = selectedClients[i];
    const col2 = selectedClients[i + CLIENTS_PER_COLUMN];
    const col1TextKey = `col1_client${i + 1}`;
    const col2TextKey = `col2_client${i + 1}`;

    clientsDetailLayers[col1TextKey] = {
      layer: col1TextKey,
      type: "text",
      text: `• ${col1.displayName}`,
    };

    clientsDetailLayers[col2TextKey] = {
      layer: col2TextKey,
      type: "text",
      text: `• ${col2.displayName}`,
    };
  }

  // Populate the explicit 4x5 logo grid expected by the clients-detail template.
  for (let col = 1; col <= LOGO_GRID_COLUMNS; col += 1) {
    for (let row = 1; row <= LOGO_GRID_ROWS; row += 1) {
      const index = (col - 1) * LOGO_GRID_ROWS + (row - 1);
      const client = uploadedLogos[index];

      if (!client) {
        continue;
      }

      const logoKey = `col${col}_logo${row}`;
      clientsDetailLayers[logoKey] = {
        layer: logoKey,
        type: "image",
        image_url: client.logoUrl,
        width: LOGO_WIDTH,
        height: LOGO_HEIGHT,
      };
    }
  }

  return {
    pages: [
      {
        page: "presentation",
        layers: presentationLayers,
      },
      {
        page: "clients-detail",
        layers: clientsDetailLayers,
      },
    ],
  };
}

async function updateTemplateLayers(
  templateId: string,
  payload: ProposalLayerPayload,
): Promise<void> {
  await templatedRequest<unknown>(
    `/template/${encodeURIComponent(templateId)}`,
    {
      method: "PUT",
      headers: {
        "Content-Type": "application/json",
      },
      body: JSON.stringify(payload),
    },
  );
}

function createEditableTemplateUrl(templateId: string): string {
  const base = TEMPLATED_EDITOR_BASE_URL.trim().replace(/\/+$/, "");
  return `${base}/${encodeURIComponent(templateId)}`;
}

function normalizeFolderName(folderName: string): string {
  return folderName.trim().toLowerCase();
}

function extractFolders(payload: unknown): TemplatedFolder[] {
  if (Array.isArray(payload)) {
    return payload.filter((entry): entry is TemplatedFolder =>
      Boolean(entry && typeof entry === "object"),
    ) as TemplatedFolder[];
  }

  if (!payload || typeof payload !== "object") {
    return [];
  }

  const response = payload as TemplatedFolderListResponse;
  const candidates = [
    response.folders,
    response.data,
    response.items,
    (response as Record<string, unknown>).results,
  ];

  for (const candidate of candidates) {
    if (Array.isArray(candidate)) {
      return candidate.filter((entry): entry is TemplatedFolder =>
        Boolean(entry && typeof entry === "object"),
      ) as TemplatedFolder[];
    }
  }

  return [];
}

async function listFolders(): Promise<TemplatedFolder[]> {
  try {
    const response = await templatedRequest<unknown>("/folders");
    return extractFolders(response).filter(
      (folder): folder is TemplatedFolder =>
        Boolean(folder && typeof folder === "object"),
    );
  } catch (error) {
    console.warn("Could not list folders; continuing with create flow.", error);
    return [];
  }
}

async function createFolder(folderName: string): Promise<TemplatedFolder> {
  const normalizedName = normalizeFolderName(folderName);
  const existingFolders = await listFolders();
  const existingFolder = existingFolders.find((folder) => {
    return normalizeFolderName(folder.name ?? "") === normalizedName;
  });

  if (existingFolder?.id) {
    console.log(`Using existing folder "${folderName}" (${existingFolder.id})`);
    return existingFolder;
  }

  console.log(`Creating folder "${folderName}"...`);

  try {
    const folder = await templatedRequest<TemplatedFolder>("/folder", {
      method: "POST",
      headers: {
        "Content-Type": "application/json",
      },
      body: JSON.stringify({
        name: folderName,
      }),
    });

    if (!folder?.id) {
      throw new Error(
        `Folder was created, but no folder ID was returned: ${JSON.stringify(
          folder,
        )}`,
      );
    }

    console.log(`Folder created: ${folder.id}`);

    return folder;
  } catch (error) {
    if (error instanceof TemplatedApiError) {
      const responseText =
        typeof error.response === "string"
          ? error.response
          : JSON.stringify(error.response);

      if (
        error.status === 409 ||
        /already exists|already exist|duplicate/i.test(responseText)
      ) {
        const matchedFolders = await listFolders();
        const matchedFolder = matchedFolders.find((folder) => {
          return normalizeFolderName(folder.name ?? "") === normalizedName;
        });

        if (matchedFolder?.id) {
          console.log(
            `Folder already exists; reusing existing folder "${folderName}" (${matchedFolder.id})`,
          );
          return matchedFolder;
        }
      }
    }

    throw error;
  }
}

async function duplicateTemplate(
  templateName: string,
): Promise<TemplatedTemplate> {
  console.log(`Duplicating template as "${templateName}"...`);

  const path =
    `/template/${encodeURIComponent(TEMPLATED_MAIN_TEMPLATE_ID)}/duplicate` +
    `?name=${encodeURIComponent(templateName)}`;

  const template = await templatedRequest<TemplatedTemplate>(path, {
    method: "POST",
  });

  if (!template?.id) {
    throw new Error(
      `Template was duplicated, but no template ID was returned: ${JSON.stringify(
        template,
      )}`,
    );
  }

  console.log(`Template duplicated: ${template.id}`);

  return template;
}

async function moveTemplateToFolder(
  folderId: string,
  templateId: string,
): Promise<void> {
  console.log(`Moving template ${templateId} into folder ${folderId}...`);

  await templatedRequest<unknown>(
    `/folder/${encodeURIComponent(folderId)}/template/${encodeURIComponent(
      templateId,
    )}`,
    {
      method: "PUT",
    },
  );

  console.log("Template moved successfully.");
}

export function resolveTemplateName(
  username: string,
  templateName?: string,
): string {
  const normalizedUsername = username.trim();

  if (!normalizedUsername) {
    throw new Error("Username cannot be empty.");
  }

  const normalizedTemplateName = templateName?.trim();

  if (!normalizedTemplateName) {
    throw new Error(
      "Template name is required. Ask the user for the desired template name before creating the template.",
    );
  }

  return normalizedTemplateName;
}

export async function createTemplateForUser(
  username: string,
  templateName?: string,
): Promise<WorkflowResult> {
  const normalizedUsername = username.trim();
  const normalizedTemplateName = resolveTemplateName(username, templateName);

  let folder: TemplatedFolder | undefined;
  let template: TemplatedTemplate | undefined;

  try {
    folder = await createFolder(normalizedUsername);

    template = await duplicateTemplate(normalizedTemplateName);

    await moveTemplateToFolder(folder.id, template.id);

    return {
      username: normalizedUsername,
      folder,
      template,
    };
  } catch (error) {
    console.error("Workflow failed.");

    if (folder?.id) {
      console.error(`Folder created before failure: ${folder.id}`);
    }

    if (template?.id) {
      console.error(`Template duplicated before failure: ${template.id}`);
    }

    throw error;
  }
}

export async function createAndPopulateTemplateForUser(
  username: string,
  templateName?: string,
  options: ClientSelectionOptions = {},
  reportProgress?: TemplateProgressReporter,
): Promise<ProposalTemplateResult> {
  const normalizedUsername = username.trim();
  const normalizedTemplateName = resolveTemplateName(username, templateName);

  let folder: TemplatedFolder | undefined;
  let template: TemplatedTemplate | undefined;

  try {
    folder = await createFolder(normalizedUsername);
    template = await duplicateTemplate(normalizedTemplateName);
    await moveTemplateToFolder(folder.id, template.id);

    if (reportProgress) {
      await reportProgress("Template cloned and moved to folder.");
    }

    const selectedClients = await selectProposalClients(options);
    const logoClients = selectedClients.slice(0, LOGO_GRID_TOTAL);
    if (reportProgress) {
      await reportProgress(
        `Selected ${selectedClients.length} clients; uploading ${logoClients.length} logos.`,
      );
    }
    const uploadedClients = await uploadClientLogos(
      logoClients,
      reportProgress,
    );
    const payload = buildLayerPayload(
      selectedClients,
      uploadedClients,
      options,
    );
    const presentationPage = payload.pages.find(
      (page) => page.page === "presentation",
    );
    const clientsDetailPage = payload.pages.find(
      (page) => page.page === "clients-detail",
    );

    const presentationLayers = presentationPage?.layers ?? {};
    const clientsLayers = clientsDetailPage?.layers ?? {};
    const textLayerEntries = Object.entries(clientsLayers).filter(([key]) =>
      /^col[12]_client\d+$/i.test(key),
    );
    const logoLayerEntries = Object.entries(clientsLayers).filter(([key]) =>
      /^col[1-4]_logo[1-5]$/i.test(key),
    );

    if (Object.keys(presentationLayers).length > 0) {
      if (reportProgress) {
        await reportProgress("Updating presentation page layers...");
      }
      await updateTemplateLayers(template.id, {
        pages: [
          {
            page: "presentation",
            layers: presentationLayers,
          },
        ],
      });
    }

    if (textLayerEntries.length > 0) {
      if (reportProgress) {
        await reportProgress("Updating clients-detail text layers...");
      }
      await updateTemplateLayers(template.id, {
        pages: [
          {
            page: "clients-detail",
            layers: Object.fromEntries(textLayerEntries),
          },
        ],
      });
    }

    for (const [logoKey, logoLayer] of logoLayerEntries) {
      if (reportProgress) {
        await reportProgress(
          `Updating clients-detail image layer ${logoKey}...`,
        );
      }
      await updateTemplateLayers(template.id, {
        pages: [
          {
            page: "clients-detail",
            layers: {
              [logoKey]: logoLayer,
            },
          },
        ],
      });
    }

    const presentationKeys = Object.keys(presentationLayers);
    const clientsDetailKeys = [
      ...textLayerEntries.map(([key]) => key),
      ...logoLayerEntries.map(([key]) => key),
    ];
    const editableUrl = createEditableTemplateUrl(template.id);
    const verificationSummary = [
      `Template ${template.id} updated successfully.`,
      `Presentation layers (${presentationKeys.length}): ${presentationKeys.join(", ")}.`,
      `Clients-detail layers (${clientsDetailKeys.length}): ${clientsDetailKeys.join(", ")}.`,
      `Editable URL: ${editableUrl}`,
    ].join(" ");

    console.log(
      `Applied ${presentationKeys.length} presentation layers and ${clientsDetailKeys.length} clients-detail layers.`,
    );
    if (reportProgress) {
      await reportProgress("Template population completed successfully.");
    }

    return {
      username: normalizedUsername,
      folder,
      template,
      editableUrl,
      verificationSummary,
      selectedClients,
      uploadedLogos: uploadedClients.map((client) => ({
        slug: client.slug,
        displayName: client.displayName,
        logoFilePath: client.logoFilePath,
        logoUrl: client.logoUrl,
      })),
      appliedLayers: {
        presentation: presentationKeys,
        clientsDetail: clientsDetailKeys,
      },
    };
  } catch (error) {
    console.error("Template clone and populate workflow failed.");

    if (folder?.id) {
      console.error(`Folder created before failure: ${folder.id}`);
    }

    if (template?.id) {
      console.error(`Template duplicated before failure: ${template.id}`);
    }

    throw error;
  }
}

export async function previewProposalClients(
  options: ClientSelectionOptions = {},
): Promise<ProposalClientPreview> {
  const selected = await selectProposalClients(options);
  return {
    selectedClients: selected.map((client) => ({
      slug: client.slug,
      name: client.displayName,
      sector: client.primarySector,
      category: client.category,
    })),
  };
}
