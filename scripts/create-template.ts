import {
  TEMPLATED_API_BASE_URL,
  TEMPLATED_API_KEY,
  TEMPLATED_COOKIE,
  TEMPLATED_MAIN_TEMPLATE_ID,
} from "../server/env";

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

  const response = await fetch(`${TEMPLATED_API_BASE_URL}${path}`, {
    ...options,
    headers: {
      Authorization: `Bearer ${TEMPLATED_API_KEY}`,
      ...(TEMPLATED_COOKIE ? { Cookie: TEMPLATED_COOKIE } : {}),
      ...options.headers,
    },
  });

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

function normalizeFolderName(folderName: string): string {
  return folderName.trim().toLowerCase();
}

function extractFolders(payload: unknown): TemplatedFolder[] {
  if (Array.isArray(payload)) {
    return payload.filter(
      (entry): entry is TemplatedFolder =>
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
      return candidate.filter(
        (entry): entry is TemplatedFolder =>
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
      (folder): folder is TemplatedFolder => Boolean(folder && typeof folder === "object"),
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
