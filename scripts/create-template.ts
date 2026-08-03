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
    layers: Record<string, Record<string, unknown>>;
  }>;
}

interface TemplatedPageSnapshot {
  page: string;
  hide?: unknown;
  width?: number;
  height?: number;
  layers?: Record<string, unknown>;
  [key: string]: unknown;
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
  tagline?: string;
  thumbnail?: string;
  images?: MetadataImage[];
  sectors?: string[];
  services?: string[];
  description?: string;
}

interface MetadataImage {
  url?: string;
  width?: number | null;
  height?: number | null;
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

interface StoryClientEntry extends ProposalClientEntry {
  tagline: string;
  services: string[];
  thumbnailUrl: string | null;
  usableImages: Array<{
    url: string;
    width: number;
    height: number;
  }>;
}

interface StoryPagePopulateOptions extends ClientSelectionOptions {
  maxCompanies?: number;
}

export interface StoryPagePopulateResult {
  templateId: string;
  selectedClients: Array<{
    slug: string;
    name: string;
    tagline: string;
    services: string[];
  }>;
  storiesCreated: number;
  pagesCreated: number;
  generatedPages: string[];
  descriptionPages: string[];
  masonryPages: string[];
  fullPages: string[];
  summary: string;
  editableUrl: string;
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
const STORY_COMPANIES_COUNT = 6;
// Masonry/full image frame sizes are no longer hardcoded: each blueprint's image
// slots (name + width/height) are read straight from its snapshot via
// deriveImageSlots(). This keeps the workflow correct through layer renames and
// per-frame resizes in the master (masonry-a = 4 slots, masonry-b = 6 slots).
const STORY_DESCRIPTION_LOGO_WIDTH = 936;
const STORY_DESCRIPTION_LOGO_HEIGHT = 854;
const STORY_DESCRIPTION_BLUEPRINT_CANDIDATES = [
  "clients-story-description",
  "clients-story-description-01",
];
const STORY_MASONRY_A_BLUEPRINT_CANDIDATES = [
  "clients-story-masonry-a",
  "clients-story-masonry-01",
  "clients-story-masonry",
];
const STORY_FULL_BLUEPRINT_CANDIDATES = [
  "clients-story-full",
  "clients-story-full-01",
];
const STORY_MASONRY_B_BLUEPRINT_CANDIDATES = [
  // NOTE: the master template ships this page with a typo ("mansonry"), so the
  // real page name must come first or the masonry-b layout is never used.
  "clients-story-mansonry-b",
  "clients-story-masonry-b",
  "clients-story-mansonry-03",
  "clients-story-masonry-03",
];

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

function slugifyPageSuffix(value: string): string {
  return value
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, "-")
    .replace(/^-+|-+$/g, "")
    .slice(0, 48);
}

function isLikelyImageUrl(url: string): boolean {
  return /\.(png|jpe?g|webp|gif|svg)(\?|$)/i.test(url);
}

function scoreImageFit(
  width: number,
  height: number,
  targetWidth: number,
  targetHeight: number,
): number {
  if (width <= 0 || height <= 0) {
    return Number.NEGATIVE_INFINITY;
  }

  const ratio = width / height;
  const targetRatio = targetWidth / targetHeight;
  const ratioPenalty = Math.abs(ratio - targetRatio) / targetRatio;
  const scaleFactor = Math.min(width / targetWidth, height / targetHeight);
  const upscalePenalty = scaleFactor < 1 ? (1 - scaleFactor) * 2 : 0;
  const resolutionBonus = Math.min(
    0.25,
    Math.log10((width * height) / 100_000),
  );

  return 1 - ratioPenalty - upscalePenalty + resolutionBonus;
}

function normalizeStoryServices(services: string[] | undefined): string[] {
  return (services ?? [])
    .map((service) => service.trim())
    .filter(Boolean)
    .slice(0, 12);
}

function extractUsableImages(project: MetadataProject): Array<{
  url: string;
  width: number;
  height: number;
}> {
  const images = Array.isArray(project.images) ? project.images : [];

  return images
    .filter((image) => Boolean(image?.url && isLikelyImageUrl(image.url)))
    .map((image) => ({
      url: String(image.url),
      width: Number(image.width ?? 0),
      height: Number(image.height ?? 0),
    }))
    .filter((image) => image.width > 0 && image.height > 0);
}

function selectBestUnusedImage(
  images: Array<{ url: string; width: number; height: number }>,
  usedUrls: Set<string>,
  targetWidth: number,
  targetHeight: number,
): { url: string; width: number; height: number } | null {
  const candidates = images
    .filter((image) => !usedUrls.has(image.url))
    .map((image) => ({
      image,
      score: scoreImageFit(
        image.width,
        image.height,
        targetWidth,
        targetHeight,
      ),
    }))
    .filter((entry) => Number.isFinite(entry.score))
    .sort((left, right) => right.score - left.score);

  return candidates[0]?.image ?? null;
}

function chooseStoryLogoUrl(
  client: StoryClientEntry,
  uploadedLogoUrl: string | undefined,
): string | null {
  if (client.thumbnailUrl && isLikelyImageUrl(client.thumbnailUrl)) {
    return client.thumbnailUrl;
  }

  if (client.usableImages[0]?.url) {
    return client.usableImages[0].url;
  }

  return uploadedLogoUrl ?? null;
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

async function selectStoryClients(
  options: StoryPagePopulateOptions,
): Promise<StoryClientEntry[]> {
  const [catalog, proposalSelectedClients] = await Promise.all([
    readMetadataCatalog(),
    selectProposalClients(options),
  ]);
  const { projects } = catalog;
  const projectBySlug = new Map(
    projects
      .filter((project): project is MetadataProject & { slug: string } =>
        Boolean(project.slug?.trim()),
      )
      .map((project) => [project.slug.trim(), project]),
  );

  const maxCompanies =
    typeof options.maxCompanies === "number" && options.maxCompanies > 0
      ? Math.min(options.maxCompanies, 12)
      : STORY_COMPANIES_COUNT;

  const candidates: StoryClientEntry[] = [];

  for (const proposalClient of proposalSelectedClients) {
    const project = projectBySlug.get(proposalClient.slug);
    if (!project) {
      continue;
    }

    const projectName = project.name?.trim() || proposalClient.displayName;
    const logoFilePath = proposalClient.logoFilePath;
    if (!logoFilePath) {
      continue;
    }

    const usableImages = extractUsableImages(project);
    if (usableImages.length === 0) {
      continue;
    }

    candidates.push({
      slug: proposalClient.slug,
      displayName: proposalClient.displayName,
      logoFilePath,
      primarySector: proposalClient.primarySector,
      category: proposalClient.category,
      score: proposalClient.score,
      tagline: project.tagline?.trim() || projectName,
      services: normalizeStoryServices(project.services),
      thumbnailUrl: project.thumbnail?.trim() || null,
      usableImages,
    });
  }

  const selected = candidates.slice(0, maxCompanies);
  if (selected.length < maxCompanies) {
    throw new Error(
      `Could not select ${maxCompanies} story clients with required assets. Selected ${selected.length}.`,
    );
  }

  return selected;
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

async function fetchTemplatePages(
  templateId: string,
): Promise<TemplatedPageSnapshot[]> {
  const fullTemplateResponse = await templatedRequest<unknown>(
    `/template/${encodeURIComponent(templateId)}`,
  );

  const fromFullTemplate =
    fullTemplateResponse &&
    typeof fullTemplateResponse === "object" &&
    Array.isArray((fullTemplateResponse as { pages?: unknown }).pages)
      ? (fullTemplateResponse as { pages: unknown[] }).pages
      : null;

  const pagesCandidate = fromFullTemplate
    ? fromFullTemplate
    : await templatedRequest<unknown>(
        `/template/${encodeURIComponent(templateId)}/pages`,
      );

  if (!Array.isArray(pagesCandidate)) {
    throw new Error(
      `Templated API returned an unexpected pages payload for template ${templateId}.`,
    );
  }

  return pagesCandidate.filter((entry): entry is TemplatedPageSnapshot => {
    return Boolean(
      entry &&
      typeof entry === "object" &&
      typeof (entry as { page?: unknown }).page === "string",
    );
  });
}

function clonePageSnapshot(
  sourcePage: TemplatedPageSnapshot,
  targetPageName: string,
): TemplatedPageSnapshot {
  const clone = JSON.parse(JSON.stringify(sourcePage)) as TemplatedPageSnapshot;
  clone.page = targetPageName;
  return clone;
}

interface ImageSlot {
  layer: string;
  width: number;
  height: number;
}

// Derive the fillable image slots of a masonry/full blueprint straight from its
// snapshot: every image-type layer becomes a slot carrying its real layer name
// (the write target) and its frame's width/height (the best-fit scoring target).
// This means the workflow adapts automatically to layer renames and per-frame
// resizes in the master — masonry-a exposes 4 slots, masonry-b exposes 6 — with
// no hardcoded names or dimensions.
function deriveImageSlots(
  page: TemplatedPageSnapshot | undefined,
): ImageSlot[] {
  const layers = (page?.layers ?? {}) as Record<string, unknown>;
  const slots: ImageSlot[] = [];
  for (const [name, value] of Object.entries(layers)) {
    if (!value || typeof value !== "object") {
      continue;
    }
    const layer = value as Record<string, unknown>;
    if (layer.type !== "image") {
      continue;
    }
    slots.push({
      layer: name,
      width: Number(layer.width) || 0,
      height: Number(layer.height) || 0,
    });
  }
  // Largest frames first so a wide hero banner claims the best-fitting image
  // before the narrower column frames get their pick.
  slots.sort((a, b) => b.width * b.height - a.width * a.height);
  return slots;
}

function buildTextLayerUpdateFromSnapshot(
  pageByName: Map<string, TemplatedPageSnapshot>,
  pageName: string,
  layerName: string,
  text: string,
): Record<string, unknown> {
  const pageSnapshot = pageByName.get(pageName);
  const snapshotLayers = pageSnapshot?.layers;

  const existingLayer =
    snapshotLayers && typeof snapshotLayers === "object"
      ? (snapshotLayers as Record<string, unknown>)[layerName]
      : undefined;

  if (existingLayer && typeof existingLayer === "object") {
    return stripPositionalFields({
      ...(existingLayer as Record<string, unknown>),
      layer: layerName,
      type: "text",
      text,
    });
  }

  return {
    layer: layerName,
    type: "text",
    text,
  };
}

// A partial layer update must NOT carry x/y. Many blueprint layers belong to a
// group (e.g. the 12 story_client_service* layers share one group); on a partial
// `updateTemplateLayers` call Templated re-adds the group's origin to any x/y we
// send, translating the layer off-position on every write. The page snapshot was
// already cloned with faithful absolute coordinates (a full-page PUT preserves
// grouped positions exactly), so we simply omit x/y and let Templated keep the
// stored position. width/height are scale, not translation, so they are safe.
function stripPositionalFields(
  layer: Record<string, unknown>,
): Record<string, unknown> {
  const { x: _x, y: _y, ...rest } = layer;
  void _x;
  void _y;
  return rest;
}

function buildImageLayerUpdateFromSnapshot(
  pageByName: Map<string, TemplatedPageSnapshot>,
  pageName: string,
  layerName: string,
  imageUrl: string,
  options?: { width?: number; height?: number; objectFit?: string },
): Record<string, unknown> {
  const pageSnapshot = pageByName.get(pageName);
  const snapshotLayers = pageSnapshot?.layers;

  const existingLayer =
    snapshotLayers && typeof snapshotLayers === "object"
      ? (snapshotLayers as Record<string, unknown>)[layerName]
      : undefined;

  if (existingLayer && typeof existingLayer === "object") {
    const merged = {
      ...(existingLayer as Record<string, unknown>),
      layer: layerName,
      type: "image",
      image_url: imageUrl,
    } as Record<string, unknown>;

    if (typeof options?.width === "number") {
      merged.width = options.width;
    }

    if (typeof options?.height === "number") {
      merged.height = options.height;
    }

    if (typeof options?.objectFit === "string") {
      merged.object_fit = options.objectFit;
    }

    return stripPositionalFields(merged);
  }

  const fallback: Record<string, unknown> = {
    layer: layerName,
    type: "image",
    image_url: imageUrl,
  };

  if (typeof options?.width === "number") {
    fallback.width = options.width;
  }

  if (typeof options?.height === "number") {
    fallback.height = options.height;
  }

  if (typeof options?.objectFit === "string") {
    fallback.object_fit = options.objectFit;
  }

  return fallback;
}

async function upsertTemplatePageSnapshot(
  templateId: string,
  page: TemplatedPageSnapshot,
): Promise<void> {
  await templatedRequest<unknown>(
    `/template/${encodeURIComponent(templateId)}`,
    {
      method: "PUT",
      headers: {
        "Content-Type": "application/json",
      },
      body: JSON.stringify({
        pages: [page],
      }),
    },
  );
}

async function upsertTemplatePagesSnapshot(
  templateId: string,
  pages: TemplatedPageSnapshot[],
): Promise<void> {
  await templatedRequest<unknown>(
    `/template/${encodeURIComponent(templateId)}`,
    {
      method: "PUT",
      headers: {
        "Content-Type": "application/json",
      },
      body: JSON.stringify({
        pages,
      }),
    },
  );
}

async function reorderPagesBetweenAnchors(
  templateId: string,
  generatedPageNames: string[],
  startAnchorPageName: string,
  endAnchorPageName: string,
  reportProgress?: TemplateProgressReporter,
): Promise<void> {
  // Templated has NO page-reorder API: a template PUT upserts pages by name and
  // keeps them in CREATION order regardless of the order in the payload array.
  // The freshly generated story pages were appended at the very end of the deck,
  // but they must sit between `startAnchorPageName` (clients-story-intro) and
  // `endAnchorPageName` (team-intro).
  //
  // The only mechanism that moves a page is destructive-remove + recreate, which
  // re-appends the recreated page at the end. So we relocate the "tail" — every
  // page from the end anchor onward that is NOT one of the generated pages — by
  // deleting it and recreating it from its full snapshot. Because the generated
  // pages already sit ahead of the tail (they were appended last), recreating the
  // tail after them yields the desired order:
  //   ... startAnchor, [generated pages...], endAnchor, ...rest-of-deck
  const generatedSet = new Set(generatedPageNames.filter(Boolean));
  if (generatedSet.size === 0) {
    return;
  }

  const pages = await fetchTemplatePages(templateId);
  const orderedNames = pages.map((page) => page.page);
  const startAnchorIndex = orderedNames.indexOf(startAnchorPageName);
  const endAnchorIndex = orderedNames.indexOf(endAnchorPageName);

  if (startAnchorIndex < 0 || endAnchorIndex < 0) {
    throw new Error(
      `Cannot position story pages: required anchors "${startAnchorPageName}" and/or "${endAnchorPageName}" were not found in template ${templateId}.`,
    );
  }

  // Already correct? The generated pages should be a contiguous block directly
  // between the two anchors.
  const between = orderedNames.slice(startAnchorIndex + 1, endAnchorIndex);
  const alreadyPlaced =
    between.length === generatedSet.size &&
    between.every((name) => generatedSet.has(name));
  if (alreadyPlaced) {
    return;
  }

  // The tail is the end anchor and everything after it, minus any generated
  // pages that (on a re-run) may already be interleaved there.
  const tailPages = pages
    .slice(endAnchorIndex)
    .filter((page) => !generatedSet.has(page.page));

  if (tailPages.length === 0) {
    return;
  }

  // Safety: never destroy a page whose snapshot came back without layers — we
  // could not faithfully recreate it, so abort rather than lose real content.
  const emptyTail = tailPages.filter(
    (page) =>
      !page.layers ||
      typeof page.layers !== "object" ||
      Object.keys(page.layers).length === 0,
  );
  if (emptyTail.length > 0) {
    throw new Error(
      `Aborting page reorder to avoid data loss: ${emptyTail
        .map((page) => page.page)
        .join(", ")} returned no layers from template ${templateId}.`,
    );
  }

  const tailNames = tailPages.map((page) => page.page);

  if (reportProgress) {
    await reportProgress(
      `Positioning ${generatedSet.size} story pages before ${endAnchorPageName} by relocating ${tailPages.length} trailing pages (${tailNames.join(", ")})...`,
    );
  }

  // Delete the tail (destructive), then recreate each page from its snapshot in
  // original order so they re-append sequentially after the generated block.
  await hideTemplatePages(templateId, tailNames, reportProgress);

  for (const page of tailPages) {
    const recreated = clonePageSnapshot(page, page.page);
    recreated.hide = false;
    await upsertTemplatePageSnapshot(templateId, recreated);
  }

  // Verify none of the relocated pages were lost during recreation.
  const pagesAfter = await fetchTemplatePages(templateId);
  const namesAfter = new Set(pagesAfter.map((page) => page.page));
  const lost = tailNames.filter((name) => !namesAfter.has(name));
  if (lost.length > 0) {
    throw new Error(
      `Page reorder failed: trailing pages were lost after recreation in template ${templateId}: ${lost.join(", ")}.`,
    );
  }
}

async function removeTemplatePages(
  templateId: string,
  pageNamesToRemove: string[],
  reportProgress?: TemplateProgressReporter,
): Promise<void> {
  const namesToRemove = new Set(pageNamesToRemove.filter(Boolean));
  if (namesToRemove.size === 0) {
    return;
  }

  const pages = await fetchTemplatePages(templateId);
  const filteredPages = pages.filter((page) => !namesToRemove.has(page.page));

  if (filteredPages.length === pages.length) {
    return;
  }

  if (reportProgress) {
    await reportProgress(
      `Removing original story blueprint pages: ${[...namesToRemove].join(", ")}...`,
    );
  }

  await upsertTemplatePagesSnapshot(templateId, filteredPages);
}

async function hideTemplatePages(
  templateId: string,
  pageNamesToHide: string[],
  reportProgress?: TemplateProgressReporter,
): Promise<void> {
  const namesToHide = [...new Set(pageNamesToHide.filter(Boolean))];
  if (namesToHide.length === 0) {
    return;
  }

  const pages = await fetchTemplatePages(templateId);
  const pageByName = new Map(pages.map((page) => [page.page, page]));

  if (reportProgress) {
    await reportProgress(
      `Hiding original story blueprint pages: ${namesToHide.join(", ")}...`,
    );
  }

  for (const pageName of namesToHide) {
    const existing = pageByName.get(pageName);
    if (!existing) {
      continue;
    }

    const updated = clonePageSnapshot(existing, pageName);
    updated.hide = true;
    await upsertTemplatePageSnapshot(templateId, updated);
  }
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
    const templatePages = await fetchTemplatePages(template.id);
    const pageByName = new Map(templatePages.map((page) => [page.page, page]));
    const presentationPage = payload.pages.find(
      (page) => page.page === "presentation",
    );
    const clientsDetailPage = payload.pages.find(
      (page) => page.page === "clients-detail",
    );

    const presentationLayers = presentationPage?.layers ?? {};
    const clientsLayers = clientsDetailPage?.layers ?? {};

    const presentationLayerEntries = Object.entries(presentationLayers).map(
      ([layerKey, layerValue]) => {
        const text =
          layerValue && typeof layerValue === "object"
            ? (layerValue as Record<string, unknown>).text
            : undefined;
        return [
          layerKey,
          buildTextLayerUpdateFromSnapshot(
            pageByName,
            "presentation",
            layerKey,
            typeof text === "string" ? text : "",
          ),
        ] as const;
      },
    );
    const normalizedPresentationLayers = Object.fromEntries(
      presentationLayerEntries,
    );

    const textLayerEntries = Object.entries(clientsLayers).filter(([key]) =>
      /^col[12]_client\d+$/i.test(key),
    );
    const normalizedTextLayers = Object.fromEntries(
      textLayerEntries.map(([layerKey, layerValue]) => {
        const text =
          layerValue && typeof layerValue === "object"
            ? (layerValue as Record<string, unknown>).text
            : undefined;
        return [
          layerKey,
          buildTextLayerUpdateFromSnapshot(
            pageByName,
            "clients-detail",
            layerKey,
            typeof text === "string" ? text : "",
          ),
        ] as const;
      }),
    );

    const logoLayerEntries = Object.entries(clientsLayers).filter(([key]) =>
      /^col[1-4]_logo[1-5]$/i.test(key),
    );
    const normalizedLogoLayers = Object.fromEntries(
      logoLayerEntries.map(([layerKey, layerValue]) => {
        const imageUrl =
          layerValue && typeof layerValue === "object"
            ? (layerValue as Record<string, unknown>).image_url
            : undefined;
        return [
          layerKey,
          buildImageLayerUpdateFromSnapshot(
            pageByName,
            "clients-detail",
            layerKey,
            typeof imageUrl === "string" ? imageUrl : "",
            {
              width: LOGO_WIDTH,
              height: LOGO_HEIGHT,
            },
          ),
        ] as const;
      }),
    );

    if (Object.keys(normalizedPresentationLayers).length > 0) {
      if (reportProgress) {
        await reportProgress("Updating presentation page layers...");
      }
      await updateTemplateLayers(template.id, {
        pages: [
          {
            page: "presentation",
            layers: normalizedPresentationLayers,
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
            layers: normalizedTextLayers,
          },
        ],
      });
    }

    for (const [logoKey] of logoLayerEntries) {
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
              [logoKey]: normalizedLogoLayers[logoKey],
            },
          },
        ],
      });
    }

    const presentationKeys = Object.keys(normalizedPresentationLayers);
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

export async function populateClientStoryPages(
  templateId: string,
  options: StoryPagePopulateOptions = {},
  reportProgress?: TemplateProgressReporter,
): Promise<StoryPagePopulateResult> {
  const normalizedTemplateId = templateId.trim();
  if (!normalizedTemplateId) {
    throw new Error("templateId is required to populate story pages.");
  }

  const selectedClients = await selectStoryClients(options);
  if (reportProgress) {
    await reportProgress(
      `Selected ${selectedClients.length} story clients. Uploading logo fallbacks...`,
    );
  }

  const uploadedLogos = await uploadClientLogos(
    selectedClients,
    reportProgress,
  );
  const uploadedLogoBySlug = new Map(
    uploadedLogos.map((client) => [client.slug, client.logoUrl]),
  );

  const templatePages = await fetchTemplatePages(normalizedTemplateId);
  const pageByName = new Map(templatePages.map((page) => [page.page, page]));
  const existingPageNames = new Set(pageByName.keys());

  const resolveBlueprintPage = (candidates: string[]): string => {
    const match = candidates.find((name) => existingPageNames.has(name));
    if (!match) {
      throw new Error(
        `Template ${normalizedTemplateId} is missing required blueprint page. Expected one of: ${candidates.join(", ")}.`,
      );
    }
    return match;
  };

  const resolveOptionalBlueprintPage = (
    candidates: string[],
  ): string | null => {
    return candidates.find((name) => existingPageNames.has(name)) ?? null;
  };

  const descriptionBlueprintPage = resolveBlueprintPage(
    STORY_DESCRIPTION_BLUEPRINT_CANDIDATES,
  );
  const masonryABlueprintPage = resolveBlueprintPage(
    STORY_MASONRY_A_BLUEPRINT_CANDIDATES,
  );
  const fullBlueprintPage = resolveBlueprintPage(
    STORY_FULL_BLUEPRINT_CANDIDATES,
  );
  const masonryBBlueprintPage =
    resolveOptionalBlueprintPage(STORY_MASONRY_B_BLUEPRINT_CANDIDATES) ??
    masonryABlueprintPage;

  if (masonryBBlueprintPage === masonryABlueprintPage && reportProgress) {
    await reportProgress(
      "Optional masonry-b blueprint not found; using masonry-a blueprint for all masonry pages.",
    );
  }

  // Read each blueprint's image slots once (names + frame sizes). Blueprints are
  // shared across all clients and never mutated, so this is stable for the run.
  const masonryASlots = deriveImageSlots(pageByName.get(masonryABlueprintPage));
  const masonryBSlots = deriveImageSlots(pageByName.get(masonryBBlueprintPage));
  const fullSlots = deriveImageSlots(pageByName.get(fullBlueprintPage));

  if (reportProgress) {
    await reportProgress(
      `Masonry blueprint slots: A=${masonryASlots.length} (${masonryASlots
        .map((s) => s.layer)
        .join(", ")}), B=${masonryBSlots.length} (${masonryBSlots
        .map((s) => s.layer)
        .join(", ")}).`,
    );
  }

  const ensurePageExists = async (
    targetPageName: string,
    sourcePageName: string,
  ): Promise<void> => {
    if (existingPageNames.has(targetPageName)) {
      return;
    }

    const sourcePage = pageByName.get(sourcePageName);
    if (!sourcePage) {
      throw new Error(
        `Cannot clone story page \"${targetPageName}\" because blueprint page \"${sourcePageName}\" was not found.`,
      );
    }

    if (reportProgress) {
      await reportProgress(
        `Copying story page ${sourcePageName} -> ${targetPageName}...`,
      );
    }

    const clonedPage = clonePageSnapshot(sourcePage, targetPageName);
    await upsertTemplatePageSnapshot(normalizedTemplateId, clonedPage);
    pageByName.set(targetPageName, clonedPage);
    existingPageNames.add(targetPageName);
  };

  const descriptionPages: string[] = [];
  const masonryPages: string[] = [];
  const fullPages: string[] = [];
  const generatedPagesInOrder: string[] = [];
  for (const [clientIndex, client] of selectedClients.entries()) {
    const ordinal = String(clientIndex + 1).padStart(2, "0");
    const suffix = `${ordinal}-${slugifyPageSuffix(client.displayName)}`;

    const descriptionPageName = `clients-story-description-${suffix}`;
    await ensurePageExists(descriptionPageName, descriptionBlueprintPage);

    const descriptionTextLayers: Record<string, Record<string, unknown>> = {
      story_client_name: buildTextLayerUpdateFromSnapshot(
        pageByName,
        descriptionPageName,
        "story_client_name",
        client.displayName,
      ),
      story_client_tagline: buildTextLayerUpdateFromSnapshot(
        pageByName,
        descriptionPageName,
        "story_client_tagline",
        client.tagline,
      ),
    };

    for (let index = 0; index < 12; index += 1) {
      // The master template's 6th service layer is named "story_client_service"
      // (no numeric suffix); every other slot is story_client_service{1..12}.
      const serviceKey =
        index === 5 ? "story_client_service" : `story_client_service${index + 1}`;
      const serviceValue = client.services[index]?.trim();
      // Match the template's existing bullet style ("• Foo") instead of leaving
      // plain text that visually breaks the list alignment.
      const serviceText = serviceValue ? `• ${serviceValue}` : "";
      descriptionTextLayers[serviceKey] = buildTextLayerUpdateFromSnapshot(
        pageByName,
        descriptionPageName,
        serviceKey,
        serviceText,
      );
    }

    if (reportProgress) {
      await reportProgress(
        `Updating description text layers for ${client.displayName}...`,
      );
    }
    await updateTemplateLayers(normalizedTemplateId, {
      pages: [
        {
          page: descriptionPageName,
          layers: descriptionTextLayers,
        },
      ],
    });

    const storyLogoUrl = chooseStoryLogoUrl(
      client,
      uploadedLogoBySlug.get(client.slug),
    );
    if (!storyLogoUrl) {
      throw new Error(
        `Could not determine a story_client_logo source for ${client.displayName}.`,
      );
    }

    if (reportProgress) {
      await reportProgress(
        `Updating description logo layer for ${client.displayName}...`,
      );
    }
    await updateTemplateLayers(normalizedTemplateId, {
      pages: [
        {
          page: descriptionPageName,
          layers: {
            story_client_logo: buildImageLayerUpdateFromSnapshot(
              pageByName,
              descriptionPageName,
              "story_client_logo",
              storyLogoUrl,
              {
                width: STORY_DESCRIPTION_LOGO_WIDTH,
                height: STORY_DESCRIPTION_LOGO_HEIGHT,
                // The blueprint layer ships with object_fit "fill", which
                // stretches the thumbnail to 936x854. "contain" keeps the
                // thumbnail's native aspect ratio inside that fixed box.
                objectFit: "contain",
              },
            ),
          },
        },
      ],
    });
    descriptionPages.push(descriptionPageName);
    generatedPagesInOrder.push(descriptionPageName);

    const usedUrls = new Set<string>();

    const pickBestUnusedImage = (
      targetWidth: number,
      targetHeight: number,
    ): { url: string; width: number; height: number } | null => {
      const selected = selectBestUnusedImage(
        client.usableImages,
        usedUrls,
        targetWidth,
        targetHeight,
      );
      if (selected) {
        usedUrls.add(selected.url);
      }
      return selected;
    };

    const remainingUnusedCount = (): number => {
      return client.usableImages.filter((image) => !usedUrls.has(image.url))
        .length;
    };

    let masonryPageIndex = 1;
    while (true) {
      // Alternate the two masonry layouts for visual variety. Each layout
      // exposes a different number of image slots (a = 4, b = 6), read from the
      // blueprint, so the number of images a page needs is slots.length.
      const useMasonryA = masonryPageIndex % 2 === 1;
      const masonryBlueprint = useMasonryA
        ? masonryABlueprintPage
        : masonryBBlueprintPage;
      const slots = useMasonryA ? masonryASlots : masonryBSlots;

      if (slots.length === 0) {
        break;
      }
      if (remainingUnusedCount() < slots.length) {
        break;
      }

      // Fill the largest frames first (slots are sorted largest-first) so the
      // wide hero banner claims a wide image before the columns.
      const picks: { slot: ImageSlot; url: string }[] = [];
      for (const slot of slots) {
        const image = pickBestUnusedImage(slot.width, slot.height);
        if (!image) {
          break;
        }
        picks.push({ slot, url: image.url });
      }
      if (picks.length < slots.length) {
        break;
      }

      const masonryPageName = `clients-story-masonry-${String(masonryPageIndex).padStart(2, "0")}-${suffix}`;
      await ensurePageExists(masonryPageName, masonryBlueprint);

      if (reportProgress) {
        await reportProgress(
          `Updating masonry page ${masonryPageName} (${slots.length} images) for ${client.displayName}...`,
        );
      }

      const masonryLayers: Record<string, Record<string, unknown>> = {};
      for (const { slot, url } of picks) {
        // No width/height override: keep each frame's designed geometry (the
        // frames vary, e.g. 620x510 / 608x510 / 518x510). object_fit "cover"
        // fills every frame cleanly regardless of the source image ratio.
        masonryLayers[slot.layer] = buildImageLayerUpdateFromSnapshot(
          pageByName,
          masonryPageName,
          slot.layer,
          url,
          { objectFit: "cover" },
        );
      }

      await updateTemplateLayers(normalizedTemplateId, {
        pages: [{ page: masonryPageName, layers: masonryLayers }],
      });

      masonryPages.push(masonryPageName);
      generatedPagesInOrder.push(masonryPageName);
      masonryPageIndex += 1;
    }

    if (masonryPageIndex === 1) {
      throw new Error(
        `Could not select enough images for any masonry page for ${client.displayName}.`,
      );
    }

    // The full-bleed blueprint has a single image slot (its real layer name and
    // size come from the blueprint, so a rename like full_image -> ... just works).
    const fullSlot = fullSlots[0];
    let fullPageIndex = 1;
    while (fullSlot && remainingUnusedCount() > 0) {
      const fullHeroImage = pickBestUnusedImage(fullSlot.width, fullSlot.height);
      if (!fullHeroImage) {
        break;
      }

      const fullPageName = `clients-story-full-${String(fullPageIndex).padStart(2, "0")}-${suffix}`;
      await ensurePageExists(fullPageName, fullBlueprintPage);

      if (reportProgress) {
        await reportProgress(
          `Updating full page ${fullPageName} for ${client.displayName}...`,
        );
      }

      await updateTemplateLayers(normalizedTemplateId, {
        pages: [
          {
            page: fullPageName,
            layers: {
              [fullSlot.layer]: buildImageLayerUpdateFromSnapshot(
                pageByName,
                fullPageName,
                fullSlot.layer,
                fullHeroImage.url,
                { objectFit: "cover" },
              ),
            },
          },
        ],
      });

      fullPages.push(fullPageName);
      generatedPagesInOrder.push(fullPageName);
      fullPageIndex += 1;
    }
  }

  const generatedPages = generatedPagesInOrder;

  // Insert only the freshly generated story pages between the two anchors, in
  // per-client order (each client starts with its description page). Leave
  // clients-detail where it already sits, ahead of clients-story-intro.
  await reorderPagesBetweenAnchors(
    normalizedTemplateId,
    generatedPages,
    "clients-story-intro",
    "team-intro",
    reportProgress,
  );

  const storyBlueprintPagesToRemove = [
    descriptionBlueprintPage,
    masonryABlueprintPage,
    masonryBBlueprintPage,
    fullBlueprintPage,
  ];

  // Templated treats `hide: true` on a template update as a DESTRUCTIVE removal:
  // the page and its layers are deleted from the template HTML. That is exactly
  // the "remove the original blueprint pages once we're done" step the workflow
  // requires. (A PUT that merely omits pages would not delete them, since the
  // template update endpoint upserts by page name.)
  await hideTemplatePages(
    normalizedTemplateId,
    storyBlueprintPagesToRemove,
    reportProgress,
  );

  const pagesAfterPopulation = await fetchTemplatePages(normalizedTemplateId);
  const existingPagesAfterPopulation = new Set(
    pagesAfterPopulation.map((page) => page.page),
  );
  const missingPages = generatedPages.filter(
    (pageName) => !existingPagesAfterPopulation.has(pageName),
  );

  if (missingPages.length > 0) {
    throw new Error(
      `Story page creation verification failed. Missing ${missingPages.length} page(s): ${missingPages.join(
        ", ",
      )}.`,
    );
  }

  const storiesCreated = selectedClients.length;
  const pagesCreated = generatedPages.length;
  const summary = `Created ${storiesCreated} client stories and ${pagesCreated} story pages.`;

  if (reportProgress) {
    await reportProgress(
      `${summary} Verified all created pages exist in the template.`,
    );
  }

  return {
    templateId: normalizedTemplateId,
    selectedClients: selectedClients.map((client) => ({
      slug: client.slug,
      name: client.displayName,
      tagline: client.tagline,
      services: client.services,
    })),
    storiesCreated,
    pagesCreated,
    generatedPages,
    descriptionPages,
    masonryPages,
    fullPages,
    summary,
    editableUrl: createEditableTemplateUrl(normalizedTemplateId),
  };
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
