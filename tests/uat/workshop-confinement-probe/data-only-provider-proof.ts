import { createServer, type IncomingMessage, type ServerResponse } from "node:http";
import { mkdir, writeFile } from "node:fs/promises";
import { dirname } from "node:path";
import { randomUUID } from "node:crypto";

import assert from "node:assert/strict";

import { HttpApiAdapter, STRUCTURED_TOOL_NAME, type ProviderKind } from "@moss/ai";

const SOURCE =
  "import { defineModuleWorker } from '@moss/module-sdk/worker';\n\n" +
  "export default defineModuleWorker({\n" +
  "  handlers: {\n" +
  "    'word.read': async () => ({ word: 'quasar' })\n" +
  "  }\n" +
  "});\n";
const KEY = `synthetic-${randomUUID()}`;
const MODEL: Record<ProviderKind, string> = {
  anthropic: "claude-probe",
  "openai-compatible": "openai-probe",
  google: "gemini-probe"
};
const providers: ProviderKind[] = ["anthropic", "openai-compatible", "google"];
const schema = {
  type: "object",
  additionalProperties: false,
  required: ["files"],
  properties: {
    files: {
      type: "array",
      minItems: 1,
      maxItems: 1,
      items: {
        type: "object",
        additionalProperties: false,
        required: ["path", "content"],
        properties: {
          path: { const: "src/worker/index.ts" },
          content: { const: SOURCE }
        }
      }
    }
  }
};
type Artifact = { files: [{ path: "src/worker/index.ts"; content: string }] };

function body(req: IncomingMessage): Promise<string> {
  return new Promise((resolve, reject) => {
    let value = "";
    const timer = setTimeout(() => {
      req.destroy();
      reject(new Error("fixture request timeout"));
    }, 3_000);
    req.setEncoding("utf8");
    req.on("data", (chunk: string) => {
      value += chunk;
      if (Buffer.byteLength(value) > 64 * 1024) {
        clearTimeout(timer);
        req.destroy();
        reject(new Error("fixture body too large"));
      }
    });
    req.on("end", () => {
      clearTimeout(timer);
      resolve(value);
    });
    req.on("error", (error) => {
      clearTimeout(timer);
      reject(error);
    });
  });
}

function send(res: ServerResponse, status: number, value: unknown): void {
  const text = JSON.stringify(value);
  res.writeHead(status, {
    "content-type": "application/json",
    "content-length": Buffer.byteLength(text)
  });
  res.end(text);
}

async function main(outputPath: string): Promise<void> {
  if (!outputPath) throw new Error("usage: data-only-provider-proof.ts <outputPath>");
  const artifact: Artifact = { files: [{ path: "src/worker/index.ts", content: SOURCE }] };
  assert.throws(() =>
    assert.deepEqual({ files: [{ path: "../escape.ts", content: SOURCE }] }, artifact)
  );
  assert.throws(() => assert.deepEqual({ ...artifact, apiKey: KEY }, artifact));
  let validatedArtifact: unknown;

  let requests = 0;
  let serverFailure: Error | undefined;
  const server = createServer(async (req, res) => {
    try {
      const raw = await body(req);
      const parsed = JSON.parse(raw) as { model?: string };
      const provider = providers[requests];
      assert.ok(provider);
      assert.equal(req.method, "POST");
      const endpoint =
        provider === "anthropic"
          ? "/v1/messages"
          : provider === "google"
            ? `/v1beta/models/${MODEL[provider]}:generateContent`
            : "/v1/chat/completions";
      assert.equal(req.url, endpoint);
      if (provider !== "google") assert.equal(parsed.model, MODEL[provider]);
      const auth =
        provider === "anthropic"
          ? req.headers["x-api-key"]
          : provider === "google"
            ? req.headers["x-goog-api-key"]
            : req.headers.authorization;
      if (auth !== (provider === "openai-compatible" ? `Bearer ${KEY}` : KEY))
        throw new Error("auth assertion failed");
      if (raw.includes(KEY)) throw new Error("credential leaked into request body");
      requests += 1;
      const response =
        provider === "anthropic"
          ? { content: [{ type: "tool_use", name: STRUCTURED_TOOL_NAME, input: artifact }] }
          : provider === "openai-compatible"
            ? { choices: [{ message: { content: JSON.stringify(artifact) } }] }
            : { candidates: [{ content: { parts: [{ text: JSON.stringify(artifact) }] } }] };
      send(res, 200, response);
    } catch (error) {
      serverFailure = error instanceof Error ? error : new Error(String(error));
      send(res, 500, { error: "fixture assertion failed" });
    }
  });

  server.maxConnections = 4;
  server.requestTimeout = 3_000;
  await new Promise<void>((resolve, reject) => {
    server.once("error", reject);
    server.listen(0, "127.0.0.1", resolve);
  });
  try {
    const address = server.address();
    if (!address || typeof address === "string") throw new Error("fixture did not bind locally");
    const baseUrl = `http://127.0.0.1:${address.port}`;
    for (const provider of providers) {
      const adapter = new HttpApiAdapter(provider, KEY, { baseUrl });
      const result = await adapter.generateStructured({
        model: { provider_kind: provider, provider_model_id: MODEL[provider] },
        messages: [{ role: "user", content: "return the bounded artifact" }],
        schema,
        maxOutputTokens: 128,
        signal: AbortSignal.timeout(3_000)
      });
      assert.ok("rawObject" in result);
      assert.deepEqual(result.rawObject, artifact);
      validatedArtifact = result.rawObject;
    }
    if (serverFailure || requests !== providers.length)
      throw serverFailure ?? new Error("fixture request count mismatch");
    const encoded = JSON.stringify(validatedArtifact);
    assert.equal(typeof encoded, "string");
    if (encoded.includes(KEY) || /provider|model|auth|prompt|usage/i.test(encoded))
      throw new Error("output contains forbidden metadata");
    await mkdir(dirname(outputPath), { recursive: true });
    await writeFile(outputPath, `${encoded}\n`, { encoding: "utf8", mode: 0o600 });
    console.log(
      JSON.stringify({
        checks: [
          "real adapter+local protocol passed",
          "exact artifact/path rejection passed",
          "credential absent from output"
        ],
        unproved: ["real login/auth/model routing"]
      })
    );
  } finally {
    await new Promise<void>((resolve) => server.close(() => resolve()));
  }
}

void main(process.argv[2] ?? "").catch((error) => {
  console.error(error instanceof Error ? error.message : String(error));
  process.exitCode = 1;
});
