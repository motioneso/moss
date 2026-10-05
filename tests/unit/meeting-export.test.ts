import { createHash } from "node:crypto";
import { describe, expect, it, vi } from "vitest";
import Fastify from "fastify";
import { HttpError } from "@moss/module-sdk";
import type { DataContextDb, DataContextRunner } from "@moss/db";
import type { MeetingPrivateExportPort } from "@moss/meetings";
import type { MeetingExportReceipt, MeetingOutputArtifact } from "@moss/shared";
import { MeetingExportService } from "../../packages/meetings/src/export-service.js";
import type { MeetingExportsRepository } from "../../packages/meetings/src/export-repository.js";
import { MeetingOutputError } from "../../packages/meetings/src/output-repository.js";
import { renderMeetingExport } from "../../packages/meetings/src/export-render.js";
import { registerMeetingExportRoutes } from "../../packages/meetings/src/export-routes.js";

const meetingId = "a0000000-0000-4000-8000-000000000001";
const actor = { actorUserId: "b0000000-0000-4000-8000-000000000001" };
const requestKey = "c0000000-0000-4000-8000-000000000001";
const retryKey = "c0000000-0000-4000-8000-000000000002";
function artifact(): MeetingOutputArtifact {
  return {
    id: "d0000000-0000-4000-8000-000000000001",
    meetingId,
    version: 1,
    inputs: {
      meetingId,
      transcript: null,
      personalNotes: "PRIVATE SOURCE EXCERPT",
      notesRevision: 3
    },
    templateId: "general",
    templateVersion: 1,
    modelRoute: "synthetic",
    origin: "manual",
    stale: false,
    createdAt: "2026-10-04T00:00:00.000Z",
    content: {
      overview: "My edited overview",
      decisions: [
        {
          text: "Reviewed decision",
          evidence: [
            {
              kind: "personal-note",
              meetingId,
              notesRevision: 3,
              startCharacter: 0,
              endCharacter: 5
            }
          ]
        }
      ],
      openQuestions: [],
      actions: [],
      warnings: []
    }
  };
}
function setup() {
  let receipt: MeetingExportReceipt | null = null;
  const requests = new Map<string, { version: number; result: MeetingExportReceipt | null }>();
  const events: string[] = [];
  let file: string | null = null;
  let failCommit = false;
  const content = renderMeetingExport(artifact());
  const hash = createHash("sha256").update(content).digest("hex");
  const repository: Pick<
    MeetingExportsRepository,
    "lock" | "list" | "content" | "request" | "reserve" | "receipt" | "intend" | "finish"
  > = {
    lock: vi.fn(async () => {}),
    list: vi.fn(async () => (receipt ? [receipt] : [])),
    content: vi.fn(async () => content),
    request: async (_db, _id, key, version) => {
      const item = requests.get(key);
      if (item && item.version !== version)
        throw new MeetingOutputError("meeting_export_request_conflict");
      return item?.result ?? null;
    },
    reserve: async (_db, _id, key, version) => {
      if (!requests.has(key)) requests.set(key, { version, result: null });
    },
    receipt: async () => receipt,
    intend: async () => {
      events.push("intent");
      receipt ??= {
        meetingId,
        artifactVersion: 1,
        destination: "private-vault",
        audience: "owner",
        idempotencyKey: `meeting:${meetingId}:artifact:1:private-vault`,
        contentHash: hash,
        noteReference: null,
        writeStatus: "pending",
        indexStatus: "not-requested",
        indexJobId: null,
        errorCode: null,
        createdAt: "2026-10-04T00:00:00.000Z",
        updatedAt: "2026-10-04T00:00:00.000Z"
      };
    },
    finish: async (_db, key, value) => {
      if (failCommit) throw new Error("synthetic receipt failure");
      receipt = value;
      requests.set(key, { version: value.artifactVersion, result: value });
    }
  };
  const dataContext: Pick<DataContextRunner, "withDataContext"> = {
    withDataContext: async (_access, callback) => {
      const value = await callback(undefined as unknown as DataContextDb);
      events.push("commit");
      return value;
    }
  };
  const observation = () => ({
    destination: "private-vault" as const,
    audience: "owner" as const,
    noteReference: `notes/generated/${meetingId}/v1.md`,
    contentHash: hash
  });
  const notes: MeetingPrivateExportPort = {
    inspect: vi.fn<MeetingPrivateExportPort["inspect"]>(async () => ({
      ...observation(),
      status: file === null ? "missing" : file === content ? "unchanged" : "conflict"
    })),
    createOrInspect: vi.fn<MeetingPrivateExportPort["createOrInspect"]>(async () => {
      events.push("write");
      file = content;
      return { ...observation(), status: "written" };
    }),
    queueIndex: vi.fn<MeetingPrivateExportPort["queueIndex"]>(async () => {
      events.push("queue");
      return { status: "queued", jobId: "synthetic-job" };
    })
  };
  const service = new MeetingExportService(dataContext, notes, repository);
  return {
    service,
    notes,
    repository,
    events,
    content,
    observation,
    get receipt() {
      return receipt;
    },
    setFile(value: string | null) {
      file = value;
    },
    setFailCommit(value: boolean) {
      failCommit = value;
    }
  };
}

describe("explicit meeting private-vault exports", () => {
  it("commits intent before write, records independent write and queue outcomes, replays request", async () => {
    const s = setup();
    const receipt = await s.service.save(actor, meetingId, { requestKey, artifactVersion: 1 });
    expect(s.events).toEqual(["intent", "commit", "write", "queue", "commit"]);
    expect(receipt).toMatchObject({
      writeStatus: "saved",
      indexStatus: "queued",
      audience: "owner",
      indexJobId: "synthetic-job"
    });
    expect(await s.service.save(actor, meetingId, { requestKey, artifactVersion: 1 })).toEqual(
      receipt
    );
    expect(s.notes.createOrInspect).toHaveBeenCalledTimes(1);
    expect(s.notes.queueIndex).toHaveBeenCalledTimes(1);
  });
  it("an unchanged version under a new key does not write or queue twice", async () => {
    const s = setup();
    await s.service.save(actor, meetingId, { requestKey, artifactVersion: 1 });
    await s.service.save(actor, meetingId, { requestKey: retryKey, artifactVersion: 1 });
    expect(s.notes.createOrInspect).toHaveBeenCalledTimes(1);
    expect(s.notes.queueIndex).toHaveBeenCalledTimes(1);
  });
  it("retries only the missing index stage with a new request key", async () => {
    const s = setup();
    vi.mocked(s.notes.queueIndex).mockResolvedValueOnce({ status: "delayed" });
    const first = await s.service.save(actor, meetingId, { requestKey, artifactVersion: 1 });
    expect(first).toMatchObject({
      writeStatus: "saved",
      indexStatus: "delayed",
      errorCode: "meeting_index_delayed"
    });
    expect(await s.service.save(actor, meetingId, { requestKey, artifactVersion: 1 })).toEqual(
      first
    );
    expect(
      await s.service.save(actor, meetingId, { requestKey: retryKey, artifactVersion: 1 })
    ).toMatchObject({ writeStatus: "saved", indexStatus: "queued" });
    expect(s.notes.createOrInspect).toHaveBeenCalledTimes(1);
    expect(s.notes.queueIndex).toHaveBeenCalledTimes(2);
  });
  it("reconciles write-then-throw without a second filesystem write", async () => {
    const s = setup();
    vi.mocked(s.notes.createOrInspect).mockImplementationOnce(async () => {
      s.setFile(s.content);
      throw new Error("secret filesystem path");
    });
    expect(
      await s.service.save(actor, meetingId, { requestKey, artifactVersion: 1 })
    ).toMatchObject({ writeStatus: "saved", indexStatus: "queued", errorCode: null });
    expect(s.notes.createOrInspect).toHaveBeenCalledTimes(1);
  });
  it("recovers a rolled-back final receipt by inspecting the durable intent and existing bytes", async () => {
    const s = setup();
    s.setFailCommit(true);
    await expect(
      s.service.save(actor, meetingId, { requestKey, artifactVersion: 1 })
    ).rejects.toThrow("synthetic receipt failure");
    expect(s.receipt?.writeStatus).toBe("pending");
    s.setFailCommit(false);
    expect(
      await s.service.save(actor, meetingId, { requestKey, artifactVersion: 1 })
    ).toMatchObject({ writeStatus: "saved" });
    expect(s.notes.createOrInspect).toHaveBeenCalledTimes(1);
  });
  it("preserves manual edits and does not enqueue conflicting content", async () => {
    const s = setup();
    s.setFile("manual additions");
    const result = await s.service.save(actor, meetingId, { requestKey, artifactVersion: 1 });
    expect(result).toMatchObject({
      writeStatus: "conflict",
      indexStatus: "conflict",
      errorCode: "meeting_vault_conflict"
    });
    expect(s.notes.createOrInspect).not.toHaveBeenCalled();
    expect(s.notes.queueIndex).not.toHaveBeenCalled();
  });
  it("does not recreate a previously saved copy deleted by the owner", async () => {
    const s = setup();
    await s.service.save(actor, meetingId, { requestKey, artifactVersion: 1 });
    s.setFile(null);
    expect(
      await s.service.save(actor, meetingId, { requestKey: retryKey, artifactVersion: 1 })
    ).toMatchObject({
      writeStatus: "saved",
      indexStatus: "queued",
      errorCode: "meeting_vault_conflict"
    });
    expect(s.notes.createOrInspect).toHaveBeenCalledTimes(1);
  });
  it("preserves confirmed saved status if the index recheck detects a manual edit", async () => {
    const s = setup();
    vi.mocked(s.notes.queueIndex).mockResolvedValueOnce({ status: "conflict" });
    expect(
      await s.service.save(actor, meetingId, { requestKey, artifactVersion: 1 })
    ).toMatchObject({
      writeStatus: "saved",
      indexStatus: "conflict",
      errorCode: "meeting_vault_conflict"
    });
  });
  it("sanitizes write errors and preserves an independently failed stage", async () => {
    const s = setup();
    vi.mocked(s.notes.createOrInspect).mockRejectedValueOnce(new Error("private path and content"));
    const result = await s.service.save(actor, meetingId, { requestKey, artifactVersion: 1 });
    expect(result).toMatchObject({
      writeStatus: "failed",
      indexStatus: "not-requested",
      errorCode: "meeting_vault_write_failed"
    });
    expect(JSON.stringify(result)).not.toContain("private path");
    expect(s.notes.queueIndex).not.toHaveBeenCalled();
  });
  it("rejects a key reused for another artifact before Notes access", async () => {
    const s = setup();
    await s.service.save(actor, meetingId, { requestKey, artifactVersion: 1 });
    await expect(
      s.service.save(actor, meetingId, { requestKey, artifactVersion: 2 })
    ).rejects.toThrow("meeting_export_request_conflict");
    expect(s.notes.inspect).toHaveBeenCalledTimes(1);
  });
  it("authorizes owner-visible meeting before any vault call", async () => {
    const s = setup();
    vi.mocked(s.repository.lock).mockRejectedValue(
      new MeetingOutputError("meeting_not_found", 404)
    );
    await expect(
      s.service.save(actor, meetingId, { requestKey, artifactVersion: 1 })
    ).rejects.toThrow("meeting_not_found");
    expect(s.notes.inspect).not.toHaveBeenCalled();
    expect(s.notes.createOrInspect).not.toHaveBeenCalled();
  });
});

describe("deterministic export rendering", () => {
  it("retains owner edits, input versions and exact references without source excerpts", () => {
    const result = renderMeetingExport(artifact());
    expect(result).toBe(renderMeetingExport(artifact()));
    expect(result).toContain("My edited overview");
    expect(result).toContain("personal notes revision 3");
    expect(result).toContain(`personal-note:${meetingId}@3:0-5`);
    expect(result).not.toContain("PRIVATE SOURCE EXCERPT");
  });
  it("escapes remote images, raw HTML, links and autolinks in untrusted fields", () => {
    const source = artifact();
    const malicious =
      "![tracking](https://example.test/a) <img src='https://example.test/b'> <https://example.test/c> [link](https://example.test/d)";
    const result = renderMeetingExport({
      ...source,
      content: { ...source.content, overview: malicious, warnings: [malicious] }
    });
    expect(result).not.toContain("![tracking]");
    expect(result).not.toContain("<img");
    expect(result).not.toContain("<https:");
    expect(result).not.toContain("[link](");
    expect(result).toContain("\\!\\[tracking\\]\\(https://example\\.test/a\\)");
    expect(result).toContain("&lt;img");
  });
});

describe("export route", () => {
  it("reading saved receipts never automatically exports", async () => {
    const app = Fastify();
    const s = setup();
    registerMeetingExportRoutes(app, {
      resolveAccessContext: async () => actor,
      exports: s.service
    });
    try {
      const response = await app.inject({
        method: "GET",
        url: `/api/meetings/records/${meetingId}/exports`
      });
      expect(response.statusCode).toBe(200);
      expect(response.json()).toEqual({ receipts: [] });
      expect(s.notes.inspect).not.toHaveBeenCalled();
      expect(s.notes.createOrInspect).not.toHaveBeenCalled();
    } finally {
      await app.close();
    }
  });
  it("rejects revoked sessions before reading or writing Notes", async () => {
    const app = Fastify();
    const s = setup();
    registerMeetingExportRoutes(app, {
      resolveAccessContext: async () => {
        throw new HttpError(401, "unauthorized");
      },
      exports: s.service
    });
    try {
      const response = await app.inject({
        method: "POST",
        url: `/api/meetings/records/${meetingId}/exports`,
        payload: { requestKey, artifactVersion: 1 }
      });
      expect(response.statusCode).toBe(401);
      expect(s.repository.lock).not.toHaveBeenCalled();
      expect(s.notes.createOrInspect).not.toHaveBeenCalled();
    } finally {
      await app.close();
    }
  });
  it("requires authenticated access, passes exact version, and validates the version", async () => {
    const app = Fastify();
    const s = setup();
    const resolveAccessContext = vi.fn(async () => actor);
    registerMeetingExportRoutes(app, { resolveAccessContext, exports: s.service });
    try {
      const response = await app.inject({
        method: "POST",
        url: `/api/meetings/records/${meetingId}/exports`,
        payload: { requestKey, artifactVersion: 1 }
      });
      expect(response.statusCode).toBe(200);
      expect(response.json().receipt.indexStatus).toBe("queued");
      const bad = await app.inject({
        method: "POST",
        url: `/api/meetings/records/${meetingId}/exports`,
        payload: { requestKey: retryKey, artifactVersion: 0 }
      });
      expect(bad.statusCode).toBe(400);
      expect(resolveAccessContext).toHaveBeenCalledTimes(1);
    } finally {
      await app.close();
    }
  });
});
