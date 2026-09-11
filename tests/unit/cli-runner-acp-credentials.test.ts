import { execFileSync, spawnSync } from "node:child_process";
import {
  chmodSync,
  mkdirSync,
  mkdtempSync,
  readFileSync,
  rmSync,
  symlinkSync,
  writeFileSync
} from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { describe, expect, it } from "vitest";
import { codexAuthPath } from "../../packages/cli-runner/src/acp-codex-auth.js";

const scriptPath = join(process.cwd(), "packages/cli-runner/src/agent-home-prepare.mjs");
const loginRequired = "Not logged in (no usable Codex credential in your runner home)";

function requestFor(source: string) {
  return [scriptPath, requestPayloadFor(source)];
}

function requestPayloadFor(source: string) {
  return JSON.stringify({ dirs: [join(source, "agents", "user-1", ".codex")], denyFile: null });
}

function expectOperationalPermissionFailure(result: ReturnType<typeof spawnSync>) {
  expect(result.status).not.toBe(0);
  expect(result.stderr ?? "").toMatch(/\b(?:EACCES|EPERM)\b/);
  expect(result.stderr ?? "").not.toContain(loginRequired);
}

describe("ACP Codex credential boundary", () => {
  it.each([
    ["missing file", undefined],
    ["invalid JSON", "{broken"],
    ["JSON null", "null"],
    ["JSON array", "[]"],
    ["empty object", "{}"],
    ["missing access token", JSON.stringify({ tokens: { account_id: "account" } })],
    ["missing account id", JSON.stringify({ tokens: { access_token: "token" } })],
    ["empty access token", JSON.stringify({ tokens: { access_token: "", account_id: "account" } })],
    ["empty account id", JSON.stringify({ tokens: { access_token: "token", account_id: "" } })],
    [
      "non-string access token",
      JSON.stringify({ tokens: { access_token: 42, account_id: "account" } })
    ],
    ["non-string account id", JSON.stringify({ tokens: { access_token: "token", account_id: 42 } })]
  ])("classifies %s as login required without echoing credential data", (_label, content) => {
    const home = mkdtempSync(join(tmpdir(), "acp-credentials-"));
    const source = codexAuthPath(home, "user-1");
    try {
      mkdirSync(join(home, "agents", "user-1", ".codex"), { recursive: true });
      if (content !== undefined) writeFileSync(source, content, { mode: 0o600 });
      const result = spawnSync(process.execPath, requestFor(home), {
        encoding: "utf8",
        input: JSON.stringify([{ path: source, sourcePath: source, kind: "codex-auth" }])
      });
      expect(result.status).not.toBe(0);
      expect(result.stderr).toContain(loginRequired);
      expect(result.stderr).not.toContain("synthetic-secret");
    } finally {
      rmSync(home, { recursive: true, force: true });
    }
  });

  it("accepts a usable credential and preserves its fixed error-free path", () => {
    const home = mkdtempSync(join(tmpdir(), "acp-credentials-"));
    const source = codexAuthPath(home, "user-1");
    try {
      mkdirSync(join(home, "agents", "user-1", ".codex"), { recursive: true });
      writeFileSync(
        source,
        JSON.stringify({ tokens: { access_token: "synthetic-secret", account_id: "account" } }),
        { mode: 0o600 }
      );
      const result = spawnSync(process.execPath, requestFor(home), {
        encoding: "utf8",
        input: JSON.stringify([{ path: source, sourcePath: source, kind: "codex-auth" }])
      });
      expect(result.status).toBe(0);
      expect(result.stderr).toBe("");
    } finally {
      rmSync(home, { recursive: true, force: true });
    }
  });

  it("does not treat a shared-home credential as an isolated user's login", () => {
    const home = mkdtempSync(join(tmpdir(), "acp-credentials-"));
    try {
      mkdirSync(join(home, ".codex"), { recursive: true });
      writeFileSync(
        join(home, ".codex", "auth.json"),
        JSON.stringify({ tokens: { access_token: "shared", account_id: "shared" } }),
        { mode: 0o600 }
      );
      const result = spawnSync(process.execPath, requestFor(home), {
        encoding: "utf8",
        input: JSON.stringify([
          {
            path: join(home, "agents", "user-1", ".codex", "auth.json"),
            sourcePath: codexAuthPath(home, "user-1"),
            kind: "codex-auth"
          }
        ])
      });
      expect(result.status).not.toBe(0);
      expect(result.stderr ?? "").toContain(loginRequired);
      expect(result.stderr ?? "").not.toContain("shared");
    } finally {
      rmSync(home, { recursive: true, force: true });
    }
  });

  it("keeps symlinked parent credentials a hard failure", () => {
    const home = mkdtempSync(join(tmpdir(), "acp-credentials-"));
    const outside = join(home, "outside");
    try {
      mkdirSync(outside, { recursive: true });
      mkdirSync(join(home, "agents"), { recursive: true });
      symlinkSync(outside, join(home, "agents", "user-1"));
      const source = codexAuthPath(home, "user-1");
      const result = spawnSync(process.execPath, requestFor(home), {
        encoding: "utf8",
        input: JSON.stringify([{ path: source, sourcePath: source, kind: "codex-auth" }])
      });
      expect(result.status).not.toBe(0);
      expect(result.stderr ?? "").toContain("refusing symlinked credential path");
    } finally {
      rmSync(home, { recursive: true, force: true });
    }
  });

  it("rejects symlinked credential files without touching the linked target", () => {
    const home = mkdtempSync(join(tmpdir(), "acp-credentials-"));
    const outside = join(home, "outside-auth.json");
    const source = join(home, "agents", "user-1", ".codex", "auth.json");
    try {
      mkdirSync(join(home, "agents", "user-1", ".codex"), { recursive: true });
      writeFileSync(
        outside,
        JSON.stringify({ tokens: { access_token: "outside", account_id: "outside" } })
      );
      symlinkSync(outside, source);
      const result = spawnSync(process.execPath, requestFor(home), {
        encoding: "utf8",
        input: JSON.stringify([{ path: source, sourcePath: source, kind: "codex-auth" }])
      });
      expect(result.status).not.toBe(0);
      expect(readFileSync(outside, "utf8")).toContain("outside");
      expect(result.stderr ?? "").not.toContain("outside");
    } finally {
      rmSync(home, { recursive: true, force: true });
    }
  });

  it("refuses a protected credential when the launch identity cannot access it", () => {
    const home = mkdtempSync(join(tmpdir(), "acp-credentials-"));
    const source = join(home, "agents", "user-1", ".codex", "auth.json");
    try {
      mkdirSync(join(home, "agents", "user-1", ".codex"), { recursive: true, mode: 0o700 });
      chmodSync(join(home, "agents"), 0o711);
      chmodSync(join(home, "agents", "user-1"), 0o700);
      writeFileSync(
        source,
        JSON.stringify({ tokens: { access_token: "owner-only", account_id: "owner-only" } }),
        { mode: 0o600 }
      );
      const runAsWrongUid = process.getuid?.() === 0;
      if (!runAsWrongUid) chmodSync(join(home, "agents", "user-1"), 0o000);
      const result = spawnSync(process.execPath, requestFor(home), {
        encoding: "utf8",
        input: JSON.stringify([{ path: source, sourcePath: source, kind: "codex-auth" }]),
        ...(runAsWrongUid ? { uid: 65534, gid: 65534 } : {})
      });
      expect(result.error).toBeUndefined();
      expectOperationalPermissionFailure(result);
      expect(result.stdout ?? "").not.toContain("owner-only");
      expect(result.stderr ?? "").not.toContain("owner-only");

      const mutatedSource = readFileSync(scriptPath, "utf8").replaceAll(
        'if (error?.code === "ENOENT") {',
        'if (error?.code === "ENOENT" || error?.code === "EACCES" || error?.code === "EPERM") {'
      );
      const mutatedResult = spawnSync(
        process.execPath,
        [
          "--input-type=module",
          "-e",
          `await import("data:text/javascript," + encodeURIComponent(${JSON.stringify(mutatedSource)}));`,
          "mutation-runner",
          requestPayloadFor(home)
        ],
        {
          encoding: "utf8",
          input: JSON.stringify([{ path: source, sourcePath: source, kind: "codex-auth" }])
        }
      );
      expect(mutatedResult.stderr ?? "").toContain(loginRequired);
      expect(() => expectOperationalPermissionFailure(mutatedResult)).toThrow();
    } finally {
      chmodSync(join(home, "agents", "user-1"), 0o700);
      rmSync(home, { recursive: true, force: true });
    }
  });

  it("rejects a FIFO credential without blocking the owner preparation", () => {
    const home = mkdtempSync(join(tmpdir(), "acp-credentials-"));
    const source = join(home, "agents", "user-1", ".codex", "auth.json");
    try {
      mkdirSync(join(home, "agents", "user-1", ".codex"), { recursive: true, mode: 0o700 });
      execFileSync("mkfifo", [source]);
      const result = spawnSync(process.execPath, requestFor(home), {
        encoding: "utf8",
        input: JSON.stringify([{ path: source, sourcePath: source, kind: "codex-auth" }]),
        timeout: 1000
      });
      expect(result.error).toBeUndefined();
      expect(result.status).not.toBe(0);
      expect(result.stderr ?? "").toContain("non-regular credential path");
    } finally {
      rmSync(home, { recursive: true, force: true });
    }
  });
});
