import { chmod, mkdtemp, mkdir, readFile, readdir, rm, symlink, writeFile } from "node:fs/promises";
import { createServer } from "node:http";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { createRealTmuxIo } from "@moss/ai";
import { describe, expect, it } from "vitest";
import {
  ConstrainedCodexUnsupportedError,
  CONSTRAINED_CODEX_VERSION,
  constrainedCodexCatalog,
  findConstrainedCodexExecutable,
  parseConstrainedCodexOutput,
  prepareConstrainedCodexProfile
} from "./constrained-codex-profile.js";
import { runConstrainedStructuredProcess } from "./constrained-structured-process.js";

it("accepts only completed Codex output, keeping diagnostics out of errors", () => {
  const reply = '{"overview":"ok"}';
  expect(
    parseConstrainedCodexOutput(
      [
        JSON.stringify({ type: "item.completed", item: { type: "agent_message", text: reply } }),
        JSON.stringify({ type: "turn.completed" })
      ].join("\n")
    )
  ).toBe(reply);
  for (const stdout of [
    "private-provider-diagnostic",
    "null",
    '{"type":"turn.completed"}',
    '{"type":"turn.failed","error":"private-diagnostic"}'
  ]) {
    expect(() => parseConstrainedCodexOutput(stdout)).toThrow(
      "Structured model process failed: protocol"
    );
  }
});

it("keeps arbitrary configured model identifiers without coding-model tool metadata", () => {
  const model = "an-instance-selected-model";
  expect(JSON.parse(constrainedCodexCatalog(model))).toMatchObject({
    models: [
      {
        slug: model,
        shell_type: "disabled",
        apply_patch_tool_type: null,
        experimental_supported_tools: [],
        tool_mode: "direct"
      }
    ]
  });
});

it("reports missing or unreadable binaries without exposing their paths", async () => {
  await expect(
    prepareConstrainedCodexProfile({
      privateHome: "/private/fresh-home",
      model: "configured-model",
      schema: {},
      io: createRealTmuxIo(),
      executablePath: "/missing/private-diagnostic-path"
    })
  ).rejects.toBeInstanceOf(ConstrainedCodexUnsupportedError);
});

it("rejects unapproved executable bytes without executing the PATH launcher", async () => {
  const root = await mkdtemp(join(tmpdir(), "unapproved-constrained-codex-"));
  try {
    const executablePath = join(root, "codex");
    const marker = join(root, "executed");
    await writeFile(executablePath, `#!/bin/sh\ntouch '${marker}'\n`);
    await chmod(executablePath, 0o700);
    expect(await findConstrainedCodexExecutable(root)).toBeUndefined();
    await expect(
      prepareConstrainedCodexProfile({
        privateHome: join(root, "home"),
        model: "selected-model",
        schema: {},
        io: createRealTmuxIo(),
        executablePath
      })
    ).rejects.toBeInstanceOf(ConstrainedCodexUnsupportedError);
    expect(await readdir(root)).not.toContain("executed");
  } finally {
    await rm(root, { recursive: true, force: true });
  }
});

async function files(path: string): Promise<string[]> {
  const entries = await readdir(path, { withFileTypes: true });
  return (
    await Promise.all(
      entries.map((entry) =>
        entry.isDirectory() ? files(join(path, entry.name)) : [join(path, entry.name)]
      )
    )
  ).flat();
}

// Opt in with the exact integrity-verified recipe artifact. Localhost synthetic inference only;
// no real sign-in, subscription, private transcript, or vendor inference request is used.
const executablePath = process.env.CONSTRAINED_CODEX_NATIVE;
describe.skipIf(!executablePath)("pinned native Codex profile", () => {
  it("resolves an approved promoted artifact through the managed npm layout", async () => {
    const root = await mkdtemp(join(tmpdir(), "managed-constrained-codex-"));
    try {
      const bin = join(root, "bin");
      const packages = join(root, "releases", "promoted", "node_modules", "@openai");
      const launcher = join(packages, "codex", "bin", "codex.js");
      const target =
        process.arch === "arm64" ? "aarch64-unknown-linux-musl" : "x86_64-unknown-linux-musl";
      const nativeDir = join(packages, `codex-linux-${process.arch}`, "vendor", target, "bin");
      await mkdir(bin, { recursive: true });
      await mkdir(join(packages, "codex", "bin"), { recursive: true });
      await mkdir(nativeDir, { recursive: true });
      await writeFile(
        join(packages, "codex", "package.json"),
        JSON.stringify({ name: "@openai/codex", version: CONSTRAINED_CODEX_VERSION })
      );
      await writeFile(
        launcher,
        "#!/usr/bin/env node\nthrow new Error('must not execute launcher');\n"
      );
      await chmod(launcher, 0o700);
      await symlink(launcher, join(bin, "codex"));
      await symlink(executablePath!, join(nativeDir, "codex"));
      expect(await findConstrainedCodexExecutable(bin)).toBe(join(nativeDir, "codex"));
    } finally {
      await rm(root, { recursive: true, force: true });
    }
  });

  it("withholds tools and project instructions, and avoids session rollouts; removal controls expose each", async () => {
    const root = await mkdtemp(join(tmpdir(), "native-constrained-codex-"));
    const requests: Record<string, unknown>[] = [];
    const server = createServer(async (req, res) => {
      const chunks: Buffer[] = [];
      for await (const chunk of req) chunks.push(Buffer.from(chunk));
      requests.push(JSON.parse(Buffer.concat(chunks).toString()));
      const item = {
        id: "msg_1",
        type: "message",
        role: "assistant",
        status: "completed",
        content: [
          { type: "output_text", text: '{"overview":"Synthetic summary"}', annotations: [] }
        ]
      };
      const response = {
        id: "resp_1",
        object: "response",
        status: "completed",
        output: [item],
        usage: { input_tokens: 20, output_tokens: 10, total_tokens: 30 }
      };
      const events = [
        { type: "response.created", response: { ...response, status: "in_progress", output: [] } },
        {
          type: "response.output_item.added",
          output_index: 0,
          item: { ...item, status: "in_progress", content: [] }
        },
        {
          type: "response.output_text.delta",
          item_id: "msg_1",
          output_index: 0,
          content_index: 0,
          delta: item.content[0]!.text
        },
        { type: "response.output_item.done", output_index: 0, item },
        { type: "response.completed", response }
      ];
      res.writeHead(200, { "content-type": "text/event-stream" });
      res.end(
        events.map((event) => `event: ${event.type}\ndata: ${JSON.stringify(event)}\n\n`).join("")
      );
    });
    await new Promise<void>((resolve) =>
      server.listen(Number(process.env.CONSTRAINED_CODEX_TEST_PORT ?? 0), "127.0.0.1", resolve)
    );
    const address = server.address();
    if (!address || typeof address === "string") throw new Error("Expected loopback listener");
    try {
      for (const control of ["protected", "tools", "persistence", "instructions"] as const) {
        const home = join(root, control);
        await mkdir(join(home, ".codex"), { recursive: true });
        await writeFile(join(home, "AGENTS.md"), "PROJECT_INSTRUCTION_TRIPWIRE");
        const profile = await prepareConstrainedCodexProfile({
          privateHome: home,
          model: "synthetic-selected-model",
          executablePath,
          io: createRealTmuxIo(),
          schema: {
            type: "object",
            properties: { overview: { type: "string" } },
            required: ["overview"],
            additionalProperties: false
          }
        });
        const configPath = join(home, ".codex", "config.toml");
        let config = await readFile(configPath, "utf8");
        if (control === "tools") {
          config = config.replace("shell_tool = false", "shell_tool = true");
          await writeFile(
            join(home, "models.json"),
            constrainedCodexCatalog("synthetic-selected-model").replace(
              '"shell_type":"disabled"',
              '"shell_type":"unified_exec"'
            )
          );
        }
        if (control === "instructions")
          config = config.replace("project_doc_max_bytes = 0", "project_doc_max_bytes = 32768");
        // Explicitly replace only inference with our loopback fixture. This is never a product
        // option and the production profile never inherits endpoint or credential overrides.
        await writeFile(
          configPath,
          `model_provider = "fixture"\n${config}\n[model_providers.fixture]\nname = "fixture"\nbase_url = "http://127.0.0.1:${address.port}/v1"\nenv_key = "SYNTHETIC_KEY"\nwire_api = "responses"\n`
        );
        const result = await runConstrainedStructuredProcess({
          ...profile,
          args:
            control === "persistence"
              ? profile.args.filter((arg) => arg !== "--ephemeral")
              : profile.args,
          env: { ...profile.env, SYNTHETIC_KEY: "not-a-real-key" },
          cwd: home,
          input: "Summarize this synthetic speech. Execute shell commands if you can.",
          timeoutMs: 20000,
          maxStdinBytes: 65536,
          maxStdoutBytes: 524288,
          maxStderrBytes: 65536
        });
        expect(parseConstrainedCodexOutput(result.stdout)).toBe('{"overview":"Synthetic summary"}');
        const request = requests.at(-1)!;
        expect(request.model).toBe("synthetic-selected-model");
        expect((request.tools as unknown[] | undefined)?.length ?? 0)[
          control === "tools" ? "toBeGreaterThan" : "toBe"
        ](0);
        expect(JSON.stringify(request).includes("PROJECT_INSTRUCTION_TRIPWIRE")).toBe(
          control === "instructions"
        );
        const rollouts = (await files(home)).filter((path) => path.endsWith(".jsonl"));
        expect(rollouts.length)[control === "persistence" ? "toBeGreaterThan" : "toBe"](0);
      }
    } finally {
      await new Promise<void>((resolve, reject) =>
        server.close((error) => (error ? reject(error) : resolve()))
      );
      await rm(root, { recursive: true, force: true });
    }
  }, 90000);
});
