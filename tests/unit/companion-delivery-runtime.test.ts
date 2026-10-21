import { describe, expect, it, vi } from "vitest";
import type { DataContextRunner } from "@moss/db";
import type { PgBoss } from "@moss/jobs";
import { createCompanionDeliveryRuntime } from "../../apps/api/src/companion-delivery-runtime.js";

function fixture() {
  const recording = { start: vi.fn(async () => {}), close: vi.fn(async () => {}) };
  const voice = { start: vi.fn(async () => {}), close: vi.fn(async () => {}) };
  const runtime = createCompanionDeliveryRuntime(
    {
      workerConnectionString: "unused",
      boss: {} as PgBoss,
      dataContext: {} as DataContextRunner,
      resolveActiveModules: async () => []
    },
    { recordingImportWorker: recording, voiceRequestWorker: voice }
  );
  return { runtime, recording, voice };
}

describe("API companion consumers", () => {
  it("starts both injected consumers and drains both on close", async () => {
    const { runtime, recording, voice } = fixture();
    await runtime.start();
    await runtime.close();
    expect(recording.start).toHaveBeenCalledTimes(1);
    expect(voice.start).toHaveBeenCalledTimes(1);
    expect(recording.close).toHaveBeenCalledTimes(1);
    expect(voice.close).toHaveBeenCalledTimes(1);
  });
  it("closes both consumers when voice startup fails after recording starts", async () => {
    const { runtime, recording, voice } = fixture();
    voice.start.mockRejectedValueOnce(new Error("voice unavailable"));
    await expect(runtime.start()).rejects.toThrow("voice unavailable");
    expect(recording.close).toHaveBeenCalledTimes(1);
    expect(voice.close).toHaveBeenCalledTimes(1);
  });
  it("closes both after an early recording startup failure", async () => {
    const { runtime, recording, voice } = fixture();
    recording.start.mockRejectedValueOnce(new Error("recording unavailable"));
    await expect(runtime.start()).rejects.toThrow("recording unavailable");
    expect(voice.start).not.toHaveBeenCalled();
    expect(recording.close).toHaveBeenCalledTimes(1);
    expect(voice.close).toHaveBeenCalledTimes(1);
  });
  it("still drains voice work if the recording consumer fails to close", async () => {
    const { runtime, recording, voice } = fixture();
    recording.close.mockRejectedValueOnce(new Error("recording close failed"));
    await expect(runtime.close()).rejects.toThrow("Companion delivery shutdown failed");
    expect(voice.close).toHaveBeenCalledTimes(1);
  });
});
