import { createServer } from "node:http";
import { mkdir, mkdtemp, rm, symlink, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { spawn } from "node:child_process";

import { afterEach, describe, expect, it } from "vitest";

import {
  CLAUDE_ONE_SHOT_PERMISSION_HOOK_SOURCE,
  CLAUDE_PERMISSION_HOOK_SOURCE,
  CLAUDE_PERMISSION_SETTINGS_FILENAME,
  CLAUDE_PERMISSION_HOOK_FILENAME,
  CLAUDE_PERMISSION_TOKEN_FILENAME,
  HOOK_INTERNAL_DEADLINE_S,
  HOOK_TIMEOUT_SECONDS,
  NATIVE_CONFIRM_TIMEOUT_MS,
  deriveClaudePermissionUrl,
  writeClaudeOneShotPermissionHook,
  writeClaudePermissionHook
} from "../../packages/chat/src/live/claude-permission-hook.js";
import type { TmuxIo } from "@moss/ai";

function fakeIo(): TmuxIo & {
  writes: Map<string, string>;
  runs: Array<[string, readonly string[]]>;
} {
  return {
    writes: new Map(),
    runs: [],
    async run(cmd, args) {
      this.runs.push([cmd, args]);
      return { code: 0, stdout: "", stderr: "" };
    },
    async readFile(path) {
      const value = this.writes.get(path);
      if (value === undefined) throw new Error(`missing ${path}`);
      return value;
    },
    async writeFile(path, content) {
      this.writes.set(path, content);
    },
    async sleep() {}
  };
}

async function runHook(
  input: unknown,
  env: Record<string, string | undefined>
): Promise<{ code: number | null; stdout: string; stderr: string }> {
  const dir = await mkdtemp(join(tmpdir(), "jarvis-hook-"));
  const hookPath = join(dir, "hook.mjs");
  await writeFile(hookPath, CLAUDE_PERMISSION_HOOK_SOURCE);
  try {
    const child = spawn(process.execPath, [hookPath], {
      env: { ...process.env, ...env },
      stdio: ["pipe", "pipe", "pipe"]
    });
    child.stdin.end(JSON.stringify(input));
    let stdout = "";
    let stderr = "";
    child.stdout.on("data", (chunk) => {
      stdout += String(chunk);
    });
    child.stderr.on("data", (chunk) => {
      stderr += String(chunk);
    });
    const code = await new Promise<number | null>((resolve) => child.on("close", resolve));
    return { code, stdout, stderr };
  } finally {
    await rm(dir, { recursive: true, force: true });
  }
}

async function runOneShotHook(
  input: unknown,
  env: Record<string, string | undefined>
): Promise<{ code: number | null; decision: string; stdout: string; stderr: string }> {
  const result = await runGeneratedHook(CLAUDE_ONE_SHOT_PERMISSION_HOOK_SOURCE, input, env);
  const output = JSON.parse(result.stdout) as {
    hookSpecificOutput: { permissionDecision: string };
  };
  return {
    ...result,
    decision: output.hookSpecificOutput.permissionDecision
  };
}

async function runGeneratedHook(
  source: string,
  input: unknown,
  env: Record<string, string | undefined>
): Promise<{ code: number | null; stdout: string; stderr: string }> {
  const dir = await mkdtemp(join(tmpdir(), "jarvis-hook-"));
  const hookPath = join(dir, "hook.mjs");
  await writeFile(hookPath, source);
  try {
    const child = spawn(process.execPath, [hookPath], {
      env: { ...process.env, ...env },
      stdio: ["pipe", "pipe", "pipe"]
    });
    child.stdin.end(JSON.stringify(input));
    let stdout = "";
    let stderr = "";
    child.stdout.on("data", (chunk) => {
      stdout += String(chunk);
    });
    child.stderr.on("data", (chunk) => {
      stderr += String(chunk);
    });
    const code = await new Promise<number | null>((resolve) => child.on("close", resolve));
    return { code, stdout, stderr };
  } finally {
    await rm(dir, { recursive: true, force: true });
  }
}

describe("Claude PreToolUse permission hook", () => {
  const originalRoots = process.env.JARVIS_NOTES_ROOTS;

  afterEach(() => {
    if (originalRoots === undefined) delete process.env.JARVIS_NOTES_ROOTS;
    else process.env.JARVIS_NOTES_ROOTS = originalRoots;
  });

  it("derives the internal permission endpoint from the MCP URL host", () => {
    expect(deriveClaudePermissionUrl("http://api:3000/api/mcp")).toBe(
      "http://api:3000/internal/permission"
    );
  });

  it("writes settings, hook, and a separate 0600 bearer token file without putting the bearer in command text", async () => {
    const io = fakeIo();

    const settingsPath = await writeClaudePermissionHook(io, {
      neutralDir: "/tmp/session",
      mcpToken: "jst_secret",
      mcpServerUrl: "http://api:3000/api/mcp"
    });

    expect(settingsPath).toBe(`/tmp/session/${CLAUDE_PERMISSION_SETTINGS_FILENAME}`);
    expect(io.writes.get(`/tmp/session/${CLAUDE_PERMISSION_TOKEN_FILENAME}`)).toBe("jst_secret\n");
    expect(io.writes.get("/tmp/session/.jarvis-claude-permission-hook.mjs")).toContain(
      "PreToolUse"
    );
    const settings = io.writes.get(settingsPath) ?? "";
    expect(settings).toContain("PreToolUse");
    expect(settings).toContain("JARVIS_PERM_TOKEN_FILE=");
    expect(settings).toContain("http://api:3000/internal/permission");
    expect(settings).not.toContain("jst_secret");
    expect(io.runs).toContainEqual([
      "chmod",
      ["600", `/tmp/session/${CLAUDE_PERMISSION_TOKEN_FILENAME}`]
    ]);
  });

  it("orders the three deadlines: server confirm < hook internal < Claude Code hook timeout (#1158)", () => {
    // The 2026-07-18 prod deadlock: server confirm wait (150s) == hook deadline (150s), so
    // the hook always lost the race and failed closed as a transport error, which claude
    // treats as retryable → silent stall loop → #456 watchdog kill. Strict ordering
    // guarantees a genuine timeout/deny returns to claude as a STRUCTURED decision.
    expect(NATIVE_CONFIRM_TIMEOUT_MS).toBeLessThan(HOOK_INTERNAL_DEADLINE_S * 1000);
    expect(HOOK_INTERNAL_DEADLINE_S).toBeLessThan(HOOK_TIMEOUT_SECONDS);
  });

  it("writes the hook command with an explicit JARVIS_PERM_DEADLINE_S and the ordered settings timeout (#1158)", async () => {
    const io = fakeIo();

    const settingsPath = await writeClaudePermissionHook(io, {
      neutralDir: "/tmp/session",
      mcpToken: "jst_secret",
      mcpServerUrl: "http://api:3000/api/mcp"
    });

    const settings = JSON.parse(io.writes.get(settingsPath) ?? "{}") as {
      hooks: { PreToolUse: Array<{ hooks: Array<{ command: string; timeout: number }> }> };
    };
    const hookEntry = settings.hooks.PreToolUse[0]?.hooks[0];
    expect(hookEntry?.timeout).toBe(HOOK_TIMEOUT_SECONDS);
    expect(hookEntry?.command).toContain(`JARVIS_PERM_DEADLINE_S=${HOOK_INTERNAL_DEADLINE_S}`);
  });

  it("injects a shell-quoted JARVIS_NOTES_ROOTS into the persistent hook command when a root is configured (#1467)", async () => {
    process.env.JARVIS_NOTES_ROOTS = "/vault";
    const io = fakeIo();

    const settingsPath = await writeClaudePermissionHook(io, {
      neutralDir: "/tmp/session",
      mcpToken: "jst_secret",
      mcpServerUrl: "http://api:3000/api/mcp"
    });

    const settings = JSON.parse(io.writes.get(settingsPath) ?? "{}") as {
      hooks: { PreToolUse: Array<{ hooks: Array<{ command: string }> }> };
    };
    expect(settings.hooks.PreToolUse[0]?.hooks[0]?.command).toContain(
      "JARVIS_NOTES_ROOTS='/vault'"
    );
  });

  it("omits JARVIS_NOTES_ROOTS from the persistent hook command when no root is configured (#1467)", async () => {
    delete process.env.JARVIS_NOTES_ROOTS;
    const io = fakeIo();

    const settingsPath = await writeClaudePermissionHook(io, {
      neutralDir: "/tmp/session",
      mcpToken: "jst_secret",
      mcpServerUrl: "http://api:3000/api/mcp"
    });

    const settings = JSON.parse(io.writes.get(settingsPath) ?? "{}") as {
      hooks: { PreToolUse: Array<{ hooks: Array<{ command: string }> }> };
    };
    expect(settings.hooks.PreToolUse[0]?.hooks[0]?.command).not.toContain("JARVIS_NOTES_ROOTS");
  });

  it("drops an invalid/injection root before it reaches the persistent hook command line (#1467)", async () => {
    process.env.JARVIS_NOTES_ROOTS = "/vault) Bash(*,/ok";
    const io = fakeIo();

    const settingsPath = await writeClaudePermissionHook(io, {
      neutralDir: "/tmp/session",
      mcpToken: "jst_secret",
      mcpServerUrl: "http://api:3000/api/mcp"
    });

    const settings = JSON.parse(io.writes.get(settingsPath) ?? "{}") as {
      hooks: { PreToolUse: Array<{ hooks: Array<{ command: string }> }> };
    };
    const command = settings.hooks.PreToolUse[0]?.hooks[0]?.command ?? "";
    expect(command).toContain("JARVIS_NOTES_ROOTS='/ok'");
    expect(command).not.toContain("Bash(");
    expect(command).not.toContain(")");
  });

  it("injects a shell-quoted JARVIS_NOTES_ROOTS into the one-shot hook command when a root is configured (#1467)", async () => {
    process.env.JARVIS_NOTES_ROOTS = "/vault";
    const io = fakeIo();

    const settingsPath = await writeClaudeOneShotPermissionHook(io, {
      neutralDir: "/tmp/session"
    });

    const settings = JSON.parse(io.writes.get(settingsPath) ?? "{}") as {
      hooks: { PreToolUse: Array<{ hooks: Array<{ command: string }> }> };
    };
    expect(settings.hooks.PreToolUse[0]?.hooks[0]?.command).toContain(
      "JARVIS_NOTES_ROOTS='/vault'"
    );
  });

  it("omits JARVIS_NOTES_ROOTS from the one-shot hook command when no root is configured (#1467)", async () => {
    delete process.env.JARVIS_NOTES_ROOTS;
    const io = fakeIo();

    const settingsPath = await writeClaudeOneShotPermissionHook(io, {
      neutralDir: "/tmp/session"
    });

    const settings = JSON.parse(io.writes.get(settingsPath) ?? "{}") as {
      hooks: { PreToolUse: Array<{ hooks: Array<{ command: string }> }> };
    };
    expect(settings.hooks.PreToolUse[0]?.hooks[0]?.command).not.toContain("JARVIS_NOTES_ROOTS");
  });

  it("drops an invalid/injection root before it reaches the one-shot hook command line (#1467)", async () => {
    process.env.JARVIS_NOTES_ROOTS = "/vault) Bash(*,/ok";
    const io = fakeIo();

    const settingsPath = await writeClaudeOneShotPermissionHook(io, {
      neutralDir: "/tmp/session"
    });

    const settings = JSON.parse(io.writes.get(settingsPath) ?? "{}") as {
      hooks: { PreToolUse: Array<{ hooks: Array<{ command: string }> }> };
    };
    const command = settings.hooks.PreToolUse[0]?.hooks[0]?.command ?? "";
    expect(command).toContain("JARVIS_NOTES_ROOTS='/ok'");
    expect(command).not.toContain("Bash(");
    expect(command).not.toContain(")");
  });

  it("end-to-end: persistent hook honors JARVIS_NOTES_ROOTS reaching it only via the generated command line, never a pre-set env (#1467)", async () => {
    const dir = await mkdtemp(join(tmpdir(), "jarvis-hook-e2e-"));
    const vaultDir = await mkdtemp(join(tmpdir(), "jarvis-vault-e2e-"));
    process.env.JARVIS_NOTES_ROOTS = vaultDir;
    try {
      const targetFile = join(vaultDir, "a.md");
      await writeFile(targetFile, "hello");
      const io = fakeIo();
      const settingsPath = await writeClaudePermissionHook(io, {
        neutralDir: dir,
        mcpToken: "jst_secret",
        mcpServerUrl: "http://api:3000/api/mcp"
      });
      for (const [path, content] of io.writes) {
        await writeFile(path, content);
      }
      const settings = JSON.parse(io.writes.get(settingsPath) ?? "{}") as {
        hooks: { PreToolUse: Array<{ hooks: Array<{ command: string }> }> };
      };
      const command = settings.hooks.PreToolUse[0]?.hooks[0]?.command ?? "";

      // Strip JARVIS_NOTES_ROOTS from the spawned shell's own env — if this test only passed
      // because the child inherited it from the parent, it would prove nothing about the
      // command-line injection this fix adds.
      const { JARVIS_NOTES_ROOTS: _dropped, ...envWithoutRoots } = process.env;
      const child = spawn("sh", ["-c", command], {
        env: envWithoutRoots,
        stdio: ["pipe", "pipe", "pipe"]
      });
      child.stdin.end(JSON.stringify({ tool_name: "Read", tool_input: { file_path: targetFile } }));
      let stdout = "";
      child.stdout.on("data", (chunk) => {
        stdout += String(chunk);
      });
      const code = await new Promise<number | null>((resolve) => child.on("close", resolve));
      expect(code).toBe(0);
      expect(JSON.parse(stdout).hookSpecificOutput.permissionDecision).toBe("allow");
    } finally {
      await rm(dir, { recursive: true, force: true });
      await rm(vaultDir, { recursive: true, force: true });
    }
  });

  it("end-to-end: one-shot hook honors JARVIS_NOTES_ROOTS reaching it only via the generated command line, never a pre-set env (#1467)", async () => {
    const dir = await mkdtemp(join(tmpdir(), "jarvis-hook-e2e-"));
    const vaultDir = await mkdtemp(join(tmpdir(), "jarvis-vault-e2e-"));
    process.env.JARVIS_NOTES_ROOTS = vaultDir;
    try {
      const targetFile = join(vaultDir, "a.md");
      await writeFile(targetFile, "hello");
      const io = fakeIo();
      const settingsPath = await writeClaudeOneShotPermissionHook(io, {
        neutralDir: dir
      });
      for (const [path, content] of io.writes) {
        await writeFile(path, content);
      }
      const settings = JSON.parse(io.writes.get(settingsPath) ?? "{}") as {
        hooks: { PreToolUse: Array<{ hooks: Array<{ command: string }> }> };
      };
      const command = settings.hooks.PreToolUse[0]?.hooks[0]?.command ?? "";

      const { JARVIS_NOTES_ROOTS: _dropped, ...envWithoutRoots } = process.env;
      const child = spawn("sh", ["-c", command], {
        env: envWithoutRoots,
        stdio: ["pipe", "pipe", "pipe"]
      });
      child.stdin.end(JSON.stringify({ tool_name: "Read", tool_input: { file_path: targetFile } }));
      let stdout = "";
      child.stdout.on("data", (chunk) => {
        stdout += String(chunk);
      });
      const code = await new Promise<number | null>((resolve) => child.on("close", resolve));
      expect(code).toBe(0);
      expect(JSON.parse(stdout).hookSpecificOutput.permissionDecision).toBe("allow");
    } finally {
      await rm(dir, { recursive: true, force: true });
      await rm(vaultDir, { recursive: true, force: true });
    }
  });

  it("allows configured vault reads without calling the gateway", async () => {
    const vaultDir = await mkdtemp(join(tmpdir(), "jarvis-vault-"));
    try {
      const targetFile = join(vaultDir, "a.md");
      await writeFile(targetFile, "hello");
      const result = await runHook(
        { tool_name: "Read", tool_input: { file_path: targetFile } },
        { JARVIS_NOTES_ROOTS: vaultDir }
      );

      expect(result.code).toBe(0);
      expect(JSON.parse(result.stdout).hookSpecificOutput.permissionDecision).toBe("allow");
    } finally {
      await rm(vaultDir, { recursive: true, force: true });
    }
  });

  // #1467 QA: lexical containment alone let a symlink planted inside a vault root point anywhere
  // on disk while its path string still read as "under root". These assert the realpath
  // containment fails closed — no instant "allow" — for both the classic escape and the
  // secret-bearing-HOME variant, and for both an existing and a not-yet-created escape target.
  it("fails closed when a vault-root symlink escapes to an outside secret-bearing HOME (#1467 QA)", async () => {
    const vaultDir = await mkdtemp(join(tmpdir(), "jarvis-vault-"));
    const fakeHome = await mkdtemp(join(tmpdir(), "jarvis-fake-home-"));
    try {
      await mkdir(join(fakeHome, ".ssh"), { recursive: true });
      await writeFile(join(fakeHome, ".ssh", "id_rsa"), "-----BEGIN OPENSSH PRIVATE KEY-----");
      const escapeLink = join(vaultDir, "escape");
      await symlink(fakeHome, escapeLink, "dir");
      const candidate = join(escapeLink, ".ssh", "id_rsa");

      // No allow-by-symlink means the hook falls through past safeVaultRead to the token check.
      // If the escape were instant-allowed, this would exit "allow" without ever reaching it.
      const result = await runHook(
        { tool_name: "Read", tool_input: { file_path: candidate } },
        {
          JARVIS_NOTES_ROOTS: vaultDir,
          JARVIS_PERM_URL: "http://127.0.0.1:1/internal/permission",
          JARVIS_PERM_TOKEN_FILE: "/no/such/token"
        }
      );

      expect(result.code).toBe(0);
      const decision = JSON.parse(result.stdout).hookSpecificOutput;
      expect(decision.permissionDecision).toBe("deny");
      expect(decision.permissionDecisionReason).toBe("missing session token");
    } finally {
      await rm(vaultDir, { recursive: true, force: true });
      await rm(fakeHome, { recursive: true, force: true });
    }
  });

  it("fails closed when the escaping symlink's leaf target doesn't exist yet (ancestor-climb path) (#1467 QA)", async () => {
    const vaultDir = await mkdtemp(join(tmpdir(), "jarvis-vault-"));
    const outsideDir = await mkdtemp(join(tmpdir(), "jarvis-outside-"));
    try {
      const escapeLink = join(vaultDir, "escape");
      await symlink(outsideDir, escapeLink, "dir");
      const candidate = join(escapeLink, "not-yet-created.md");

      const result = await runHook(
        { tool_name: "Read", tool_input: { file_path: candidate } },
        {
          JARVIS_NOTES_ROOTS: vaultDir,
          JARVIS_PERM_URL: "http://127.0.0.1:1/internal/permission",
          JARVIS_PERM_TOKEN_FILE: "/no/such/token"
        }
      );

      expect(result.code).toBe(0);
      expect(JSON.parse(result.stdout).hookSpecificOutput.permissionDecision).toBe("deny");
    } finally {
      await rm(vaultDir, { recursive: true, force: true });
      await rm(outsideDir, { recursive: true, force: true });
    }
  });

  it("fails closed when the configured vault root itself doesn't exist on disk (#1467 QA)", async () => {
    const result = await runHook(
      { tool_name: "Read", tool_input: { file_path: "/jarvis-nonexistent-vault/a.md" } },
      {
        JARVIS_NOTES_ROOTS: "/jarvis-nonexistent-vault",
        JARVIS_PERM_URL: "http://127.0.0.1:1/internal/permission",
        JARVIS_PERM_TOKEN_FILE: "/no/such/token"
      }
    );

    expect(result.code).toBe(0);
    expect(JSON.parse(result.stdout).hookSpecificOutput.permissionDecision).toBe("deny");
  });

  // #1467 QA round 2 (RED): fs.realpathSync collapses ".." LEXICALLY before resolving symlinks,
  // while the kernel resolves ".." only AFTER expanding each symlink component — so root/escape/../
  // secret disagreed between the hook's decision and what open(2) would actually read/write. These
  // build the candidate by raw string concatenation, never path.join/path.resolve, because those
  // collapse ".." in the TEST HARNESS before the string ever reaches the hook, which is exactly the
  // gap that let the first round of these tests pass against the still-broken code.
  it("fails closed against a dotdot-over-symlink read escape (#1467 QA2)", async () => {
    const vaultDir = await mkdtemp(join(tmpdir(), "jarvis-vault-"));
    const outsideDir = await mkdtemp(join(tmpdir(), "jarvis-outside-"));
    try {
      await mkdir(join(outsideDir, "targetdir"), { recursive: true });
      await mkdir(join(outsideDir, "secrets"), { recursive: true });
      await writeFile(join(outsideDir, "secrets", "id_rsa"), "-----BEGIN OPENSSH PRIVATE KEY-----");
      const escapeLink = join(vaultDir, "escape");
      await symlink(join(outsideDir, "targetdir"), escapeLink, "dir");
      // Raw concatenation: escapeLink + "/../secrets/id_rsa" — a real ".." segment, not collapsed
      // before it reaches the hook.
      const candidate = escapeLink + "/../secrets/id_rsa";

      const result = await runHook(
        { tool_name: "Read", tool_input: { file_path: candidate } },
        {
          JARVIS_NOTES_ROOTS: vaultDir,
          JARVIS_PERM_URL: "http://127.0.0.1:1/internal/permission",
          JARVIS_PERM_TOKEN_FILE: "/no/such/token"
        }
      );

      expect(result.code).toBe(0);
      const decision = JSON.parse(result.stdout).hookSpecificOutput;
      expect(decision.permissionDecision).toBe("deny");
      expect(decision.permissionDecisionReason).toBe("missing session token");
    } finally {
      await rm(vaultDir, { recursive: true, force: true });
      await rm(outsideDir, { recursive: true, force: true });
    }
  });

  it("fails closed against a dotdot-over-symlink write escape (#1467 QA2)", async () => {
    const sessionDir = await mkdtemp(join(tmpdir(), "jarvis-session-"));
    const outsideDir = await mkdtemp(join(tmpdir(), "jarvis-outside-"));
    try {
      await mkdir(join(outsideDir, "targetdir"), { recursive: true });
      const escapeLink = join(sessionDir, "escape");
      await symlink(join(outsideDir, "targetdir"), escapeLink, "dir");
      const candidate = escapeLink + "/../pwned.md";

      const result = await runOneShotHook(
        { tool_name: "Write", tool_input: { file_path: candidate } },
        { JARVIS_SESSION_ROOT: sessionDir }
      );

      expect(result.code).toBe(0);
      expect(result.decision).toBe("deny");
    } finally {
      await rm(sessionDir, { recursive: true, force: true });
      await rm(outsideDir, { recursive: true, force: true });
    }
  });

  // #1467 QA round 2 (RED, 2nd finding): resolveExistingAncestor treated ANY realpath failure as
  // "this path doesn't exist yet, so climb to the parent" — true for a not-yet-created file, false
  // for a DANGLING symlink. realpath fails ENOENT on a dangling link too, but the entry still
  // exists (lstat finds it), and open(O_CREAT) follows the link to create the file at its target —
  // outside the root the link's own location would suggest. The candidate here is planted with the
  // leaf target absent so realpath genuinely can't resolve it, but lstat must still see the symlink.
  it("fails closed when the write candidate itself is a dangling symlink pointing outside the root (#1467 QA2)", async () => {
    const sessionDir = await mkdtemp(join(tmpdir(), "jarvis-session-"));
    const outsideDir = await mkdtemp(join(tmpdir(), "jarvis-outside-"));
    try {
      await mkdir(join(sessionDir, "sub"), { recursive: true });
      const danglingLink = join(sessionDir, "sub", "innocent.md");
      // Target does not exist yet — the link is dangling — but it still resolves outside the root.
      await symlink(join(outsideDir, "pwned.md"), danglingLink, "file");

      const result = await runOneShotHook(
        { tool_name: "Write", tool_input: { file_path: danglingLink } },
        { JARVIS_SESSION_ROOT: sessionDir }
      );

      expect(result.code).toBe(0);
      expect(result.decision).toBe("deny");
    } finally {
      await rm(sessionDir, { recursive: true, force: true });
      await rm(outsideDir, { recursive: true, force: true });
    }
  });

  it("fails closed when an intermediate directory component (not the leaf) is a dangling symlink pointing outside the root (#1467 QA3)", async () => {
    const sessionDir = await mkdtemp(join(tmpdir(), "jarvis-session-"));
    const outsideDir = await mkdtemp(join(tmpdir(), "jarvis-outside-"));
    try {
      await mkdir(join(sessionDir, "sub"), { recursive: true });
      const danglingDirLink = join(sessionDir, "sub", "danglingdir");
      // The link's target directory does not exist on disk at all — the link is dangling — but the
      // ancestor-climb must still refuse to treat "it doesn't exist yet" as safe, because the link
      // itself is a real fs entry that open(O_CREAT) would follow to a path outside the root.
      await symlink(join(outsideDir, "nonexistent-dir"), danglingDirLink, "dir");
      const candidate = danglingDirLink + "/new-note.md";

      const result = await runOneShotHook(
        { tool_name: "Write", tool_input: { file_path: candidate } },
        { JARVIS_SESSION_ROOT: sessionDir }
      );

      expect(result.code).toBe(0);
      expect(result.decision).toBe("deny");
    } finally {
      await rm(sessionDir, { recursive: true, force: true });
      await rm(outsideDir, { recursive: true, force: true });
    }
  });

  it("still pre-approves a deep not-yet-created path under a real vault root (#1467 QA3 no-regression)", async () => {
    const sessionDir = await mkdtemp(join(tmpdir(), "jarvis-session-"));
    try {
      const candidate = join(sessionDir, "sub", "deeper", "brand-new-note.md");

      const result = await runOneShotHook(
        { tool_name: "Write", tool_input: { file_path: candidate } },
        { JARVIS_SESSION_ROOT: sessionDir }
      );

      expect(result.code).toBe(0);
      expect(result.decision).toBe("allow");
    } finally {
      await rm(sessionDir, { recursive: true, force: true });
    }
  });

  it("denies with exit 0 when token file is missing", async () => {
    const result = await runHook(
      { tool_name: "Bash", tool_input: { command: "echo hi" } },
      {
        JARVIS_PERM_URL: "http://127.0.0.1:1/internal/permission",
        JARVIS_PERM_TOKEN_FILE: "/no/such/token"
      }
    );

    expect(result.code).toBe(0);
    expect(JSON.parse(result.stdout).hookSpecificOutput.permissionDecision).toBe("deny");
    expect(result.stderr).toBe("");
  });

  it("obeys gateway approve and deny decisions through the bearer header", async () => {
    const dir = await mkdtemp(join(tmpdir(), "jarvis-token-"));
    const tokenFile = join(dir, "token");
    await writeFile(tokenFile, "jst_ok\n");
    const seenHeaders: string[] = [];
    const seenBodies: unknown[] = [];
    const server = createServer((req, res) => {
      seenHeaders.push(String(req.headers.authorization ?? ""));
      let body = "";
      req.setEncoding("utf8");
      req.on("data", (chunk) => {
        body += chunk;
      });
      req.on("end", () => {
        seenBodies.push(JSON.parse(body));
        res.setHeader("content-type", "application/json");
        res.end(JSON.stringify({ decision: "allow", reason: "approved" }));
      });
    });
    await new Promise<void>((resolve) => server.listen(0, "127.0.0.1", resolve));
    const address = server.address();
    if (!address || typeof address === "string") throw new Error("missing server address");
    try {
      const result = await runHook(
        { tool_name: "Bash", tool_input: { command: "echo hi" }, cwd: "/real/workspace" },
        {
          JARVIS_PERM_URL: `http://127.0.0.1:${address.port}/internal/permission`,
          JARVIS_PERM_TOKEN_FILE: tokenFile
        }
      );

      expect(result.code).toBe(0);
      expect(JSON.parse(result.stdout).hookSpecificOutput.permissionDecision).toBe("allow");
      expect(seenHeaders).toEqual(["Bearer jst_ok"]);
      // #1085 F1: assert the generated hook forwards Claude's actual event cwd, not a test-only
      // gateway request field that can drift from production again.
      expect(seenBodies).toEqual([
        { tool_name: "Bash", tool_input: { command: "echo hi" }, cwd: "/real/workspace" }
      ]);
    } finally {
      server.close();
      await rm(dir, { recursive: true, force: true });
    }
  });

  it.each([
    ["Read", (vaultDir: string) => ({ file_path: join(vaultDir, "a.md") })],
    ["Glob", (vaultDir: string) => ({ pattern: `${vaultDir}/**/*.md` })],
    ["Grep", (vaultDir: string) => ({ path: vaultDir })]
  ])("one-shot allows %s under JARVIS_NOTES_ROOTS", async (tool_name, buildInput) => {
    const vaultDir = await mkdtemp(join(tmpdir(), "jarvis-vault-"));
    const sessionDir = await mkdtemp(join(tmpdir(), "jarvis-session-"));
    try {
      await writeFile(join(vaultDir, "a.md"), "hello");
      const result = await runOneShotHook(
        { tool_name, tool_input: buildInput(vaultDir) },
        { JARVIS_SESSION_ROOT: sessionDir, JARVIS_NOTES_ROOTS: vaultDir }
      );
      expect(result.code).toBe(0);
      expect(result.decision).toBe("allow");
    } finally {
      await rm(vaultDir, { recursive: true, force: true });
      await rm(sessionDir, { recursive: true, force: true });
    }
  });

  it.each(["Write", "Edit", "MultiEdit", "NotebookEdit"])(
    "one-shot allows %s inside the session root",
    async (tool_name) => {
      const sessionDir = await mkdtemp(join(tmpdir(), "jarvis-session-"));
      try {
        const result = await runOneShotHook(
          { tool_name, tool_input: { file_path: join(sessionDir, "output.md") } },
          { JARVIS_SESSION_ROOT: sessionDir }
        );
        expect(result.code).toBe(0);
        expect(result.decision).toBe("allow");
      } finally {
        await rm(sessionDir, { recursive: true, force: true });
      }
    }
  );

  it("one-shot allows Jarv1s MCP without a gateway round-trip", async () => {
    const result = await runOneShotHook(
      { tool_name: "mcp__jarvis__get_notes", tool_input: {} },
      { JARVIS_SESSION_ROOT: "/tmp/session" }
    );
    expect(result.code).toBe(0);
    expect(result.decision).toBe("allow");
  });

  // #1361: the CLI stops sending MCP schemas up front past a certain tool count and expects the
  // model to call ToolSearch for them. Denying that call denied every Jarv1s tool behind it, and
  // prod chat told the user "tool access is restricted" with a perfectly healthy gateway.
  it("one-shot allows ToolSearch so deferred MCP schemas can load", async () => {
    const result = await runOneShotHook(
      { tool_name: "ToolSearch", tool_input: { query: "notes" } },
      { JARVIS_SESSION_ROOT: "/tmp/session" }
    );
    expect(result.code).toBe(0);
    expect(result.decision).toBe("allow");
  });

  // The discovery allowance is exact-match, not a prefix or a substring: a tool merely *named*
  // like the loader must still fall through to the deny below.
  it.each([["ToolSearchExec"], ["toolsearch"], ["Bash ToolSearch"]])(
    "one-shot still denies %s, which only resembles the discovery tool",
    async (tool_name) => {
      const result = await runOneShotHook(
        { tool_name, tool_input: {} },
        { JARVIS_SESSION_ROOT: "/tmp/session" }
      );
      expect(result.code).toBe(0);
      expect(result.decision).toBe("deny");
    }
  );

  it.each([
    ["Bash", { command: "echo hi" }],
    ["Write", { file_path: "/etc/jarvis.conf" }],
    ["Read", { file_path: "/etc/passwd" }],
    ["Read", { file_path: "/tmp/session/private.md" }],
    ["WebFetch", { url: "https://example.com" }]
  ])("one-shot denies %s without a card", async (tool_name, tool_input) => {
    const result = await runOneShotHook(
      { tool_name, tool_input },
      { JARVIS_SESSION_ROOT: "/tmp/session", JARVIS_NOTES_ROOTS: "/vault" }
    );
    expect(result.code).toBe(0);
    expect(result.decision).toBe("deny");
  });

  it("writes one-shot settings without gateway/deadline plumbing", async () => {
    const io = fakeIo();

    const settingsPath = await writeClaudeOneShotPermissionHook(io, {
      neutralDir: "/tmp/session"
    });

    expect(settingsPath).toBe("/tmp/session/" + CLAUDE_PERMISSION_SETTINGS_FILENAME);
    expect(io.writes.get(settingsPath)).not.toContain("JARVIS_PERM");
    expect(io.writes.get("/tmp/session/" + CLAUDE_PERMISSION_HOOK_FILENAME)).toBe(
      CLAUDE_ONE_SHOT_PERMISSION_HOOK_SOURCE
    );
    expect(io.writes.get("/tmp/session/" + CLAUDE_PERMISSION_HOOK_FILENAME)).not.toContain(
      "postPermission"
    );
    expect(io.runs).toContainEqual([
      "chmod",
      ["600", "/tmp/session/" + CLAUDE_PERMISSION_HOOK_FILENAME]
    ]);
  });
});
