import { createHash, generateKeyPairSync } from "node:crypto";

import { describe, expect, it, vi } from "vitest";

import { buildCliToolsRefresh } from "../../packages/module-registry/src/cli-tools-refresh-wiring.js";
import {
  manifestBytes,
  signCatalogBytes,
  type CliToolsManifest
} from "../../packages/module-registry/src/node.js";

const pair = generateKeyPairSync("ed25519");
const privatePem = pair.privateKey.export({ type: "pkcs8", format: "pem" }).toString();
const lock = Buffer.from("{}");

const manifest: CliToolsManifest = {
  kind: "cli-tools",
  formatVersion: 1,
  issuedAt: "2026-09-30T00:00:00Z",
  sequence: 3,
  provenanceHistory: {},
  toolsets: {
    anthropic: {
      minMossVersion: "0.1.0",
      packages: [
        {
          role: "cli",
          pkg: "@anthropic-ai/claude-code",
          version: "9.9.9",
          lockfile: "a.json",
          lockfileSha256: createHash("sha256").update(lock).digest("hex"),
          provenance: "none"
        }
      ]
    }
  }
};

describe("buildCliToolsRefresh", () => {
  it("rejects a manifest signed by a key the image does not ship, and stages nothing", async () => {
    const bytes = manifestBytes(manifest);
    const files: Record<string, Uint8Array> = {
      "cli-tools-manifest.json": bytes,
      "cli-tools-manifest.json.sig": Buffer.from(
        JSON.stringify(signCatalogBytes(bytes, privatePem, "attacker-key"))
      ),
      "a.json": lock
    };
    const fetchFn = (async (url: string) =>
      new Response(Buffer.from(files[String(url).split("/").pop()!]!))) as unknown as typeof fetch;
    const stageCliCandidate = vi.fn();
    const refresh = buildCliToolsRefresh({
      getConnection: () =>
        ({
          getCliToolsState: async () => ({ manifestSequence: 1, candidates: {} }),
          stageCliCandidate
        }) as never,
      versionReader: undefined,
      fetchFn,
      mossVersion: () => "0.2.0"
    });
    const out = await refresh();
    expect(out).toMatchObject({ status: "fetch-failed", reason: "signature-unknown-key" });
    expect(stageCliCandidate).not.toHaveBeenCalled();
  });

  it("reports the runner as unavailable when there is no connection", async () => {
    const out = await buildCliToolsRefresh({
      getConnection: () => undefined,
      versionReader: undefined
    })();
    expect(out.status).toBe("runner-unavailable");
  });
});
