import { spawn } from "node:child_process";
import { basename } from "node:path";
import { captureFailureEvidence, provisionForUat } from "./provisioner.js";

type ProvisionOptions = NonNullable<Parameters<typeof provisionForUat>[1]>;

export interface ProvisionedStack {
  readonly baseURL: string;
  readonly projectName: string;
}

export function readClaimedWebPort(): number | undefined {
  const raw = process.env.JARVIS_UAT_CLAIMED_WEB_PORT;
  if (raw === undefined || raw === "") return undefined;
  if (!/^\d+$/.test(raw)) {
    throw new Error("JARVIS_UAT_CLAIMED_WEB_PORT must be a decimal TCP port");
  }
  const port = Number(raw);
  if (!Number.isSafeInteger(port) || port < 1 || port > 65_535) {
    throw new Error("JARVIS_UAT_CLAIMED_WEB_PORT must be between 1 and 65535");
  }
  return port;
}

/**
 * Provisions a disposable stack on the claimed web port, runs one Playwright invocation against
 * it, captures failure evidence before teardown, and always tears the stack down.
 */
export async function runPlaywrightOnStack(
  level: Parameters<typeof provisionForUat>[0],
  options: Omit<ProvisionOptions, "claimedWebPort">,
  specPath: string,
  invocation: (stack: ProvisionedStack) => {
    readonly args: readonly string[];
    readonly env: NodeJS.ProcessEnv;
  }
): Promise<number> {
  const claimedWebPort = readClaimedWebPort();
  const { baseURL, projectName, teardown } = await provisionForUat(level, {
    ...(claimedWebPort === undefined ? {} : { claimedWebPort }),
    ...options
  });

  const onSignal = () => {
    void teardown().finally(() => process.exit(1));
  };
  process.on("SIGINT", onSignal);
  process.on("SIGTERM", onSignal);

  try {
    console.log(`[uat] running ${specPath} against ${baseURL} (project ${projectName})`);
    const { args, env } = invocation({ baseURL, projectName });
    const exitCode = await new Promise<number>((resolvePromise) => {
      const child = spawn("npx", ["playwright", "test", ...args], { stdio: "inherit", env });
      child.on("exit", (code) => resolvePromise(code ?? 1));
    });
    if (exitCode !== 0) {
      // #2164: capture app/live-model evidence BEFORE teardown (the `finally` below) removes the
      // container — a spec assertion failure used to go straight to teardown with nothing retained
      // to distinguish "model never called the tool" from "the SSE delivery path dropped it".
      await captureFailureEvidence(
        projectName,
        `spec ${basename(specPath)} failed (exit ${exitCode})`
      );
    }
    return exitCode;
  } finally {
    process.off("SIGINT", onSignal);
    process.off("SIGTERM", onSignal);
    await teardown();
  }
}
