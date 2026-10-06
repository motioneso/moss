import { createHash, randomBytes, randomUUID } from "node:crypto";
import { setTimeout } from "node:timers/promises";
import { expect, type Page } from "@playwright/test";
import type {
  MeetingCaptureInventory,
  MeetingCaptureClaimResult,
  MeetingCaptureCommandsResult,
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
  signal?: AbortSignal,
  recordingProof?: string
) {
  return fetch(`${baseURL}${path}`, {
    method: "POST",
    headers: {
      "content-type": "application/json",
      ...(credential ? { authorization: `Bearer ${credential}` } : {}),
      ...(recordingProof ? { "x-moss-recording-proof": recordingProof } : {})
    },
    body: JSON.stringify(body),
    signal: AbortSignal.any([
      ...(signal ? [signal] : []),
      AbortSignal.timeout(path.endsWith("/audio") ? 45000 : 12000)
    ])
  });
}
/** Isolated test identity, paired through public APIs. Never reads a host login or captures audio. */
export async function pairCaptureFixture(
  page: Page,
  baseURL: string
): Promise<RedeemPairAttemptResponse & { recordingProof: string }> {
  const verifier = randomBytes(32).toString("base64url");
  const recordingProof = randomBytes(32).toString("base64url");
  const paired = await nativePost(baseURL, "/api/companion/pair", null, {
    deviceName: CAPTURE_DEVICE_NAME,
    platform: "macos",
    appVersion: "uat",
    osVersion: "synthetic",
    verifierHash: createHash("sha256").update(verifier).digest("base64url"),
    recordingProofHash: createHash("sha256").update(recordingProof).digest("hex"),
    recordingPolicyVersion: 1
  });
  expect(paired.status).toBe(200);
  const attempt = (await paired.json()) as { attemptId: string; approvalPath: string };
  const code = new URLSearchParams(new URL(attempt.approvalPath, baseURL).hash.slice(1)).get(
    "code"
  );
  expect(code).toBeTruthy();
  await page.goto(new URL(attempt.approvalPath, baseURL).toString());
  await expect(page.getByRole("heading", { name: "Do you recognise this Mac?" })).toBeVisible();
  await page.getByRole("button", { name: "Approve" }).click();
  await expect(page.getByText(/connected/i).first()).toBeVisible();
  const redeemed = await nativePost(baseURL, "/api/companion/pair/redeem", null, {
    attemptId: attempt.attemptId,
    verifier
  });
  expect(redeemed.status).toBe(200);
  return { ...((await redeemed.json()) as RedeemPairAttemptResponse), recordingProof };
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
  let finalized = false;
  let recordedDurationMs = 0;
  let lastRecordingAt: number | null = null;
  const abort = new AbortController();
  const done = (async () => {
    try {
      while (!abort.signal.aborted) {
        const result = await nativePost(
          baseURL,
          "/api/meetings/capture/status",
          credential,
          {
            meetingId,
            grantId,
            inventory: CAPTURE_INVENTORY,
            observed,
            finalized,
            recordedDurationMs: Math.floor(
              recordedDurationMs +
                (lastRecordingAt === null ? 0 : performance.now() - lastRecordingAt)
            )
          },
          abort.signal
        );
        lastStatus = result.status;
        if (result.status === 401) return;
        if (result.status === 429 || result.status === 503) {
          const retry = result.headers.get("retry-after");
          const seconds = retry === null ? NaN : Number(retry);
          const delay = Number.isFinite(seconds)
            ? Math.max(0, seconds * 1000)
            : retry
              ? Math.max(0, Date.parse(retry) - Date.now())
              : 2000;
          if (!Number.isFinite(delay) || delay > 60000)
            throw new Error("Synthetic status backoff exceeds the bounded fixture window");
          await setTimeout(Math.max(2000, delay), undefined, { signal: abort.signal });
          continue;
        }
        if (!result.ok) throw new Error(`Synthetic native status rejected: ${result.status}`);
        capture = ((await result.json()) as { capture: MeetingCaptureState }).capture;
        if (capture.finalization === "complete") return;
        await setTimeout(2000, undefined, { signal: abort.signal });
      }
    } catch (error) {
      if (!abort.signal.aborted) failure = error;
    }
  })();
  return {
    acknowledge: (state: MeetingCaptureState, phase: MeetingCaptureObserved["phase"]) => {
      if (lastRecordingAt !== null) {
        recordedDurationMs += performance.now() - lastRecordingAt;
        lastRecordingAt = null;
      }
      if (phase === "recording") lastRecordingAt = performance.now();
      observed = { generation: state.generation, phase };
    },
    finalize: () => {
      finalized = true;
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

/** Native proof stays in this fixture process; public connection routes receive only their specified proofs. */
export async function connectCaptureFixture(
  baseURL: string,
  paired: RedeemPairAttemptResponse & { recordingProof: string }
) {
  const connectionId = randomUUID(),
    verifier = randomBytes(32).toString("base64url");
  const register = async () => {
    const response = await nativePost(
      baseURL,
      "/api/meetings/capture/connection",
      paired.credential,
      {
        connectionId,
        verifierHash: createHash("sha256").update(verifier).digest("hex"),
        inventory: CAPTURE_INVENTORY
      },
      undefined,
      paired.recordingProof
    );
    expect(response.status).toBe(200);
    return response.json() as Promise<{ connectionId: string; revision: number }>;
  };
  await register();
  const commands = new Map<string, NonNullable<MeetingCaptureCommandsResult["command"]>>();
  const credentials = new Map<string, string>();
  return {
    connectionId,
    refresh: register,
    claim: async (meetingId?: string) => {
      await register();
      const polled = await nativePost(
        baseURL,
        "/api/meetings/capture/commands",
        paired.credential,
        { connectionId, verifier },
        undefined,
        paired.recordingProof
      );
      expect(polled.status).toBe(200);
      const fresh = ((await polled.json()) as MeetingCaptureCommandsResult).command;
      if (fresh) commands.set(fresh.meetingId, fresh);
      const pending = meetingId ? commands.get(meetingId) : fresh;
      if (!pending) throw new Error("No matching explicit synthetic Start");
      const credential =
        credentials.get(pending.grantId) ??
        `mm1_${pending.ownerUserId}.${pending.grantId}.${randomBytes(32).toString("base64url")}`;
      credentials.set(pending.grantId, credential);
      const response = await nativePost(
        baseURL,
        "/api/meetings/capture/claim",
        paired.credential,
        {
          connectionId,
          verifier,
          grantId: pending.grantId,
          credentialHash: createHash("sha256").update(credential).digest("hex")
        },
        undefined,
        paired.recordingProof
      );
      expect(response.status).toBe(200);
      const claimed = (await response.json()) as MeetingCaptureClaimResult;
      return { ...claimed, credential };
    }
  };
}
