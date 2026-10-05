import type { PgBoss } from "pg-boss";
import { describe, expect, it, vi } from "vitest";
import { enqueueVaultIngestNudge, VAULT_INGEST_NUDGE_QUEUE } from "@moss/memory";

const payload = {
  actorUserId: "11111111-1111-4111-8111-111111111111",
  sourcePath: "notes/generated/example/v1.md",
  op: "upsert" as const
};

describe("acknowledged private-vault enqueue", () => {
  it("reports queued only for a returned job ID and sends metadata only", async () => {
    const send = vi.fn().mockResolvedValue("job-id");
    expect(await enqueueVaultIngestNudge({ send } as unknown as PgBoss, payload)).toEqual({
      status: "queued",
      jobId: "job-id"
    });
    expect(send).toHaveBeenCalledWith(VAULT_INGEST_NUDGE_QUEUE, payload);
  });
  it.each([null, undefined, ""])("does not claim acknowledgement for %s", async (result) => {
    expect(
      await enqueueVaultIngestNudge(
        { send: vi.fn().mockResolvedValue(result) } as unknown as PgBoss,
        payload
      )
    ).toEqual({ status: "delayed" });
  });
  it("passes stable bucket-dedup options and does not claim a suppressed job was queued", async () => {
    const send = vi.fn().mockResolvedValueOnce("job-id").mockResolvedValueOnce(null);
    const boss = { send } as unknown as PgBoss;
    const options = { deduplicationKey: "a".repeat(64) };
    expect(await enqueueVaultIngestNudge(boss, payload, options)).toEqual({
      status: "queued",
      jobId: "job-id"
    });
    expect(send).toHaveBeenCalledWith(VAULT_INGEST_NUDGE_QUEUE, payload, {
      singletonKey: options.deduplicationKey,
      singletonSeconds: 300
    });
    expect(await enqueueVaultIngestNudge(boss, payload, options)).toEqual({ status: "delayed" });
  });
  it("rejects arbitrary content as a deduplication key before enqueue", async () => {
    const send = vi.fn();
    await expect(
      enqueueVaultIngestNudge({ send } as unknown as PgBoss, payload, {
        deduplicationKey: "note content"
      })
    ).rejects.toThrow("SHA256");
    expect(send).not.toHaveBeenCalled();
  });
  it("returns a safe delayed result on queue rejection", async () => {
    expect(
      await enqueueVaultIngestNudge(
        {
          send: vi.fn().mockRejectedValue(new Error("private backend details"))
        } as unknown as PgBoss,
        payload
      )
    ).toEqual({ status: "delayed" });
  });
});
