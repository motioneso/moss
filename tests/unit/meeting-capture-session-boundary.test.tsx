// @vitest-environment jsdom
import { act } from "react";
import { createRoot, type Root } from "react-dom/client";
import { QueryClient, QueryClientProvider } from "@tanstack/react-query";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import type { MeetingCaptureBrowserStatus, MeetingCaptureState } from "@moss/shared";
import { captureKeys } from "../../packages/meetings/src/web/capture-client.js";
import {
  useCaptureSession,
  type CaptureSession
} from "../../packages/meetings/src/web/capture-session.js";

let client: QueryClient;
let root: Root;
let host: HTMLDivElement;
let session: ReturnType<typeof useCaptureSession>;
const response = (value: unknown) => new Response(JSON.stringify(value));
const capture = (grantId: string): MeetingCaptureState => ({
  grantId,
  deviceId: "mac",
  deviceName: "Mac",
  generation: 1,
  epoch: 1,
  desired: "recording",
  selection: { mode: "microphone-only", microphone: { deviceId: "mic", sourceId: "input" } },
  epochStartMs: 0,
  epochEndMs: null,
  stopCutoffMs: null,
  finalizationDeadline: null,
  expiresAt: new Date(Date.now() + 60000).toISOString(),
  serverTime: new Date().toISOString(),
  elapsedMs: 0,
  inventory: null,
  observed: { phase: "recording", generation: 1 },
  lastSeenAt: new Date().toISOString(),
  gaps: [],
  gapLimitReached: false
});
const status = (grantId: string): MeetingCaptureBrowserStatus => ({
  capture: capture(grantId),
  pendingLinks: [],
  processingReady: true
});
const settle = () =>
  act(async () => {
    await new Promise((resolve) => setTimeout(resolve, 10));
  });
function Session() {
  session = useCaptureSession("meeting");
  return null;
}
beforeEach(async () => {
  vi.stubGlobal("IS_REACT_ACT_ENVIRONMENT", true);
  client = new QueryClient({ defaultOptions: { queries: { retry: false, gcTime: Infinity } } });
  host = document.createElement("div");
  document.body.appendChild(host);
  root = createRoot(host);
  await act(async () =>
    root.render(
      <QueryClientProvider client={client}>
        <Session />
      </QueryClientProvider>
    )
  );
});
afterEach(async () => {
  await act(async () => root.unmount());
  client.clear();
  host.remove();
  vi.restoreAllMocks();
  vi.unstubAllGlobals();
});

async function resetSession(unmounted: boolean, afterReset?: () => void) {
  if (unmounted) await act(async () => root.unmount());
  await act(async () => {
    await client.resetQueries();
    afterReset?.();
  });
  if (unmounted) {
    root = createRoot(host);
    await act(async () =>
      root.render(
        <QueryClientProvider client={client}>
          <Session />
        </QueryClientProvider>
      )
    );
  }
  await settle();
}

describe("capture command session boundaries", () => {
  it("retains an authorized pending command across normal navigation", async () => {
    let release!: (value: Response) => void;
    vi.stubGlobal(
      "fetch",
      vi.fn(
        () =>
          new Promise<Response>((resolve) => {
            release = resolve;
          })
      )
    );
    const pending = session.control({
      grantId: "old-grant",
      command: "pause",
      expectedGeneration: 1
    });
    await settle();
    await act(async () => root.unmount());
    await act(async () => {
      release(response({ capture: { ...capture("old-grant"), desired: "paused", generation: 2 } }));
      await pending;
    });
    expect(
      client.getQueryData<MeetingCaptureBrowserStatus>(captureKeys.status("meeting"))?.capture
        ?.desired
    ).toBe("paused");
    root = createRoot(host);
    await act(async () =>
      root.render(
        <QueryClientProvider client={client}>
          <Session />
        </QueryClientProvider>
      )
    );
    expect(session.state.operation).toBeNull();
  });

  it.each([false, true])(
    "does not reconcile or dispatch an old Stop after auth reset (unmounted=%s)",
    async (unmounted) => {
      let release!: () => void;
      vi.spyOn(client, "cancelQueries").mockImplementationOnce(
        () =>
          new Promise<void>((resolve) => {
            release = resolve;
          })
      );
      const transport = vi.fn(async () => response(status("old-grant")));
      vi.stubGlobal("fetch", transport);
      const old = session;
      const pending = old.stop();
      await resetSession(unmounted);
      await act(async () => {
        release();
        await pending;
      });
      expect(transport).not.toHaveBeenCalled();
      expect(client.getQueryData(captureKeys.active)).toBeUndefined();
      expect(session.state.error).toBeNull();
    }
  );
  it.each([false, true])(
    "lets a new session Stop proceed while the old Stop waits (unmounted=%s)",
    async (unmounted) => {
      let release!: () => void;
      vi.spyOn(client, "cancelQueries").mockImplementationOnce(
        () =>
          new Promise<void>((resolve) => {
            release = resolve;
          })
      );
      const transport = vi.fn(async (_path: string, options?: RequestInit) =>
        response({
          capture: {
            ...capture(String(JSON.parse(String(options?.body)).grantId)),
            desired: "stopped",
            generation: 2
          }
        })
      );
      vi.stubGlobal("fetch", transport);
      const pending = session.stop();
      await resetSession(unmounted, () =>
        client.setQueryData(captureKeys.status("meeting"), status("new-grant"))
      );
      await act(async () => {
        await session.stop();
      });
      expect(transport).toHaveBeenCalledTimes(1);
      expect(JSON.parse(String(transport.mock.calls[0]?.[1]?.body))).toMatchObject({
        grantId: "new-grant",
        command: "stop"
      });
      await act(async () => {
        release();
        await pending;
      });
      expect(transport).toHaveBeenCalledTimes(1);
    }
  );
  it.each([false, true])(
    "ignores an old Stop reconciliation after auth reset (unmounted=%s)",
    async (unmounted) => {
      let release!: (value: Response) => void;
      const transport = vi.fn(
        () =>
          new Promise<Response>((resolve) => {
            release = resolve;
          })
      );
      vi.stubGlobal("fetch", transport);
      const pending = session.stop();
      await settle();
      expect(transport).toHaveBeenCalledTimes(1);
      await resetSession(unmounted, () =>
        client.setQueryData(captureKeys.status("meeting"), status("new-grant"))
      );
      await act(async () => {
        release(response(status("old-grant")));
        await pending;
      });
      expect(transport).toHaveBeenCalledTimes(1);
      expect(
        client.getQueryData<MeetingCaptureBrowserStatus>(captureKeys.status("meeting"))?.capture
          ?.grantId
      ).toBe("new-grant");
      expect(session.state.error).toBeNull();
    }
  );
  it.each([false, true])(
    "fences a late receipt with reused metadata after reset (unmounted=%s)",
    async (unmounted) => {
      let release!: (value: Response) => void;
      const transport = vi.fn(
        () =>
          new Promise<Response>((resolve) => {
            release = resolve;
          })
      );
      vi.stubGlobal("fetch", transport);
      const pending = session.control({
        grantId: "old-grant",
        command: "pause",
        expectedGeneration: 1
      });
      await settle();
      const previous = client.getQueryData<CaptureSession>(captureKeys.session("meeting"))!;
      await resetSession(unmounted, () =>
        client.setQueryData(captureKeys.session("meeting"), {
          ...previous,
          error: "New session state"
        })
      );
      await act(async () => {
        release(
          response({ capture: { ...capture("old-grant"), desired: "paused", generation: 2 } })
        );
        await pending;
      });
      expect(client.getQueryData<CaptureSession>(captureKeys.session("meeting"))?.error).toBe(
        "New session state"
      );
      expect(client.getQueryData(captureKeys.status("meeting"))).toBeUndefined();
    }
  );
});
