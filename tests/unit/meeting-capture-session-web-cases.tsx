import { act, type ReactNode } from "react";
import { createRoot, type Root } from "react-dom/client";
import type { QueryClient } from "@tanstack/react-query";
import { expect, it, vi, type Mock } from "vitest";
import type { MeetingCaptureState, MeetingRecord, MeetingCaptureBrowserStatus } from "@moss/shared";
import { CapturePanel } from "../../packages/meetings/src/web/capture-panel.js";
import { MeetingSetup } from "../../packages/meetings/src/web/meeting-setup.js";
import { meetingKeys } from "../../packages/meetings/src/web/client.js";
import { captureKeys } from "../../packages/meetings/src/web/capture-client.js";

type Call = { path: string; body: Record<string, unknown> | undefined };
type Transport = (path: string, options?: RequestInit) => Promise<Response>;
interface SessionHarness {
  readonly capture: (overrides?: Partial<MeetingCaptureState>) => MeetingCaptureState;
  readonly meeting: MeetingRecord;
  readonly json: (value: unknown, code?: number, headers?: HeadersInit) => Response;
  readonly transport: () => Mock<Transport>;
  readonly client: () => QueryClient;
  readonly host: () => HTMLDivElement;
  readonly root: () => Root;
  readonly setRoot: (root: Root) => void;
  readonly setCapture: (capture: MeetingCaptureState | null) => void;
  readonly getCapture: () => MeetingCaptureState | null;
  readonly calls: () => Call[];
  readonly mount: (view: ReactNode, path?: string) => Promise<void>;
  readonly click: (text: string) => Promise<void>;
  readonly button: (text: string) => HTMLButtonElement;
  readonly settle: () => Promise<void>;
}
/** Synthetic auth-reset coverage for creation and capture command lifetimes. */
export function registerCaptureSessionRegressions(h: SessionHarness) {
  const { capture, meeting, json, mount, button, settle } = h;
  it("does not restore a late created meeting across the actual resetQueries auth flow", async () => {
    let finish!: (value: Response) => void;
    const normal = h.transport().getMockImplementation()!;
    h.transport().mockImplementation((path, options) =>
      path === "/api/meetings/records"
        ? new Promise<Response>((resolve) => {
            finish = resolve;
          })
        : normal(path, options)
    );
    const onCreated = vi.fn();
    await mount(<MeetingSetup onCreated={onCreated} />);
    act(() => button("New meeting").click());
    await act(async () => {
      h.root().unmount();
      await h.client().resetQueries();
    });
    h.setRoot(createRoot(h.host()));
    await mount(<MeetingSetup onCreated={() => {}} />);
    await act(async () => finish(json({ meeting, created: true })));
    await settle();
    expect(onCreated).not.toHaveBeenCalled();
    expect(h.client().getQueryData(meetingKeys.record(meeting.id))).toBeUndefined();
    expect(h.client().getQueryData(["meetings", "setup-draft"])).toMatchObject({
      creating: false,
      request: null
    });
    expect(h.calls().some((call) => call.path.endsWith("/capture/start"))).toBe(false);
    expect(h.client().getQueryData(captureKeys.active)).toBeUndefined();
  });
  it("keeps a newer submission when an old Setup failure arrives after auth reset", async () => {
    const pending: ((value: Response) => void)[] = [];
    const normal = h.transport().getMockImplementation()!;
    h.transport().mockImplementation((path, options) =>
      path === "/api/meetings/records"
        ? new Promise<Response>((resolve) => {
            pending.push(resolve);
          })
        : normal(path, options)
    );
    await mount(<MeetingSetup onCreated={() => {}} />);
    act(() => button("New meeting").click());
    await act(async () => {
      h.root().unmount();
      await h.client().resetQueries();
    });
    h.setRoot(createRoot(h.host()));
    await mount(<MeetingSetup onCreated={() => {}} />);
    act(() => button("New meeting").click());
    expect(pending).toHaveLength(2);
    const key = ["meetings", "setup-draft"] as const;
    const newer = h.client().getQueryData(key);
    await act(async () => pending[0]!(json({ message: "Old rejected draft" }, 400)));
    await settle();
    expect(h.client().getQueryData(key)).toEqual(newer);
    expect(h.client().getQueryData(key)).toMatchObject({ creating: true, error: null });
    await act(async () => pending[1]!(json({ meeting, created: true })));
    await settle();
    expect(h.calls().filter((call) => call.path.endsWith("/capture/start"))).toHaveLength(0);
  });
  it("coalesces repeated Start recording clicks into one bound request", async () => {
    let finish!: (value: Response) => void;
    const normal = h.transport().getMockImplementation()!;
    h.transport().mockImplementation((path, options) => {
      if (path.endsWith("/capture/start")) {
        h.calls().push({ path, body: JSON.parse(String(options?.body)) });
        return new Promise<Response>((resolve) => {
          finish = resolve;
        });
      }
      return normal(path, options);
    });
    await mount(<CapturePanel meeting={meeting} onLiveChange={() => {}} />);
    act(() => {
      button("Start recording").click();
      button("Start recording").click();
    });
    await settle();
    expect(h.calls().filter((call) => call.path.endsWith("/capture/start"))).toHaveLength(1);
    await act(async () => finish(json({ capture: capture() })));
    await settle();
    expect(h.calls().filter((call) => call.path.endsWith("/capture/start"))).toHaveLength(1);
  });
  it("keeps Stop available while Resume retries an uncertain command", async () => {
    h.setCapture(
      capture({ desired: "paused", generation: 2, observed: { generation: 2, phase: "paused" } })
    );
    const normal = h.transport().getMockImplementation()!;
    h.transport().mockImplementation((path, options) => {
      const body = options?.body
        ? (JSON.parse(String(options.body)) as Record<string, unknown>)
        : undefined;
      if (path.endsWith("/capture/control") && body?.command === "record") {
        h.calls().push({ path, body });
        return Promise.resolve(json({ message: "Temporary failure" }, 503));
      }
      return normal(path, options);
    });
    await mount(<CapturePanel meeting={meeting} onLiveChange={() => {}} />);
    vi.useFakeTimers();
    act(() => button("Resume").click());
    await act(async () => vi.advanceTimersByTimeAsync(2000));
    const retries = h.calls().filter((call) => call.body?.command === "record");
    expect(retries).toHaveLength(3);
    expect(retries[1]!.body).toEqual(retries[0]!.body);
    expect(retries[2]!.body).toEqual(retries[0]!.body);
    expect(button("Retry capture command").disabled).toBe(false);
    expect(button("Stop and review").disabled).toBe(false);
    act(() => button("Stop and review").click());
    await act(async () => vi.advanceTimersByTimeAsync(50));
    expect(h.getCapture()?.desired).toBe("stopped");
    expect(h.calls().filter((call) => call.body?.command === "record")).toHaveLength(3);
  });
  it.each([false, true])(
    "drops a late Resume response after auth reset (success=%s)",
    async (success) => {
      h.setCapture(
        capture({ desired: "paused", generation: 2, observed: { generation: 2, phase: "paused" } })
      );
      let finish!: (value: Response) => void;
      const normal = h.transport().getMockImplementation()!;
      h.transport().mockImplementation((path, options) => {
        const body = options?.body
          ? (JSON.parse(String(options.body)) as Record<string, unknown>)
          : undefined;
        if (path.endsWith("/capture/control") && body?.command === "record") {
          h.calls().push({ path, body });
          return new Promise<Response>((resolve) => {
            finish = resolve;
          });
        }
        return normal(path, options);
      });
      await mount(<CapturePanel meeting={meeting} onLiveChange={() => {}} />);
      act(() => button("Resume").click());
      await settle();
      await act(async () => {
        h.root().unmount();
        await h.client().resetQueries();
      });
      h.setRoot(createRoot(h.host()));
      await mount(<CapturePanel meeting={meeting} onLiveChange={() => {}} />);
      await act(async () =>
        finish(
          success
            ? json({ capture: capture({ generation: 3 }) })
            : json({ message: "Temporary failure" }, 503)
        )
      );
      await settle();
      expect(h.client().getQueryData(captureKeys.session(meeting.id))).toMatchObject({
        operation: null
      });
      expect(
        h.client().getQueryData<MeetingCaptureBrowserStatus>(captureKeys.status(meeting.id))
          ?.capture?.generation
      ).toBe(2);
      expect(h.calls().filter((call) => call.body?.command === "record")).toHaveLength(1);
    }
  );
}
