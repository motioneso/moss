import { mkdtemp, mkdir, rm, access } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, describe, expect, it, vi } from "vitest";
import {
  CONSTRAINED_CLAUDE_TIMEOUT_MS,
  createDbModelActivityRecorder,
  installModelActivityRecorder,
  type ModelActivityEntry,
  type TmuxIo
} from "@moss/ai";
import { createConstrainedCliStructuredAdapterFactory } from "./constrained-structured-adapter.js";
import { ConstrainedStructuredEngine } from "./constrained-structured-engine.js";
import { prepareConstrainedClaudeProfile } from "./constrained-claude-profile.js";
import type * as ProfileModule from "./constrained-claude-profile.js";

// Only replace provider discovery/preparation. Adapter, engine, parser, child lifecycle and recorder
// run unchanged; the executable is a synthetic Node program with no network or real credentials.
vi.mock("./constrained-claude-profile.js", async (original) => ({
  ...(await original<typeof ProfileModule>()),
  findConstrainedClaudeExecutable: async () => process.execPath,
  prepareConstrainedClaudeProfile: vi.fn()
}));
const PROMPT = "private-synthetic-meeting-transcript";
const TOKEN = "synthetic-oauth-canary";
let dir: string | undefined;
afterEach(async () => {
  installModelActivityRecorder(null);
  vi.restoreAllMocks();
  vi.clearAllMocks();
  if (dir) await rm(dir, { recursive: true, force: true });
  dir = undefined;
});

describe("constrained adapter real-child activity recording", () => {
  it.each([
    "ok",
    "error",
    "aborted",
    "timeout",
    "launch-aborted",
    "launch-rejected",
    "launch-timeout",
    "launch-timeout-rejected"
  ] as const)(
    "records exactly one owner-bound %s row without child content or credentials",
    async (scenario) => {
      const duringLaunch = scenario.startsWith("launch-");
      const timedOut = scenario.includes("timeout");
      const outcome = timedOut ? "error" : duringLaunch ? "aborted" : scenario;
      dir = await mkdtemp(join(tmpdir(), "constrained-activity-"));
      const cwd = dir;
      const ready = join(cwd, "ready");
      const controller = new AbortController();
      const deadline = new AbortController();
      const originalTimeout = AbortSignal.timeout;
      vi.spyOn(AbortSignal, "timeout").mockImplementation((ms) =>
        ms === CONSTRAINED_CLAUDE_TIMEOUT_MS ? deadline.signal : originalTimeout(ms)
      );
      const expire = () => deadline.abort(new DOMException("Timed out", "TimeoutError"));
      const logs = ["log", "info", "warn", "error", "debug"] as const;
      const spies = logs.map((level) => vi.spyOn(console, level).mockImplementation(() => {}));
      const rows: ModelActivityEntry[] = [];
      const warn = vi.fn();
      installModelActivityRecorder(
        createDbModelActivityRecorder(
          async (entry) => {
            rows.push(entry);
          },
          { warn }
        )
      );
      const program = `
        let prompt = "";
        process.stdin.setEncoding("utf8");
        process.stdin.on("data", chunk => { prompt += chunk; });
        process.stdin.on("end", () => {
          require("node:fs").writeFileSync(${JSON.stringify(ready)}, "ready");
          process.stderr.write(prompt + process.env.CLAUDE_CODE_OAUTH_TOKEN);
          if (${JSON.stringify(outcome)} === "aborted" || ${timedOut}) { setInterval(() => {}, 1000); return; }
          if (${JSON.stringify(outcome)} === "error") { process.exitCode = 1; return; }
          process.stdout.write(JSON.stringify({ type: "result", subtype: "success", is_error: false,
            structured_output: { overview: "done" } }));
        });
      `;
      vi.mocked(prepareConstrainedClaudeProfile).mockImplementation(async () => {
        if (duringLaunch) {
          if (timedOut) expire();
          else controller.abort();
        }
        if (scenario.endsWith("rejected"))
          throw new Error("Structured model process failed: cancelled");
        return {
          command: process.execPath,
          args: ["-e", program],
          env: { CLAUDE_CODE_OAUTH_TOKEN: TOKEN }
        };
      });
      const release = vi.fn(async () => {});
      const wrap = vi.fn((command: string, args: readonly string[]) => ({
        command,
        args: [...args]
      }));
      const engine = new ConstrainedStructuredEngine(
        "anthropic",
        {
          run: async (_command: string, args: readonly string[]) => {
            await mkdir(args[2]!);
            return { code: 0, stdout: "", stderr: "" };
          }
        } as unknown as TmuxIo,
        cwd,
        {
          env: { CLAUDE_CODE_OAUTH_TOKEN: TOKEN },
          wrap,
          signalGroup: async (pid, signal) => {
            process.kill(-pid, signal);
          },
          release
        }
      );
      // The runner's normal launch wrapper supplies the private neutral directory.
      const launch = engine.launchStructured.bind(engine);
      engine.launchStructured = (opts) => launch({ ...opts, neutralDir: cwd });
      const factory = vi.fn(async () => engine);
      const result = createConstrainedCliStructuredAdapterFactory(factory)(
        "anthropic"
      ).generateStructured({
        actorUserId: "synthetic-owner",
        service: "module.meetings",
        actionCode: "meetings.summary",
        model: { provider_kind: "anthropic", provider_model_id: "chosen-model" },
        schema: { type: "object", properties: { overview: { type: "string" } } },
        messages: [{ role: "user", content: PROMPT }],
        maxOutputTokens: 8192,
        signal: controller.signal
      });
      // Attach rejection handling immediately while waiting for the real child to read stdin.
      const settled = result.then(
        (value) => ({ value }),
        (error) => ({ error })
      );
      try {
        if (!duringLaunch) await vi.waitFor(() => access(ready));
        if (timedOut) expire();
        else if (outcome === "aborted") controller.abort();
        const actual = await settled;
        if (outcome === "ok")
          expect(actual).toEqual({
            value: {
              rawText: '{"overview":"done"}',
              usage: { inputTokens: 0, outputTokens: 0 }
            }
          });
        else expect(actual).toHaveProperty("error");
        expect(wrap).toHaveBeenCalledTimes(duringLaunch ? 0 : 1);
        expect(release).toHaveBeenCalledTimes(1);
        expect(factory).toHaveBeenCalledTimes(1);
        expect(factory).toHaveBeenCalledWith(
          "anthropic",
          expect.stringMatching(/^constrained-/),
          expect.objectContaining({ userId: "synthetic-owner", constrainedStructured: true })
        );
        expect(rows).toHaveLength(1);
        expect(rows[0]).toMatchObject({
          ownerUserId: "synthetic-owner",
          kind: "structured",
          modelName: "chosen-model",
          actionCode: "meetings.summary",
          outcome,
          result: outcome === "ok" ? "completed" : outcome === "aborted" ? "stopped" : "failed"
        });
        if (outcome === "aborted") expect(rows[0]?.failureCode).toBe("cancelled");
        if (timedOut) {
          expect(actual).toHaveProperty("error.code", "timeout");
          expect(rows[0]?.failureCode).toBe("timeout");
        }
        const observable = JSON.stringify({
          rows,
          logs: spies.map((spy) => spy.mock.calls),
          warnings: warn.mock.calls
        });
        expect(observable).not.toContain(PROMPT);
        expect(observable).not.toContain(TOKEN);
      } finally {
        controller.abort();
        await engine.kill();
        await settled;
      }
    }
  );
});
