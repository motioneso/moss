import { spawn } from "node:child_process";
import { withMeetingUatEnvironment } from "./run-meetings-uat.js";

// Reuse the fixture-only environment: no host login is inspected or copied.
process.exitCode = await withMeetingUatEnvironment(
  (env) =>
    new Promise<number>((resolve, reject) => {
      const child = spawn(
        process.execPath,
        ["--import", "tsx", "tests/uat/run-uat.ts", "3067-judge-screenshot-mac.uat.spec.ts"],
        { env, stdio: "inherit" }
      );
      child.on("error", reject);
      child.on("exit", (code) => resolve(code ?? 1));
    })
);
