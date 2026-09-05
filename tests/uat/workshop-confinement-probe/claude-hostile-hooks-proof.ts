// Stream the bundle into Moss as documented in README. Never execute returned source.
import assert from "node:assert/strict";
import { spawn } from "node:child_process";
import { access, mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { setTimeout as delay } from "node:timers/promises";

import {
  createClaudeSourceLaunch,
  SOURCE_CLI_OUTPUT_BYTES,
  SOURCE_CLI_TIMEOUT_MS
} from "../../../packages/chat/src/live/claude-source-policy.js";

const model = process.env.WORKSHOP_PROOF_MODEL;
assert.ok(model && model !== "default", "Supply the previously selected concrete model");
const root = await mkdtemp(join(tmpdir(), "workshop-hostile-hooks-"));
process.env.TMPDIR = root;
process.env.JARVIS_CLI_TOOLS_PREFIX = "/data/cli-tools";
const marker = join(root, "hook-ran");
const hook = join(root, "hook.cjs");
const credential = "/data/cli-auth/.jarvis/cli-tokens/anthropic";
const schema = {
  type: "object",
  properties: { word: { const: "quasar" } },
  required: ["word"],
  additionalProperties: false
};
let stage = "setup";
try {
  // The only hostile action is a synthetic marker write inside this proof's private root.
  await writeFile(hook, `require('node:fs').writeFileSync(${JSON.stringify(marker)}, 'ran');\n`);
  for (const control of [true, false]) {
    stage = control ? "hook-enabled-control" : "source-policy-hook-suppression";
    const launch = await createClaudeSourceLaunch({ model, schema }, credential);
    let child: ReturnType<typeof spawn> | undefined;
    let closed: Promise<number | null> | undefined;
    let timer: ReturnType<typeof setTimeout> | undefined;
    const kill = () => {
      if (!child?.pid) return;
      try {
        process.kill(-child.pid, "SIGKILL");
      } catch (error) {
        if ((error as NodeJS.ErrnoException).code !== "ESRCH") throw error;
      }
    };
    try {
      await writeFile(
        join(launch.env.CLAUDE_CONFIG_DIR, "settings.json"),
        JSON.stringify({
          hooks: {
            SessionStart: [{ hooks: [{ type: "command", command: `${process.execPath} ${hook}` }] }]
          }
        })
      );
      const args = [...launch.args];
      if (control) {
        // Deliberately relax only the two hook controls to prove this installed CLI loads it.
        args[args.indexOf("--setting-sources") + 1] = "user";
        args[args.indexOf("--settings") + 1] = JSON.stringify({
          disableAllHooks: false,
          autoMemoryEnabled: false
        });
      }
      child = spawn(launch.executable, args, {
        cwd: launch.cwd,
        env: launch.env,
        detached: true,
        stdio: ["pipe", "pipe", "pipe"]
      });
      let bytes = 0;
      let failed = false;
      let exited = false;
      const output: Buffer[] = [];
      const fail = () => {
        failed = true;
        kill();
      };
      child.once("error", fail);
      child.stdin!.on("error", fail);
      for (const stream of [child.stdout!, child.stderr!]) {
        stream.on("data", (chunk: Buffer) => {
          bytes += chunk.length;
          if (bytes > SOURCE_CLI_OUTPUT_BYTES) fail();
          else if (stream === child!.stdout) output.push(chunk);
        });
      }
      closed = new Promise((resolve) => {
        child!.once("close", (code) => {
          exited = true;
          resolve(code);
        });
      });
      timer = setTimeout(fail, control ? 20_000 : SOURCE_CLI_TIMEOUT_MS);
      child.stdin!.end(
        JSON.stringify({
          type: "user",
          message: { role: "user", content: "Return the word quasar. Use no tools." }
        }) + "\n"
      );
      if (control) {
        while (
          !exited &&
          !(await access(marker).then(
            () => true,
            () => false
          ))
        )
          await delay(50);
        assert.equal(await readFile(marker, "utf8"), "ran");
        kill();
        await closed;
        assert.equal(failed, false);
      } else {
        assert.equal(await closed, 0);
        assert.equal(failed, false);
        assert.deepEqual(JSON.parse(launch.readResult(Buffer.concat(output).toString("utf8"))), {
          word: "quasar"
        });
        await assert.rejects(access(marker));
      }
    } finally {
      if (timer) clearTimeout(timer);
      kill();
      await closed;
      await launch.dispose();
    }
    await assert.rejects(access(launch.cwd));
    if (control) await rm(marker);
    console.log(JSON.stringify({ check: stage, status: "pass", model, privateHomeRemoved: true }));
  }
} catch {
  // Never publish raw provider output, credentials, or errors containing either.
  console.error(JSON.stringify({ check: "claude-hostile-hooks", status: "fail", stage }));
  process.exitCode = 1;
} finally {
  await rm(root, { recursive: true, force: true });
  await assert.rejects(access(root));
  console.log(JSON.stringify({ check: "claude-hostile-hooks-cleanup", status: "pass" }));
}
