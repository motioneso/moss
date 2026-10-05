import { createHash, randomBytes } from "node:crypto";
import { setTimeout } from "node:timers/promises";
import { expect, type Page } from "@playwright/test";
import type {
  MeetingCaptureInventory,
  MeetingCaptureObserved,
  MeetingCaptureState,
  RedeemPairAttemptResponse
} from "@moss/shared";

export const CAPTURE_DEVICE_NAME = "Synthetic capture UAT Mac";
export const CAPTURE_INVENTORY: MeetingCaptureInventory = {
  microphones: [
    { deviceId: "synthetic-device", sourceId: "synthetic-mic", label: "Generated PCM microphone" }
  ],
  applications: [],
  computerAudio: { available: false, excludedProcessTreeIds: [] },
  microphonePermission: "granted",
  systemAudioPermission: "unknown"
};
export async function nativePost(
  baseURL: string,
  path: string,
  credential: string | null,
  body: unknown,
  signal?: AbortSignal
) {
  return fetch(`${baseURL}${path}`, {
    method: "POST",
    headers: {
      "content-type": "application/json",
      ...(credential ? { authorization: `Bearer ${credential}` } : {})
    },
    body: JSON.stringify(body),
    signal
  });
}
/** Isolated test identity, paired through public APIs. Never reads a host login or captures audio. */
export async function pairCaptureFixture(
  page: Page,
  baseURL: string
): Promise<RedeemPairAttemptResponse> {
  const verifier = randomBytes(32).toString("base64url");
  const paired = await nativePost(baseURL, "/api/companion/pair", null, {
    deviceName: CAPTURE_DEVICE_NAME,
    platform: "macos",
    appVersion: "uat",
    osVersion: "synthetic",
    verifierHash: createHash("sha256").update(verifier).digest("base64url")
  });
  expect(paired.status).toBe(200);
  const attempt = (await paired.json()) as { attemptId: string; approvalPath: string };
  const code = new URLSearchParams(new URL(attempt.approvalPath, baseURL).hash.slice(1)).get(
    "code"
  );
  expect(code).toBeTruthy();
  const approved = await page.evaluate(async (code) => {
    const result = await fetch("/api/companion/pair/decide", {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ code, decision: "approve" })
    });
    return result.status;
  }, code);
  expect(approved).toBe(200);
  const redeemed = await nativePost(baseURL, "/api/companion/pair/redeem", null, {
    attemptId: attempt.attemptId,
    verifier
  });
  expect(redeemed.status).toBe(200);
  return redeemed.json() as Promise<RedeemPairAttemptResponse>;
}

/** Reports generated inventory; acknowledgments change only when the spec explicitly requests it. */
export function startCaptureNativeFixture(
  baseURL: string,
  credential: string,
  meetingId: string,
  grantId: string
) {
  let observed: MeetingCaptureObserved = { generation: 0, phase: "idle" };
  let capture: MeetingCaptureState | null = null;
  let lastStatus: number | null = null;
  let failure: unknown;
  const abort = new AbortController();
  const done = (async () => {
    try {
      while (!abort.signal.aborted) {
        const result = await nativePost(
          baseURL,
          "/api/meetings/capture/status",
          credential,
          { meetingId, grantId, inventory: CAPTURE_INVENTORY, observed },
          abort.signal
        );
        lastStatus = result.status;
        if (result.status === 401) return;
        if (!result.ok) throw new Error(`Synthetic native status rejected: ${result.status}`);
        capture = ((await result.json()) as { capture: MeetingCaptureState }).capture;
        await setTimeout(250, undefined, { signal: abort.signal });
      }
    } catch (error) {
      if (!abort.signal.aborted) failure = error;
    }
  })();
  return {
    acknowledge: (state: MeetingCaptureState, phase: MeetingCaptureObserved["phase"]) => {
      observed = { generation: state.generation, phase };
    },
    latest: () => {
      if (failure) throw failure;
      return capture;
    },
    status: () => {
      if (failure) throw failure;
      return lastStatus;
    },
    close: async () => {
      abort.abort();
      await done;
    }
  };
}
