import { spawnSync } from "node:child_process";
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

const scriptPath = join(process.cwd(), "packages/cli-runner/src/agent-home-prepare.mjs");

function requestFor(source: string) {
  return [
    scriptPath,
    JSON.stringify({ dirs: [join(source, "agents", "user-1", ".codex")], denyFile: null })
  ];
}

describe("ACP Codex credential boundary", () => {
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
      expect(result.status).not.toBe(0);
      expect(result.stdout ?? "").not.toContain("owner-only");
      expect(result.stderr ?? "").not.toContain("owner-only");
    } finally {
      chmodSync(join(home, "agents", "user-1"), 0o700);
      rmSync(home, { recursive: true, force: true });
    }
  });
});
