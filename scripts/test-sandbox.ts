import { runInSandbox, type SandboxApi } from "../harness/sandbox";

// Demonstrates the sandbox guardrails directly, without needing the agent to
// misbehave. Run: npx tsx scripts/test-sandbox.ts
const api: SandboxApi = {};

const show = (label: string, r: unknown) => console.log(`\n${label}\n`, JSON.stringify(r));

// 1. Code Mode: run a plain computation and return the result.
show(
  "1) code mode (compute a result):",
  await runInSandbox(
    `const nums = [3, 1, 4, 1, 5, 9, 2, 6];
     const total = nums.reduce((a, b) => a + b, 0);
     return { total, max: Math.max(...nums) };`,
    api,
  ),
);

// 2. A runaway sync loop is killed by the timeout.
show("2) infinite loop (killed by timeout):", await runInSandbox(`while (true) {}`, api, { timeoutMs: 800 }));

// 3. No access to the host: require/fs/process are simply not there.
show("3) require('fs') (blocked):", await runInSandbox(`return require("fs").readdirSync(".")`, api));

// 4. Errors come back structured, so the model can read them and self-correct.
show("4) a bug (structured error):", await runInSandbox(`return totallyUndefined.value`, api));

process.exit(0);
