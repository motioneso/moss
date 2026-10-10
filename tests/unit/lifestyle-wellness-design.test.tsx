// @vitest-environment jsdom
import { useState } from "react";
import { createRoot } from "react-dom/client";
import { CheckinModal } from "../../apps/web/src/wellness/checkin-modal.js";
import { ManageMedsModal } from "../../apps/web/src/wellness/manage-meds-modal.js";
import { QueryClient, QueryClientProvider } from "@tanstack/react-query";
import { act, create, type ReactTestRenderer } from "react-test-renderer";
import { renderToString } from "react-dom/server";
import { MemoryRouter } from "react-router";
import { describe, expect, it, vi } from "vitest";
import { localDay, type CheckinDto } from "@moss/shared";
import { queryKeys } from "../../apps/web/src/api/query-keys.js";
import { WellnessExportModal } from "../../apps/web/src/wellness/export-modal.js";
import { WellnessPage } from "../../apps/web/src/wellness/wellness-page.js";
import { MedToday, WellnessToday } from "../../apps/web/src/wellness/wellness-today.js";
import { WellnessHistory } from "../../apps/web/src/wellness/wellness-history.js";
import { WellnessChart } from "../../apps/web/src/wellness/wellness-chart.js";
import { RadialDial } from "../../apps/web/src/wellness/radial-dial.js";
import { CheckinDetailFields } from "../../apps/web/src/wellness/checkin-detail-fields.js";
import { recentMoodAverage } from "../../apps/web/src/wellness/wellness-date-utils.js";

function client() {
  return new QueryClient({
    defaultOptions: { queries: { retry: false, retryOnMount: false, staleTime: Infinity } }
  });
}
function fail(queryClient: QueryClient, key: readonly unknown[]) {
  queryClient
    .getQueryCache()
    .build(queryClient, { queryKey: key })
    .setState({ status: "error", error: new Error("Read failed"), fetchStatus: "idle" });
}
function renderPage(queryClient: QueryClient) {
  return renderToString(
    <QueryClientProvider client={queryClient}>
      <MemoryRouter>
        <WellnessPage />
      </MemoryRouter>
    </QueryClientProvider>
  );
}
function checkin(stamp: string, core: "happy" | "sad" = "happy"): CheckinDto {
  return {
    id: stamp,
    ownerUserId: "fixture",
    checkedInAt: stamp,
    feelingCore: core,
    feelingSecondary: "Hopeful",
    feelingTertiary: null,
    wheelVersion: "fixture",
    sensations: [],
    intensity: 3,
    energy: null,
    note: null,
    identifiedVia: "wheel",
    createdAt: stamp
  };
}

describe("Wellness observed versus unavailable data", () => {
  it("does not fabricate a mood average when observations are absent", () => {
    expect(recentMoodAverage([], "UTC", new Date("2026-10-10T12:00:00Z"))).toBeNull();
    expect(
      recentMoodAverage([checkin("2026-09-01T12:00:00Z")], "UTC", new Date("2026-10-10T12:00:00Z"))
    ).toBeNull();
  });
  it("averages all observations inside fourteen completed local days, not fourteen records", () => {
    const inside = Array.from({ length: 15 }, (_, i) =>
      checkin(`2026-10-09T12:${String(i).padStart(2, "0")}:00Z`)
    );
    expect(
      recentMoodAverage(
        [...inside, checkin("2026-09-01T12:00:00Z", "sad"), checkin("2026-10-10T12:00:00Z", "sad")],
        "UTC",
        new Date("2026-10-10T18:00:00Z")
      )
    ).toBe(3);
    expect(
      recentMoodAverage([checkin("2026-09-26T00:00:00Z")], "UTC", new Date("2026-10-10T18:00:00Z"))
    ).toBe(3);
  });
  it("shows loading without statistics or fake empty check-ins", () => {
    const html = renderPage(client());
    expect(html).toContain("Loading check-ins");
    expect(html).not.toContain("Check-in streak");
    expect(html).not.toContain("You haven&#x27;t checked in");
    expect(html).not.toContain("No check-ins match");
  });
  it("shows read failure and retry without rendering zero mood, empty history or empty schedule", () => {
    const queryClient = client();
    fail(queryClient, queryKeys.wellness.checkins);
    const html = renderPage(queryClient);
    expect(html).toContain("Check-in statistics unavailable");
    expect(html).toContain("Could not load your check-ins");
    expect(html).toContain("Try again");
    expect(html).not.toContain("Check-in streak");
    expect(html).not.toContain("No medications scheduled");
    expect(html).not.toContain("of 0 taken");
  });
  it("keeps confirmed data on a failed refresh with an explicit warning", () => {
    const queryClient = client();
    queryClient.setQueryData(queryKeys.wellness.checkins, { checkins: [] });
    fail(queryClient, queryKeys.wellness.checkins);
    const html = renderPage(queryClient);
    expect(html).toContain("Showing the last loaded entries");
    expect(html).toContain("No check-ins in this period");
    expect(html).toContain("Your check-ins will appear here");
  });
  it("keeps medication presentation separate from a check-in error", () => {
    const html = renderToString(
      <QueryClientProvider client={client()}>
        <WellnessToday
          checkins={[]}
          checkinsReadState="error"
          onRetryCheckins={() => {}}
          streak={0}
          theme="light"
          onManage={() => {}}
          onModalOpen={() => {}}
          onModalEdit={() => {}}
        />
      </QueryClientProvider>
    );
    expect(html).toContain("Today&#x27;s medication");
    expect(html).toContain("Loading medication schedule");
    expect(html).toContain("Could not load your check-ins");
  });
});

describe("Wellness accessible data selection", () => {
  it("exposes all six native radio choices beside the pointer visualization", async () => {
    const onPick = vi.fn();
    let renderer!: ReactTestRenderer;
    await act(async () => {
      renderer = create(<RadialDial value="sad" onPick={onPick} theme="dark" />);
    });
    const choices = renderer.root.findAllByType("input");
    expect(choices).toHaveLength(6);
    expect(choices.every((choice) => choice.props.type === "radio")).toBe(true);
    expect(choices.find((choice) => choice.props.value === "sad")?.props.checked).toBe(true);
    await act(async () => {
      choices.find((choice) => choice.props.value === "happy")!.props.onChange();
    });
    expect(onPick).toHaveBeenCalledWith("happy");
    await act(async () => renderer.unmount());
  });
  it("exposes selected sensation and intensity states", () => {
    const html = renderToString(
      <CheckinDetailFields
        emotion="happy"
        feeling="Joyful"
        sensations={["Warm chest"]}
        intensity={4}
        note=""
        onSensation={() => {}}
        onIntensity={() => {}}
        onNote={() => {}}
      />
    );
    expect(html).toContain('aria-label="Intensity"');
    expect(html).toContain('value="4"');
    expect(html).toContain('checked=""');
    expect(html).toContain("aria-pressed=");
  });
  it("offers a native day selector and complete table values without hover", () => {
    const html = renderToString(
      <WellnessChart
        days={[
          {
            date: "2026-10-09",
            label: "Oct 9",
            isToday: false,
            checkin: null,
            checkins: [],
            medFrac: 0,
            medTaken: 0,
            medDenom: 2
          }
        ]}
      />
    );
    expect(html).toContain("Inspect a day");
    expect(html).toContain("View daily values");
    expect(html).toContain("No check-in");
    expect(html).toContain("0<!-- --> of <!-- -->2");
  });
});

describe("Wellness export recovery (#3267)", () => {
  it("lets a failed job be generated again with the same explicit acknowledgement", async () => {
    const fetchMock = vi.fn(
      async (_path: unknown, init?: RequestInit) =>
        new Response(
          JSON.stringify(
            init?.method === "POST"
              ? { jobId: "fixture-export", status: "pending" }
              : { jobId: "fixture-export", status: "failed" }
          ),
          { status: 200, headers: { "content-type": "application/json" } }
        )
    );
    vi.stubGlobal("fetch", fetchMock);
    const queryClient = client();
    let renderer!: ReactTestRenderer;
    try {
      await act(async () => {
        renderer = create(
          <QueryClientProvider client={queryClient}>
            <WellnessExportModal open onClose={() => {}} />
          </QueryClientProvider>
        );
      });
      const acknowledgement = renderer.root
        .findAllByType("input")
        .filter((node) => node.props.type === "checkbox")
        .at(-1)!;
      await act(async () => acknowledgement.props.onChange({ target: { checked: true } }));
      const generateButton = () =>
        renderer.root
          .findAllByType("button")
          .find((node) => node.children.some((child) => child === "Generate export"))!;
      expect(generateButton().props.disabled).toBe(false);
      await act(async () => generateButton().props.onClick());
      await act(async () => {
        await new Promise((resolve) => setTimeout(resolve, 10));
      });
      await act(async () => {
        await new Promise((resolve) => setTimeout(resolve, 10));
      });
      expect(JSON.stringify(renderer.toJSON())).toContain("Export failed");
      expect(generateButton().props.disabled).toBe(false);
      await act(async () => generateButton().props.onClick());
      expect(fetchMock.mock.calls.filter(([, init]) => init?.method === "POST")).toHaveLength(2);
    } finally {
      if (renderer) await act(async () => renderer.unmount());
      queryClient.clear();
      vi.unstubAllGlobals();
    }
  });
});

describe("Wellness shared dialog consumers", () => {
  it.each(["checkin", "medications", "export"] as const)(
    "names, contains focus and restores the trigger after Escape (%s)",
    async (kind) => {
      const host = document.createElement("div");
      document.body.append(host);
      const queryClient = client();
      queryClient.setQueryData(queryKeys.wellness.medications, { medications: [] });
      queryClient.setQueryData(queryKeys.settings.locale, {
        locale: { timezone: "UTC", region: "en-US", dateFormat: "24" }
      });
      const root = createRoot(host);
      function Harness() {
        const [open, setOpen] = useState(false);
        return (
          <QueryClientProvider client={queryClient}>
            <button onClick={() => setOpen(true)}>Open wellness dialog</button>
            {kind === "checkin" ? (
              <CheckinModal open={open} onClose={() => setOpen(false)} onSave={async () => {}} />
            ) : kind === "medications" ? (
              <ManageMedsModal open={open} onClose={() => setOpen(false)} />
            ) : (
              <WellnessExportModal open={open} onClose={() => setOpen(false)} />
            )}
          </QueryClientProvider>
        );
      }
      try {
        await act(async () => root.render(<Harness />));
        const trigger = host.querySelector<HTMLButtonElement>("button")!;
        trigger.focus();
        await act(async () => trigger.click());
        const dialog = document.querySelector<HTMLElement>('[role="dialog"]')!;
        expect(dialog).not.toBeNull();
        expect(
          document.getElementById(dialog.getAttribute("aria-labelledby")!)?.textContent
        ).toBeTruthy();
        expect(dialog.contains(document.activeElement)).toBe(true);
        await act(async () =>
          document.activeElement!.dispatchEvent(
            new KeyboardEvent("keydown", { key: "Escape", bubbles: true })
          )
        );
        expect(document.querySelector('[role="dialog"]')).toBeNull();
        expect(document.activeElement).toBe(trigger);
      } finally {
        await act(async () => root.unmount());
        host.remove();
        queryClient.clear();
      }
    }
  );
});

describe("Check-in pending save dismissal", () => {
  it("retains the draft through Escape, backdrop and close controls until a failed save settles", async () => {
    const host = document.createElement("div");
    document.body.append(host);
    const root = createRoot(host);
    const onClose = vi.fn();
    let rejectSave!: (reason: Error) => void;
    const onSave = vi.fn(
      () =>
        new Promise<void>((_resolve, reject) => {
          rejectSave = reject;
        })
    );
    try {
      await act(async () =>
        root.render(
          <CheckinModal
            open
            onClose={onClose}
            onSave={onSave}
            initial={{
              emotion: "happy",
              feeling: "Joyful",
              sensations: [],
              intensity: 3,
              note: "Keep this draft"
            }}
          />
        )
      );
      const save = Array.from(host.querySelectorAll("button")).find(
        (button) => button.textContent === "Update check-in"
      )!;
      await act(async () => save.click());
      expect(save.disabled).toBe(true);
      expect(host.querySelector<HTMLButtonElement>('[aria-label="Close check-in"]')!.disabled).toBe(
        true
      );
      expect(
        Array.from(host.querySelectorAll("button")).find(
          (button) => button.textContent === "Cancel"
        )!.disabled
      ).toBe(true);
      await act(async () => {
        document.activeElement!.dispatchEvent(
          new KeyboardEvent("keydown", { key: "Escape", bubbles: true })
        );
        host.querySelector<HTMLElement>(".jds-dialog-scrim")!.click();
      });
      expect(onClose).not.toHaveBeenCalled();
      await act(async () => rejectSave(new Error("Save unavailable")));
      expect(host.querySelector("[role=alert]")!.textContent).toContain("Your note is still here");
      expect(host.querySelector<HTMLTextAreaElement>("textarea")!.value).toBe("Keep this draft");
      expect(host.querySelector<HTMLButtonElement>('[aria-label="Close check-in"]')!.disabled).toBe(
        false
      );
      await act(async () =>
        host.querySelector<HTMLButtonElement>('[aria-label="Close check-in"]')!.click()
      );
      expect(onClose).toHaveBeenCalledOnce();
    } finally {
      await act(async () => root.unmount());
      host.remove();
    }
  });
});

describe("Medication read-state safety", () => {
  it("keeps stale doses readable but prevents writes while refresh is unavailable", async () => {
    const queryClient = client();
    const date = localDay(new Date(), "UTC");
    queryClient.setQueryData(queryKeys.wellness.schedule(date), {
      date,
      slots: [
        {
          medicationId: "fixture-med",
          name: "Example medication",
          scheduledFor: `${date}T08:00:00Z`,
          localTime: "08:00",
          asNeeded: false,
          status: "pending"
        }
      ]
    });
    fail(queryClient, queryKeys.wellness.schedule(date));
    const fetchMock = vi.fn();
    vi.stubGlobal("fetch", fetchMock);
    let renderer!: ReactTestRenderer;
    try {
      await act(async () => {
        renderer = create(
          <QueryClientProvider client={queryClient}>
            <MedToday theme="light" onManage={() => {}} timeZone="UTC" />
          </QueryClientProvider>
        );
      });
      const dose = renderer.root.findByProps({ role: "button" });
      expect(dose.props["aria-disabled"]).toBe(true);
      await act(async () => dose.props.onClick());
      expect(fetchMock).not.toHaveBeenCalled();
      expect(JSON.stringify(renderer.toJSON())).toContain("Showing the last loaded doses");
    } finally {
      if (renderer) await act(async () => renderer.unmount());
      queryClient.clear();
      vi.unstubAllGlobals();
    }
  });
});

describe("Wellness history disclosure relationships", () => {
  it("links each expanded toggle to its own stable detail region", async () => {
    const host = document.createElement("div");
    document.body.append(host);
    const root = createRoot(host);
    const queryClient = client();
    queryClient.setQueryData(queryKeys.settings.locale, {
      locale: { timezone: "UTC", region: "en-US", dateFormat: "24" }
    });
    try {
      await act(async () =>
        root.render(
          <QueryClientProvider client={queryClient}>
            <WellnessHistory
              checkins={[
                { ...checkin("2026-10-09T12:00:00Z"), id: "first-checkin", note: "First note" },
                { ...checkin("2026-10-08T12:00:00Z"), id: "second-checkin", note: "Second note" }
              ]}
              onClearFilter={() => {}}
              onEdit={() => {}}
              timezone="UTC"
            />
          </QueryClientProvider>
        )
      );
      const toggles = host.querySelectorAll<HTMLButtonElement>("button[aria-controls]");
      expect(toggles).toHaveLength(2);
      expect(toggles[0]!.getAttribute("aria-controls")).not.toBe(
        toggles[1]!.getAttribute("aria-controls")
      );
      for (const [index, toggle] of Array.from(toggles).entries()) {
        const detailId = toggle.getAttribute("aria-controls")!;
        await act(async () => toggle.click());
        expect(toggle.getAttribute("aria-expanded")).toBe("true");
        expect(document.getElementById(detailId)?.textContent).toContain(
          index === 0 ? "First note" : "Second note"
        );
        await act(async () => toggle.click());
        expect(toggle.getAttribute("aria-expanded")).toBe("false");
        await act(async () => toggle.click());
        expect(toggle.getAttribute("aria-controls")).toBe(detailId);
        expect(document.getElementById(detailId)).not.toBeNull();
      }
    } finally {
      await act(async () => root.unmount());
      host.remove();
      queryClient.clear();
    }
  });
});
