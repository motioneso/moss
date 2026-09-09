import { access, mkdir, mkdtemp, readFile, rm, stat, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";

import { createRealTmuxIo } from "@moss/ai";
import { afterEach, describe, expect, it, vi } from "vitest";

import {
  CODEX_IDENTITY_FILENAME,
  GEMINI_IDENTITY_FILENAME,
  GEMINI_OUTPUT_FILENAME,
  GEMINI_STDERR_FILENAME,
  codexTranscriptPath,
  parseCodexSessionUuid,
  parseGeminiProjectShortId,
  persistCodexSessionIdentity,
  persistGeminiSessionIdentity,
  purgeGeminiConversation,
  purgePrivateTranscripts,
  readCodexSessionIdentity,
  readGeminiSessionIdentity
} from "../../packages/chat/src/live/private-transcript-cleanup.js";

function makeIo() {
  return {
    run: vi.fn().mockResolvedValue({ code: 0, stdout: "", stderr: "" }),
    readFile: vi.fn().mockResolvedValue(""),
    writeFile: vi.fn().mockResolvedValue(undefined)
  };
}

describe("purgePrivateTranscripts", () => {
  const roots: string[] = [];
  afterEach(async () => Promise.all(roots.splice(0).map((root) => rm(root, { recursive: true }))));

  async function fixture() {
    const root = await mkdtemp(join(tmpdir(), "jarvis-private-purge-"));
    roots.push(root);
    const neutralBase = join(root, "neutral");
    const neutralDir = join(neutralBase, "user-1");
    const homeBase = join(root, "home");
    await mkdir(neutralDir, { recursive: true });
    return { io: createRealTmuxIo(), neutralBase, neutralDir, homeBase };
  }

  it("finds an offset Codex rollout by identity and deletes only that rollout", async () => {
    const { io, neutralBase, neutralDir, homeBase } = await fixture();
    const mine = "019f5af9-3c61-7f72-af47-09514db9892c";
    const sibling = "019f5af9-3c61-7f72-af47-09514db9892d";
    // #1086 — deliberately disagree with the UUIDv7-derived local-time path.
    const minePath = join(
      homeBase,
      ".codex",
      "sessions",
      "2099",
      "12",
      "31",
      `rollout-offset-${mine}.jsonl`
    );
    const siblingPath = codexTranscriptPath(sibling, homeBase);
    await mkdir(dirname(minePath), { recursive: true });
    await mkdir(dirname(siblingPath), { recursive: true });
    await writeFile(
      minePath,
      `${JSON.stringify({ type: "session_meta", payload: { id: mine, cwd: neutralDir } })}\n`
    );
    await writeFile(
      siblingPath,
      `${JSON.stringify({ type: "session_meta", payload: { id: sibling, cwd: neutralDir } })}\n`
    );
    await persistCodexSessionIdentity(io, neutralDir, mine);

    await purgePrivateTranscripts(io, neutralBase, "user-1", homeBase);

    await expect(access(minePath)).rejects.toThrow();
    await expect(readFile(siblingPath, "utf8")).resolves.toContain(sibling);
    await expect(stat(join(neutralDir, CODEX_IDENTITY_FILENAME))).rejects.toThrow();
  });

  it("retains the Codex retry pointer when no rollout is found", async () => {
    const { io, neutralBase, neutralDir, homeBase } = await fixture();
    const uuid = "019f5af9-3c61-7f72-af47-09514db9892c";
    await persistCodexSessionIdentity(io, neutralDir, uuid);

    await expect(purgePrivateTranscripts(io, neutralBase, "user-1", homeBase)).rejects.toThrow(
      "identity mismatch"
    );

    await expect(readFile(join(neutralDir, CODEX_IDENTITY_FILENAME), "utf8")).resolves.toBe(
      `${uuid}\n`
    );
  });

  it.each(["missing", "corrupt"])("retains every Codex rollout with a %s marker", async (kind) => {
    const { io, neutralBase, neutralDir, homeBase } = await fixture();
    const uuid = "019f5af9-3c61-7f72-af47-09514db9892c";
    const path = codexTranscriptPath(uuid, homeBase);
    await mkdir(dirname(path), { recursive: true });
    await writeFile(
      path,
      `${JSON.stringify({ type: "session_meta", payload: { id: uuid, cwd: neutralDir } })}\n`
    );
    if (kind === "corrupt")
      await writeFile(join(neutralDir, CODEX_IDENTITY_FILENAME), "../../shared-root\n");

    await purgePrivateTranscripts(io, neutralBase, "user-1", homeBase);

    await expect(readFile(path, "utf8")).resolves.toContain(uuid);
  });

  it("rejects same-id/different-cwd and deletes codex-exec only inside the exact neutral dir", async () => {
    const { io, neutralBase, neutralDir, homeBase } = await fixture();
    const uuid = "019f5af9-3c61-7f72-af47-09514db9892c";
    const path = codexTranscriptPath(uuid, homeBase);
    await mkdir(dirname(path), { recursive: true });
    await writeFile(
      path,
      `${JSON.stringify({ type: "session_meta", payload: { id: uuid, cwd: `${neutralDir}-other` } })}\n`
    );
    await persistCodexSessionIdentity(io, neutralDir, uuid);
    await writeFile(join(neutralDir, "codex-exec-transcript.jsonl"), "private\n");
    const otherNeutral = `${neutralDir}-other`;
    await mkdir(otherNeutral, { recursive: true });
    await writeFile(join(otherNeutral, "codex-exec-transcript.jsonl"), "sibling\n");

    await expect(purgePrivateTranscripts(io, neutralBase, "user-1", homeBase)).rejects.toThrow(
      "identity mismatch"
    );

    await expect(readFile(path, "utf8")).resolves.toContain(uuid);
    await expect(access(join(neutralDir, "codex-exec-transcript.jsonl"))).rejects.toThrow();
    await expect(readFile(join(otherNeutral, "codex-exec-transcript.jsonl"), "utf8")).resolves.toBe(
      "sibling\n"
    );
  });

  it("purges every place a Gemini conversation left state, and nobody else's", async () => {
    // #2028 — a headless run writes THREE things outside the session folder: a saved-chat
    // directory, a history directory, and a registry entry pointing at both. Removing only the
    // first is the tempting half-fix and leaves the founder's conversation on disk.
    const { io, neutralBase, neutralDir, homeBase } = await fixture();
    const uuid = "e099f770-a55c-432f-a9be-8cf254fd2d54";
    const geminiRoot = join(homeBase, ".gemini");
    const mineShortId = "user-1";
    const siblingShortId = "user-2";
    for (const bucket of ["tmp", "history"]) {
      await mkdir(join(geminiRoot, bucket, mineShortId), { recursive: true });
      await mkdir(join(geminiRoot, bucket, siblingShortId), { recursive: true });
      await writeFile(join(geminiRoot, bucket, mineShortId, "chat.json"), "mine");
      await writeFile(join(geminiRoot, bucket, siblingShortId, "chat.json"), "sibling");
    }
    await writeFile(
      join(geminiRoot, "projects.json"),
      JSON.stringify({
        projects: { [neutralDir]: mineShortId, "/some/other/folder": siblingShortId }
      })
    );
    await writeFile(join(geminiRoot, "projects.json.abcd.tmp"), "{}");
    await writeFile(join(neutralDir, GEMINI_OUTPUT_FILENAME), "{}\n");
    await writeFile(join(neutralDir, GEMINI_STDERR_FILENAME), "warn\n");
    await writeFile(join(neutralDir, "gemini-crash-1.json"), "the founder's prompt");
    await writeFile(join(neutralDir, GEMINI_IDENTITY_FILENAME), `${uuid}\n`);

    await purgePrivateTranscripts(io, neutralBase, "user-1", homeBase);

    await expect(access(join(geminiRoot, "tmp", mineShortId))).rejects.toThrow();
    await expect(access(join(geminiRoot, "history", mineShortId))).rejects.toThrow();
    await expect(access(join(neutralDir, GEMINI_OUTPUT_FILENAME))).rejects.toThrow();
    await expect(access(join(neutralDir, GEMINI_STDERR_FILENAME))).rejects.toThrow();
    await expect(access(join(neutralDir, "gemini-crash-1.json"))).rejects.toThrow();
    await expect(access(join(neutralDir, GEMINI_IDENTITY_FILENAME))).rejects.toThrow();
    await expect(access(join(geminiRoot, "projects.json.abcd.tmp"))).rejects.toThrow();

    // Another folder's entry and state are untouched.
    const registry = JSON.parse(await readFile(join(geminiRoot, "projects.json"), "utf8"));
    expect(registry).toEqual({ projects: { "/some/other/folder": siblingShortId } });
    await expect(
      readFile(join(geminiRoot, "tmp", siblingShortId, "chat.json"), "utf8")
    ).resolves.toBe("sibling");
  });

  it("leaves the Gemini marker in place when the purge could not finish", async () => {
    // Fail-closed (#1086's rule): a marker that survives is the next boot sweep's second chance.
    const { neutralBase, neutralDir, homeBase } = await fixture();
    const uuid = "e099f770-a55c-432f-a9be-8cf254fd2d54";
    await writeFile(join(neutralDir, GEMINI_IDENTITY_FILENAME), `${uuid}\n`);
    await mkdir(join(homeBase, ".gemini"), { recursive: true });
    await writeFile(join(homeBase, ".gemini", "projects.json"), "this is not json");

    const io = createRealTmuxIo();
    await expect(purgePrivateTranscripts(io, neutralBase, "user-1", homeBase)).rejects.toThrow();

    await expect(readFile(join(neutralDir, GEMINI_IDENTITY_FILENAME), "utf8")).resolves.toContain(
      uuid
    );
  });
});

describe("Codex session identity", () => {
  const uuid = "019f5af9-3c61-7f72-af47-09514db9892c";

  it("accepts one exact /status Session UUID and rejects missing or ambiguous panes", () => {
    expect(parseCodexSessionUuid(`│  Session:  ${uuid}  │`)).toBe(uuid);
    expect(parseCodexSessionUuid("Session: unavailable")).toBeNull();
    expect(
      parseCodexSessionUuid(`Session: ${uuid}\nSession: 019f5acf-ba87-7553-872c-41572e6d0c49`)
    ).toBeNull();
  });

  it("accepts the ANSI SGR sequence emitted by codex v0.141.0 /status", () => {
    expect(
      parseCodexSessionUuid(
        "│  Session:                            \x1b[0m\x1b[39m\x1b[49m019f68f4-3ee4-75b2-8318-ac97fd9717f0\x1b[2m                      │"
      )
    ).toBe("019f68f4-3ee4-75b2-8318-ac97fd9717f0");
  });

  it("atomically persists and validates a 0600 marker", async () => {
    const io = makeIo();
    const neutralDir = "/data/cli-auth/chat/user-1";

    await persistCodexSessionIdentity(io, neutralDir, uuid);

    const marker = `${neutralDir}/${CODEX_IDENTITY_FILENAME}`;
    expect(io.writeFile).toHaveBeenCalledWith(`${marker}.tmp`, `${uuid}\n`);
    expect(io.run.mock.calls).toContainEqual(["chmod", ["600", `${marker}.tmp`]]);
    expect(io.run.mock.calls).toContainEqual(["mv", ["-f", `${marker}.tmp`, marker]]);

    io.readFile.mockResolvedValue(`${uuid}\n`);
    await expect(readCodexSessionIdentity(io, neutralDir)).resolves.toBe(uuid);
    io.readFile.mockResolvedValue("../../shared-root\n");
    await expect(readCodexSessionIdentity(io, neutralDir)).resolves.toBeNull();
  });
});

describe("purgeGeminiConversation", () => {
  const neutralDir = "/data/cli-auth/chat/user-1";

  it("reports failure rather than success when a state directory cannot be removed", async () => {
    const io = makeIo();
    io.readFile.mockResolvedValue(JSON.stringify({ projects: { [neutralDir]: "user-1" } }));
    io.run.mockImplementation(async (cmd: string, args: string[]) => ({
      code: cmd === "rm" && args.includes("/host-home/.gemini/history/user-1") ? 1 : 0,
      stdout: "",
      stderr: ""
    }));

    await expect(purgeGeminiConversation(io, neutralDir, "/host-home")).resolves.toBe(false);
    // The registry pointer must survive a failed removal, or the leftover becomes unfindable.
    expect(io.writeFile).not.toHaveBeenCalled();
  });

  it("keeps the retry marker when the CLI registry has no entry for this folder", async () => {
    const io = makeIo();
    io.readFile.mockResolvedValue(JSON.stringify({ projects: { "/some/other/folder": "other" } }));

    await expect(purgeGeminiConversation(io, neutralDir, "/host-home")).resolves.toBe(false);

    expect(io.writeFile).not.toHaveBeenCalled();
    expect(JSON.stringify(io.run.mock.calls)).not.toContain("/host-home/.gemini/tmp/");
  });

  it("refuses to act on a registry it cannot read as the expected shape", async () => {
    const io = makeIo();
    io.readFile.mockResolvedValue("this is not json");

    await expect(purgeGeminiConversation(io, neutralDir, "/host-home")).resolves.toBe(false);
  });
});

describe("parseGeminiProjectShortId", () => {
  const neutralDir = "/data/cli-auth/chat/user-1";

  it("reads the short id out of the registry and rejects anything path-shaped", () => {
    expect(
      parseGeminiProjectShortId(
        JSON.stringify({ projects: { [neutralDir]: "user-1" } }),
        neutralDir
      )
    ).toBe("user-1");
    expect(
      parseGeminiProjectShortId(
        JSON.stringify({ projects: { [neutralDir]: "../../escape" } }),
        neutralDir
      )
    ).toBeNull();
    expect(parseGeminiProjectShortId(JSON.stringify({ projects: {} }), neutralDir)).toBeNull();
    expect(parseGeminiProjectShortId("not json", neutralDir)).toBeNull();
  });
});

describe("Gemini session identity", () => {
  const uuid = "e099f770-a55c-432f-a9be-8cf254fd2d54";
  const neutralDir = "/data/cli-auth/chat/user-1";

  it("atomically persists a 0600 marker and reads back only a validated one", async () => {
    const io = makeIo();

    await persistGeminiSessionIdentity(io, neutralDir, uuid);

    const marker = `${neutralDir}/${GEMINI_IDENTITY_FILENAME}`;
    expect(io.writeFile).toHaveBeenCalledWith(`${marker}.tmp`, `${uuid}\n`);
    expect(io.run.mock.calls).toContainEqual(["chmod", ["600", `${marker}.tmp`]]);
    expect(io.run.mock.calls).toContainEqual(["mv", ["-f", `${marker}.tmp`, marker]]);

    io.readFile.mockResolvedValue(`${uuid}\n`);
    await expect(readGeminiSessionIdentity(io, neutralDir)).resolves.toBe(uuid);
    io.readFile.mockResolvedValue("../../shared-root\n");
    await expect(readGeminiSessionIdentity(io, neutralDir)).resolves.toBeNull();
  });

  it("refuses to write a marker that is not a session id", async () => {
    const io = makeIo();

    await expect(persistGeminiSessionIdentity(io, neutralDir, "../escape")).rejects.toThrow();

    expect(io.writeFile).not.toHaveBeenCalled();
  });

  it.each(["chmod", "mv"])("removes the temporary marker when %s fails", async (failedCmd) => {
    const io = makeIo();
    io.run.mockImplementation(async (cmd: string) => ({
      code: cmd === failedCmd ? 1 : 0,
      stdout: "",
      stderr: ""
    }));

    await expect(persistGeminiSessionIdentity(io, neutralDir, uuid)).rejects.toThrow();

    expect(io.run.mock.calls).toContainEqual([
      "rm",
      ["-f", `${neutralDir}/${GEMINI_IDENTITY_FILENAME}.tmp`]
    ]);
  });
});
