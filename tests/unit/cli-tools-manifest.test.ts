import { generateKeyPairSync } from "node:crypto";

import { describe, expect, it } from "vitest";

import {
  lockfileAssetName,
  parseCliToolsManifest
} from "../../packages/cli-runner/src/cli-tools/manifest.js";
import {
  evaluateProvenance,
  installableEntries,
  lockfileProblems,
  pickLatestStable,
  provenanceSourceRepo
} from "../../packages/cli-runner/src/cli-tools/trust-checks.js";
import { signCatalogBytes, verifyCatalogBytes } from "../../packages/module-registry/src/node.js";

const SHA = "a".repeat(64);

function validManifest(): Record<string, unknown> {
  return {
    kind: "cli-tools",
    formatVersion: 1,
    issuedAt: "2026-09-25T12:00:00Z",
    sequence: 3,
    toolsets: {
      anthropic: {
        packages: [
          {
            role: "cli",
            pkg: "@anthropic-ai/claude-code",
            version: "2.1.290",
            lockfile: "anthropic-cli-2.1.290.json",
            lockfileSha256: SHA,
            provenance: "none"
          },
          {
            role: "chat-adapter",
            pkg: "@agentclientprotocol/claude-agent-acp",
            version: "0.81.2",
            lockfile: "anthropic-adapter-0.81.2.json",
            lockfileSha256: SHA,
            provenance: "verified"
          }
        ]
      }
    }
  };
}

function withPackage(patch: Record<string, unknown>): Record<string, unknown> {
  const manifest = validManifest();
  const toolsets = manifest.toolsets as { anthropic: { packages: Record<string, unknown>[] } };
  toolsets.anthropic.packages[0] = { ...toolsets.anthropic.packages[0], ...patch };
  return manifest;
}

describe("parseCliToolsManifest", () => {
  it("accepts a valid manifest and survives a JSON round trip", () => {
    const first = parseCliToolsManifest(validManifest());
    expect(first.ok).toBe(true);
    if (!first.ok) return;
    const again = parseCliToolsManifest(JSON.parse(JSON.stringify(first.manifest)));
    expect(again).toEqual(first);
  });

  it.each([
    ["a wrong kind", { ...validManifest(), kind: "modules" }],
    ["an unknown format", { ...validManifest(), formatVersion: 2 }],
    ["a zero sequence", { ...validManifest(), sequence: 0 }],
    ["a bad timestamp", { ...validManifest(), issuedAt: "yesterday" }],
    ["an unknown toolset", { ...validManifest(), toolsets: { opencode: { packages: [] } } }],
    ["a version range", withPackage({ version: "^2.1.0" })],
    ["a tag instead of a version", withPackage({ version: "latest" })],
    ["a lockfile path", withPackage({ lockfile: "../etc/passwd.json" })],
    ["a short hash", withPackage({ lockfileSha256: "abc" })],
    ["an unknown provenance", withPackage({ provenance: "maybe" })],
    ["a second cli", secondCli()]
  ])("rejects %s", (_label, manifest) => {
    expect(parseCliToolsManifest(manifest).ok).toBe(false);
  });

  it("names asset files by toolset, role and version", () => {
    expect(lockfileAssetName("openai-compatible", "chat-adapter", "1.13.1")).toBe(
      "openai-compatible-adapter-1.13.1.json"
    );
    expect(lockfileAssetName("google", "cli", "0.61.0")).toBe("google-cli-0.61.0.json");
  });
});

function secondCli(): Record<string, unknown> {
  const manifest = validManifest();
  const toolsets = manifest.toolsets as { anthropic: { packages: Record<string, unknown>[] } };
  toolsets.anthropic.packages[1] = { ...toolsets.anthropic.packages[1], role: "cli" };
  return manifest;
}

describe("manifest signing", () => {
  it("verifies with the signing key and fails after one changed byte", () => {
    const { publicKey, privateKey } = generateKeyPairSync("ed25519");
    const keys = [
      { keyId: "k", publicKeyPem: publicKey.export({ type: "spki", format: "pem" }).toString() }
    ];
    const bytes = new TextEncoder().encode(JSON.stringify(validManifest()));
    const signature = signCatalogBytes(
      bytes,
      privateKey.export({ type: "pkcs8", format: "pem" }).toString(),
      "k"
    );
    expect(verifyCatalogBytes(bytes, signature, keys)).toEqual({ verified: true, keyId: "k" });
    const tampered = new Uint8Array(bytes);
    tampered[10] = (tampered[10] ?? 0) ^ 0x01;
    expect(verifyCatalogBytes(tampered, signature, keys).verified).toBe(false);
  });
});

describe("pickLatestStable", () => {
  it("prefers the latest tag", () => {
    expect(
      pickLatestStable({
        "dist-tags": { latest: "1.2.0" },
        versions: { "1.2.0": {}, "1.3.0-beta.1": {}, "1.1.9": {} }
      })
    ).toBe("1.2.0");
  });

  it("falls back to the highest usable version when latest is deprecated or a prerelease", () => {
    expect(
      pickLatestStable({
        "dist-tags": { latest: "2.0.0" },
        versions: { "2.0.0": { deprecated: "broken" }, "1.10.0": {}, "1.9.0": {} }
      })
    ).toBe("1.10.0");
    expect(
      pickLatestStable({
        "dist-tags": { latest: "3.0.0-rc.1" },
        versions: { "3.0.0-rc.1": {}, "2.9.0": {} }
      })
    ).toBe("2.9.0");
  });

  it("returns null when nothing is usable", () => {
    expect(pickLatestStable({ versions: { "1.0.0-alpha": {} } })).toBeNull();
  });
});

describe("lockfile checks", () => {
  const good = {
    lockfileVersion: 3,
    packages: {
      "": { name: "moss-cli-tools-lock" },
      "node_modules/@openai/codex": {
        version: "0.157.0",
        resolved: "https://registry.npmjs.org/@openai/codex/-/codex-0.157.0.tgz",
        integrity: "sha512-AAA"
      },
      "node_modules/@openai/codex-linux-x64": {
        name: "@openai/codex",
        version: "0.157.0-linux-x64",
        resolved: "https://registry.npmjs.org/@openai/codex/-/codex-0.157.0-linux-x64.tgz",
        integrity: "sha512-BBB",
        os: ["linux"]
      },
      "node_modules/@openai/codex-darwin-arm64": {
        name: "@openai/codex",
        version: "0.157.0-darwin-arm64",
        resolved: "https://registry.npmjs.org/@openai/codex/-/codex-0.157.0-darwin-arm64.tgz",
        integrity: "sha512-CCC",
        os: ["darwin"]
      }
    }
  };

  it("passes a complete lockfile", () => {
    expect(lockfileProblems(good, ["@openai/codex-linux-x64"])).toEqual([]);
  });

  it("blocks a missing sha512, a plain http address and a missing arch package", () => {
    const bad = {
      packages: {
        "": {},
        "node_modules/a": { resolved: "http://example.test/a.tgz", integrity: "sha1-xyz" }
      }
    };
    expect(lockfileProblems(bad, ["@openai/codex-linux-x64"])).toEqual([
      "node_modules/a has no sha512 integrity",
      "node_modules/a has no https download address",
      "required package @openai/codex-linux-x64 is missing from the lockfile"
    ]);
    expect(lockfileProblems({ packages: { "": {} } }, [])).toEqual([
      "lockfile has no resolved packages"
    ]);
  });

  it("keeps linux and unrestricted entries, and reads aliased names", () => {
    const entries = installableEntries(good);
    expect(entries.map((e) => `${e.name}@${e.version}`)).toEqual([
      "@openai/codex@0.157.0",
      "@openai/codex@0.157.0-linux-x64"
    ]);
  });
});

describe("evaluateProvenance", () => {
  const expected = { "@openai/codex": "https://github.com/openai/codex" };

  it("accepts a matching repository and records it as carried", () => {
    const verdict = evaluateProvenance(
      [
        {
          name: "@openai/codex",
          version: "1.0.0",
          sourceRepo: "git+https://github.com/OpenAI/codex.git"
        }
      ],
      new Set(),
      expected
    );
    expect(verdict).toEqual({ problems: [], carried: ["@openai/codex"] });
  });

  it("blocks a build from another repository", () => {
    const verdict = evaluateProvenance(
      [{ name: "@openai/codex", version: "1.0.0", sourceRepo: "https://github.com/someone/fork" }],
      new Set(),
      expected
    );
    expect(verdict.problems).toHaveLength(1);
  });

  it("blocks a package that lost provenance and allows one that never had it", () => {
    const verdict = evaluateProvenance(
      [
        { name: "@openai/codex", version: "1.0.1", sourceRepo: null },
        { name: "left-pad", version: "1.0.0", sourceRepo: null }
      ],
      new Set(["@openai/codex"]),
      expected
    );
    expect(verdict.problems).toHaveLength(1);
    expect(verdict.problems[0]).toContain("@openai/codex@1.0.1");
    expect(verdict.carried).toEqual([]);
  });

  it("reads the source repository from a SLSA statement", () => {
    const statement = {
      predicate: {
        buildDefinition: {
          externalParameters: { workflow: { repository: "https://github.com/openai/codex" } }
        }
      }
    };
    expect(provenanceSourceRepo(statement)).toBe("https://github.com/openai/codex");
    expect(provenanceSourceRepo({ predicate: {} })).toBeNull();
    expect(provenanceSourceRepo("nope")).toBeNull();
  });
});
