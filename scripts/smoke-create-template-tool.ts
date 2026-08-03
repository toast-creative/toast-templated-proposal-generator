import { runTool } from "../harness/tools";

async function main(): Promise<void> {
  const modeArg = process.argv[2]?.trim();
  const mode = modeArg === "populate" ? "populate" : "clone";
  const offset = mode === "populate" ? 1 : 0;
  const username = process.argv[2]?.trim();
  const templateName = process.argv[3 + offset]?.trim();

  const resolvedUsername =
    mode === "populate" ? process.argv[3]?.trim() : username;

  if (!resolvedUsername || !templateName) {
    console.error(
      "Usage:\n  npm run smoke:create-template-tool -- <username> <templateName>\n  npm run smoke:create-template-tool -- populate <username> <templateName>",
    );
    process.exit(1);
  }

  const toolName =
    mode === "populate"
      ? "createAndPopulateTemplateForUser"
      : "createTemplateForUser";

  console.log(
    `Running ${toolName} for username: ${resolvedUsername} and templateName: ${templateName}`,
  );

  const result = await runTool(toolName, {
    username: resolvedUsername,
    templateName,
  });

  console.log("Tool result:");
  console.log(JSON.stringify(result, null, 2));
}

main().catch((error) => {
  console.error("Smoke test failed.");

  if (error instanceof Error) {
    console.error(error.message);
  } else {
    console.error(String(error));
  }

  process.exit(1);
});
