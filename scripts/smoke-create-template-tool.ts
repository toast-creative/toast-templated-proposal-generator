import { runTool } from "../harness/tools";

async function main(): Promise<void> {
  const username = process.argv[2]?.trim();
  const templateName = process.argv[3]?.trim();

  if (!username || !templateName) {
    console.error(
      "Usage: npm run smoke:create-template-tool -- <username> <templateName>",
    );
    process.exit(1);
  }

  console.log(
    `Running createTemplateForUser for username: ${username} and templateName: ${templateName}`,
  );

  const result = await runTool("createTemplateForUser", {
    username,
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
