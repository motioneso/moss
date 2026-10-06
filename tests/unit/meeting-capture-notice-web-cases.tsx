import { act, type ReactNode } from "react";
import { createRoot, type Root } from "react-dom/client";
import type { QueryClient } from "@tanstack/react-query";
import { expect, it, vi, type Mock } from "vitest";
import type {
  MeetingCaptureState,
  MeetingRecord,
  MeetingRecordingNoticeStatus
} from "@moss/shared";
import { CapturePanel } from "../../packages/meetings/src/web/capture-panel.js";
import { MeetingSetup } from "../../packages/meetings/src/web/meeting-setup.js";
import { captureKeys } from "../../packages/meetings/src/web/capture-client.js";
import { recordingNoticeKey } from "../../packages/meetings/src/web/recording-notice.js";

type Call = { path: string; body: Record<string, unknown> | undefined };
type Transport = (path: string, options?: RequestInit) => Promise<Response>;
interface NoticeHarness {
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
  readonly getNotice: () => MeetingRecordingNoticeStatus;
  readonly setNotice: (notice: MeetingRecordingNoticeStatus) => void;
  readonly calls: () => Call[];
  readonly mount: (view: ReactNode, path?: string) => Promise<void>;
  readonly acknowledgeNotice: (scope?: ParentNode) => Promise<void>;
  readonly click: (text: string) => Promise<void>;
  readonly button: (text: string) => HTMLButtonElement;
  readonly settle: () => Promise<void>;
}
/** Shared DOM/transport harness; account acknowledgement and command lifetime remain separate. */
export function registerCaptureNoticeRegressions(h: NoticeHarness) {
  const { capture, meeting, json, mount, acknowledgeNotice, click, button, settle } = h;
  it("persists an explicit account notice once and uses it for another meeting without recording on acknowledgement", async () => {
    await mount(<CapturePanel meeting={meeting} onLiveChange={() => {}} />);
    expect(button("Start meeting").disabled).toBe(true);
    await acknowledgeNotice();
    expect(
      h.calls().filter((call) => call.path === "/api/meetings/recording-notice" && call.body)
    ).toHaveLength(1);
    expect(h.calls().some((call) => call.path.endsWith("/capture/start"))).toBe(false);
    await click("Start meeting");
    expect(h.calls().find((call) => call.path.endsWith("/capture/start"))?.body).not.toHaveProperty(
      "noticeAcknowledged"
    );
    h.setCapture(null);
    await mount(
      <CapturePanel
        key="another-meeting"
        meeting={{ ...meeting, id: "another-meeting" }}
        onLiveChange={() => {}}
      />
    );
    expect(button("Start meeting").disabled).toBe(false);
    expect(h.host().querySelector('input[aria-label="Recording notice"]')).toBeNull();
  });
  it.each(["start", "resume"] as const)(
    "refreshes stale account policy after a server %s rejection",
    async (action) => {
      h.setNotice({
        ...h.getNotice(),
        acknowledgement: {
          policyVersion: h.getNotice().currentNotice.policyVersion,
          acknowledgedAt: new Date().toISOString()
        }
      });
      if (action === "resume")
        h.setCapture(
          capture({
            desired: "paused",
            generation: 2,
            observed: { generation: 2, phase: "paused" }
          })
        );
      const normal = h.transport().getMockImplementation()!;
      h.transport().mockImplementation((path, options) => {
        const body = options?.body
          ? (JSON.parse(String(options.body)) as Record<string, unknown>)
          : undefined;
        if (
          path.endsWith("/capture/start") ||
          (path.endsWith("/capture/control") && body?.command === "record")
        ) {
          h.calls().push({ path, body });
          return Promise.resolve(json({ code: "meeting_capture_notice_required" }, 409));
        }
        return normal(path, options);
      });
      await mount(<CapturePanel meeting={meeting} onLiveChange={() => {}} />);
      h.setNotice({
        ...h.getNotice(),
        currentNotice: { policyVersion: "new-policy", text: "A changed recording policy" }
      });
      await click(action === "start" ? "Start meeting" : "Resume");
      expect(button(action === "start" ? "Start meeting" : "Resume").disabled).toBe(true);
      expect(h.host().textContent).toContain("A changed recording policy");
      expect(h.host().querySelector('input[aria-label="Recording notice"]')).not.toBeNull();
      expect(
        h
          .calls()
          .filter((call) => call.path.endsWith("/capture/start") || call.body?.command === "record")
      ).toHaveLength(1);
      if (action === "resume") expect(button("Stop and review").disabled).toBe(false);
    }
  );
  it("does not carry a late draft Start across the actual resetQueries auth flow", async () => {
    let finish!: (value: Response) => void;
    const normal = h.transport().getMockImplementation()!;
    h.transport().mockImplementation((path, options) =>
      path === "/api/meetings/records"
        ? new Promise<Response>((resolve) => {
            finish = resolve;
          })
        : normal(path, options)
    );
    await mount(<MeetingSetup onCreated={() => {}} />);
    await acknowledgeNotice();
    act(() => button("Start meeting").click());
    await act(async () => {
      h.root().unmount();
      await h.client().resetQueries();
    });
    h.setNotice({ ...h.getNotice(), acknowledgement: null });
    h.setRoot(createRoot(h.host()));
    await mount(<MeetingSetup onCreated={() => {}} />);
    expect(
      h.host().querySelector<HTMLInputElement>('input[aria-label="Recording notice"]')?.checked
    ).toBe(false);
    await act(async () => finish(json({ meeting, created: true })));
    await settle();
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
    await acknowledgeNotice();
    act(() => button("Start meeting").click());
    await act(async () => {
      h.root().unmount();
      await h.client().resetQueries();
    });
    h.setRoot(createRoot(h.host()));
    await mount(<MeetingSetup onCreated={() => {}} />);
    act(() => button("Start meeting").click());
    expect(pending).toHaveLength(2);
    const key = ["meetings", "setup-draft"] as const;
    const newer = h.client().getQueryData(key);
    await act(async () => pending[0]!(json({ message: "Old rejected draft" }, 400)));
    await settle();
    expect(h.client().getQueryData(key)).toEqual(newer);
    expect(h.client().getQueryData(key)).toMatchObject({ creating: true, error: null });
    await act(async () => pending[1]!(json({ meeting, created: true })));
    await settle();
    expect(h.calls().filter((call) => call.path.endsWith("/capture/start"))).toHaveLength(1);
  });
  it("requires current account policy for a saved Resume retry while keeping Stop available", async () => {
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
    await acknowledgeNotice();
    vi.useFakeTimers();
    act(() => button("Resume").click());
    await act(async () => vi.advanceTimersByTimeAsync(2000));
    expect(button("Retry capture command").disabled).toBe(false);
    const before = h.calls().filter((call) => call.body?.command === "record").length;
    expect(before).toBe(3);
    act(() =>
      h.client().setQueryData(recordingNoticeKey, {
        ...h.getNotice(),
        currentNotice: { ...h.getNotice().currentNotice, policyVersion: "new-policy" }
      })
    );
    await act(async () => vi.advanceTimersByTimeAsync(1));
    expect(button("Retry capture command").disabled).toBe(true);
    act(() => button("Retry capture command").click());
    await act(async () => vi.advanceTimersByTimeAsync(50));
    expect(h.calls().filter((call) => call.body?.command === "record")).toHaveLength(before);
    expect(button("Stop and review").disabled).toBe(false);
    act(() => button("Stop and review").click());
    await act(async () => vi.advanceTimersByTimeAsync(50));
    expect(h.getCapture()?.desired).toBe("stopped");
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
      await acknowledgeNotice();
      act(() => button("Resume").click());
      await settle();
      await act(async () => {
        h.root().unmount();
        await h.client().resetQueries();
      });
      h.setNotice({ ...h.getNotice(), acknowledgement: null });
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
        h.client().getQueryData<MeetingRecordingNoticeStatus>(recordingNoticeKey)?.acknowledgement
      ).toBeNull();
      expect(h.calls().filter((call) => call.body?.command === "record")).toHaveLength(1);
    }
  );
}
