// @vitest-environment jsdom
// Synthetic component regressions. These mocked unit checks are not assembled live proof.
import { act } from "react";
import { createRoot, type Root } from "react-dom/client";
import { QueryClient, QueryClientProvider } from "@tanstack/react-query";
import { afterEach, describe, expect, it, vi } from "vitest";
import { DEFAULT_LOCALE_SETTINGS, localDay, type MedicationScheduleResponse } from "@moss/shared";
import { queryKeys } from "../../apps/web/src/api/query-keys.js";
import * as api from "../../apps/web/src/api/client.js";
import { requestWellnessExport } from "../../apps/web/src/api/wellness-export.js";
import { MedToday } from "../../apps/web/src/wellness/wellness-today.js";
import {
  defaultExportRange,
  WellnessExportModal
} from "../../apps/web/src/wellness/export-modal.js";
import { exportDraftKey } from "../../apps/web/src/wellness/export-draft.js";

vi.mock("../../apps/web/src/api/client.js", async (original) => ({
  ...(await original<typeof api>()),
  getMedicationSchedule: vi.fn(),
  logMedicationDose: vi.fn(),
  getDataExportStatus: vi.fn()
}));
vi.mock("../../apps/web/src/api/wellness-export.js", () => ({ requestWellnessExport: vi.fn() }));

const cleanups: Array<() => Promise<void>> = [];
afterEach(async () => {
  for (const cleanup of cleanups.splice(0)) await cleanup();
  vi.resetAllMocks();
  sessionStorage.clear();
});

function makeClient() {
  const client = new QueryClient({
    defaultOptions: { queries: { retry: false, staleTime: Infinity }, mutations: { retry: false } }
  });
  client.setQueryData(queryKeys.auth.me, { user: { id: "fictional-owner" } });
  client.setQueryData(queryKeys.settings.locale, {
    locale: { timezone: "UTC", region: "en-US", dateFormat: "24" }
  });
  return client;
}

async function mount(content: React.ReactNode, client = makeClient()) {
  const host = document.createElement("div");
  document.body.append(host);
  const root: Root = createRoot(host);
  const render = async (next: React.ReactNode) => {
    await act(async () =>
      root.render(<QueryClientProvider client={client}>{next}</QueryClientProvider>)
    );
  };
  await render(content);
  cleanups.push(async () => {
    await act(async () => root.unmount());
    host.remove();
    client.clear();
  });
  return { host, client, render };
}

function button(host: HTMLElement, name: string): HTMLButtonElement {
  const found = Array.from(host.querySelectorAll("button")).find(
    (element) => element.textContent?.trim() === name
  );
  expect(found, `button ${name}`).toBeDefined();
  return found!;
}
async function click(host: HTMLElement, name: string) {
  await act(async () => button(host, name).click());
}
async function fill(input: HTMLInputElement, value: string) {
  await act(async () => {
    Object.getOwnPropertyDescriptor(HTMLInputElement.prototype, "value")!.set!.call(input, value);
    input.dispatchEvent(new Event("input", { bubbles: true }));
    input.dispatchEvent(new Event("change", { bubbles: true }));
  });
}
function schedule(
  status: "pending" | "taken" | "skipped" = "pending",
  asNeeded = false
): MedicationScheduleResponse {
  const date = localDay(new Date(), "UTC");
  return {
    date,
    slots: [
      {
        medicationId: "fictional-med",
        name: "Fictional dose",
        asNeeded,
        status,
        scheduledFor: asNeeded ? null : `${date}T08:00:00.000Z`,
        localTime: asNeeded ? undefined : "08:00",
        prnCount: 0
      }
    ]
  };
}
async function medication(status: "pending" | "taken" | "skipped" = "pending", asNeeded = false) {
  const client = makeClient();
  const data = schedule(status, asNeeded);
  client.setQueryData(queryKeys.wellness.schedule(data.date), data);
  vi.mocked(api.getMedicationSchedule).mockResolvedValue(data);
  return mount(<MedToday theme="light" onManage={() => {}} timeZone="UTC" />, client);
}

async function selectExport(host: HTMLElement) {
  const checks = host.querySelectorAll<HTMLInputElement>('input[type="checkbox"]');
  await act(async () => checks[checks.length - 1]!.click());
  await click(host, "Generate export");
}

describe("Wellness dose recovery", () => {
  it.each(["pending", "taken", "skipped"] as const)(
    "distinguishes the scheduled %s state",
    async (status) => {
      const { host } = await medication(status);
      expect(host.textContent).toContain(status[0]!.toUpperCase() + status.slice(1));
      expect(host.textContent).toContain("08:00");
    }
  );

  it("explains taken-to-skipped correction and retries the same failed scheduled write", async () => {
    vi.mocked(api.logMedicationDose).mockRejectedValueOnce(new Error("offline"));
    const { host } = await medication("taken");
    const dose = host.querySelector<HTMLElement>('[role="button"]')!;
    expect(dose.getAttribute("aria-label")).toContain("Mark skipped");
    await act(async () => dose.click());
    await vi.waitFor(() =>
      expect(host.querySelector('[role="alert"]')?.textContent).toContain("Could not save")
    );
    expect(host.textContent).toContain("Taken");
    vi.mocked(api.logMedicationDose).mockResolvedValueOnce({
      log: {
        id: "fictional-log",
        medicationId: "fictional-med",
        status: "skipped",
        dose: null,
        prnReason: null,
        scheduledFor: schedule().slots[0]!.scheduledFor,
        loggedAt: new Date().toISOString()
      }
    });
    await click(host, "Retry dose");
    await vi.waitFor(() => expect(api.logMedicationDose).toHaveBeenCalledTimes(2));
    expect(vi.mocked(api.logMedicationDose).mock.calls[1]).toEqual(
      vi.mocked(api.logMedicationDose).mock.calls[0]
    );
  });

  it("keeps a scheduled rejection that lands after leaving Today and retries the same write", async () => {
    let reject!: (error: Error) => void;
    vi.mocked(api.logMedicationDose).mockImplementationOnce(
      () => new Promise((_, no) => (reject = no))
    );
    const { host, render } = await medication("taken");
    const content = <MedToday theme="light" onManage={() => {}} timeZone="UTC" />;
    await act(async () => host.querySelector<HTMLElement>('[role="button"]')!.click());
    await vi.waitFor(() => expect(api.logMedicationDose).toHaveBeenCalledTimes(1));
    await render(null);
    await act(async () => reject(new Error("offline")));
    await render(content);
    await vi.waitFor(() =>
      expect(host.querySelector('[role="alert"]')?.textContent).toContain(
        "Could not save this dose as skipped"
      )
    );
    vi.mocked(api.logMedicationDose).mockResolvedValueOnce({
      log: {
        id: "fictional-log",
        medicationId: "fictional-med",
        status: "skipped",
        dose: null,
        prnReason: null,
        scheduledFor: schedule().slots[0]!.scheduledFor,
        loggedAt: new Date().toISOString()
      }
    });
    await click(host, "Retry dose");
    await vi.waitFor(() => expect(api.logMedicationDose).toHaveBeenCalledTimes(2));
    expect(vi.mocked(api.logMedicationDose).mock.calls[1]).toEqual(
      vi.mocked(api.logMedicationDose).mock.calls[0]
    );
    await vi.waitFor(() => expect(host.querySelector('[role="alert"]')).toBeNull());
  });

  it("retains an ambiguous PRN draft and rechecks saved doses without repeating the insert", async () => {
    vi.mocked(api.logMedicationDose).mockRejectedValueOnce(new Error("connection lost"));
    const { host } = await medication("pending", true);
    await click(host, "Log a dose");
    const input = host.querySelector<HTMLInputElement>('[aria-label="Reason for this dose"]')!;
    await fill(input, "Fictional reason");
    await click(host, "Log dose");
    await vi.waitFor(() =>
      expect(host.querySelector('[role="alert"]')?.textContent).toContain("could not confirm")
    );
    expect(input.value).toBe("Fictional reason");
    expect(host.textContent).toContain("Check saved doses");
    await click(host, "Check saved doses");
    expect(api.getMedicationSchedule).toHaveBeenCalled();
    expect(api.logMedicationDose).toHaveBeenCalledTimes(1);
  });
});

describe("Unresolved as-needed outcome lifetime", () => {
  it.each(["success", "uncertain failure"] as const)(
    "restores an account's pending draft and prevents another insert until %s",
    async (outcome) => {
      let resolve!: (value: Awaited<ReturnType<typeof api.logMedicationDose>>) => void;
      let reject!: (error: Error) => void;
      vi.mocked(api.logMedicationDose).mockImplementationOnce(
        () =>
          new Promise((yes, no) => {
            resolve = yes;
            reject = no;
          })
      );
      const { host, client, render } = await medication("pending", true);
      const content = <MedToday theme="light" onManage={() => {}} timeZone="UTC" />;
      await click(host, "Log a dose");
      await fill(
        host.querySelector<HTMLInputElement>('[aria-label="Reason for this dose"]')!,
        "Fictional pending reason"
      );
      await click(host, "Log dose");
      await vi.waitFor(() => expect(api.logMedicationDose).toHaveBeenCalledTimes(1));
      await render(null);
      client.setQueryData(queryKeys.auth.me, { user: { id: "fictional-other" } });
      await render(content);
      expect(host.textContent).not.toContain("Saving dose");
      expect(host.querySelector('[aria-label="Reason for this dose"]')).toBeNull();
      await render(null);
      client.setQueryData(queryKeys.auth.me, { user: { id: "fictional-owner" } });
      await render(content);
      if (!host.querySelector('[aria-label="Reason for this dose"]'))
        await click(host, "Log a dose");
      await click(host, "Log dose");
      expect(api.logMedicationDose).toHaveBeenCalledTimes(1);
      expect(host.textContent).toContain("Saving dose");
      expect(
        host.querySelector<HTMLInputElement>('[aria-label="Reason for this dose"]')!.value
      ).toBe("Fictional pending reason");
      expect(sessionStorage.length).toBe(0);
      if (outcome === "uncertain failure") {
        await render(null);
        client.setQueryData(queryKeys.auth.me, { user: { id: "fictional-other" } });
        await render(content);
        await act(async () => reject(new Error("late response lost")));
        expect(host.textContent).not.toContain("could not confirm");
        await render(null);
        client.setQueryData(queryKeys.auth.me, { user: { id: "fictional-owner" } });
        await render(content);
        await vi.waitFor(() => expect(host.textContent).toContain("could not confirm"));
        expect(button(host, "Log dose").disabled).toBe(true);
        expect(
          host.querySelector<HTMLInputElement>('[aria-label="Reason for this dose"]')!.value
        ).toBe("Fictional pending reason");
        await click(host, "Check saved doses");
        await vi.waitFor(() => expect(button(host, "Log dose").disabled).toBe(false));
      } else {
        const saved = schedule("pending", true);
        vi.mocked(api.getMedicationSchedule).mockResolvedValue({
          ...saved,
          slots: saved.slots.map((slot) => ({ ...slot, prnCount: 1 }))
        });
        await act(async () =>
          resolve({
            log: {
              id: "late-prn",
              medicationId: "fictional-med",
              status: "prn",
              dose: null,
              prnReason: "Fictional pending reason",
              scheduledFor: null,
              loggedAt: new Date().toISOString()
            }
          })
        );
        await vi.waitFor(() => expect(host.textContent).toContain("1 logged today"));
        expect(host.textContent).not.toContain("Saving dose");
        expect(button(host, "Log dose").disabled).toBe(false);
      }
      expect(api.logMedicationDose).toHaveBeenCalledTimes(1);
    }
  );

  async function failedPrn() {
    const client = makeClient();
    const prn = schedule("pending", true);
    const mixed = {
      ...prn,
      slots: [
        ...prn.slots,
        {
          ...schedule().slots[0]!,
          medicationId: "fictional-scheduled",
          name: "Fictional scheduled"
        }
      ]
    };
    client.setQueryData(queryKeys.wellness.schedule(prn.date), mixed);
    vi.mocked(api.getMedicationSchedule).mockResolvedValue(mixed);
    vi.mocked(api.logMedicationDose).mockRejectedValueOnce(new Error("lost response"));
    const content = <MedToday theme="light" onManage={() => {}} timeZone="UTC" />;
    const fixture = await mount(content, client);
    await click(fixture.host, "Log a dose");
    await fill(
      fixture.host.querySelector<HTMLInputElement>('[aria-label="Reason for this dose"]')!,
      "Fictional retained reason"
    );
    await click(fixture.host, "Log dose");
    await vi.waitFor(() => expect(fixture.host.textContent).toContain("could not confirm"));
    return { ...fixture, content, mixed };
  }
  it("keeps uncertainty and reason across an unrelated write and quick route re-entry", async () => {
    const { host, render, content, mixed } = await failedPrn();
    vi.mocked(api.logMedicationDose).mockResolvedValueOnce({
      log: {
        id: "scheduled-log",
        medicationId: "fictional-scheduled",
        status: "taken",
        dose: null,
        prnReason: null,
        scheduledFor: mixed.slots[1]!.scheduledFor,
        loggedAt: new Date().toISOString()
      }
    });
    await act(async () => host.querySelector<HTMLElement>('[role="button"]')!.click());
    await vi.waitFor(() => expect(api.logMedicationDose).toHaveBeenCalledTimes(2));
    expect(host.textContent).toContain("could not confirm");
    expect(button(host, "Log dose").disabled).toBe(true);
    await render(null);
    await render(content);
    expect(host.textContent).toContain("could not confirm");
    expect(host.querySelector<HTMLInputElement>('[aria-label="Reason for this dose"]')!.value).toBe(
      "Fictional retained reason"
    );
    expect(button(host, "Log dose").disabled).toBe(true);
    await click(host, "Log dose");
    expect(api.logMedicationDose).toHaveBeenCalledTimes(2);
    expect(sessionStorage.length).toBe(0);
  });
  it("separates unresolved drafts by account and clears the guard only after a successful read", async () => {
    const { host, render, content, client, mixed } = await failedPrn();
    await render(null);
    client.setQueryData(queryKeys.auth.me, { user: { id: "fictional-other" } });
    await render(content);
    expect(host.textContent).not.toContain("could not confirm");
    expect(host.querySelector('[aria-label="Reason for this dose"]')).toBeNull();
    await render(null);
    client.setQueryData(queryKeys.auth.me, { user: { id: "fictional-owner" } });
    await render(content);
    expect(button(host, "Log dose").disabled).toBe(true);
    vi.mocked(api.getMedicationSchedule).mockRejectedValueOnce(new Error("still offline"));
    await click(host, "Check saved doses");
    expect(host.textContent).toContain("could not confirm");
    expect(button(host, "Log dose").disabled).toBe(true);
    vi.mocked(api.getMedicationSchedule).mockResolvedValueOnce(mixed);
    await click(host, "Check saved doses");
    await vi.waitFor(() => expect(button(host, "Log dose").disabled).toBe(false));
    expect(host.textContent).toContain("Saved doses checked");
    expect(host.querySelector<HTMLInputElement>('[aria-label="Reason for this dose"]')!.value).toBe(
      "Fictional retained reason"
    );
    expect(api.logMedicationDose).toHaveBeenCalledTimes(1);
    expect(sessionStorage.length).toBe(0);
  });
});

describe("Wellness export recovery", () => {
  it("discloses UTC and blocks an overlong inclusive selection before requesting a job", async () => {
    const { host } = await mount(<WellnessExportModal open onClose={() => {}} />);
    expect(host.textContent).toContain("UTC");
    expect(host.textContent).toContain("366");
    await fill(host.querySelector<HTMLInputElement>("#wlexport-from")!, "2024-01-01");
    await selectExport(host);
    expect(button(host, "Generate export").disabled).toBe(true);
    expect(requestWellnessExport).not.toHaveBeenCalled();
  });

  it("keeps conflict-specific guidance and selected categories", async () => {
    vi.mocked(requestWellnessExport).mockRejectedValueOnce(
      new api.ApiError(409, "An export is already in progress with different parameters.")
    );
    const { host } = await mount(<WellnessExportModal open onClose={() => {}} />);
    await selectExport(host);
    await vi.waitFor(() =>
      expect(host.querySelector('[role="alert"]')?.textContent).toContain("different settings")
    );
    expect(host.querySelector<HTMLInputElement>("#wlexport-from")!.value).not.toBe("");
    expect(button(host, "Generate export").disabled).toBe(false);
  });

  it("retains job and selection after Close, route unmount, and return", async () => {
    vi.mocked(requestWellnessExport).mockResolvedValueOnce({
      jobId: "fictional-job",
      status: "pending"
    });
    vi.mocked(api.getDataExportStatus).mockResolvedValue({
      jobId: "fictional-job",
      status: "building"
    });
    const { host, render } = await mount(<WellnessExportModal open onClose={() => {}} />);
    await fill(host.querySelector<HTMLInputElement>("#wlexport-from")!, "2026-09-01");
    await selectExport(host);
    await vi.waitFor(() => expect(host.textContent).toContain("Building your export"));
    await click(host, "Close");
    await render(null);
    await render(<WellnessExportModal open onClose={() => {}} />);
    await vi.waitFor(() => expect(host.textContent).toContain("Building your export"));
    expect(requestWellnessExport).toHaveBeenCalledTimes(1);
    expect(api.getDataExportStatus).toHaveBeenCalledWith("fictional-job");
  });

  it("offers regeneration for an expired job while preserving the selected range", async () => {
    vi.mocked(requestWellnessExport).mockResolvedValueOnce({
      jobId: "expired-job",
      status: "pending"
    });
    vi.mocked(api.getDataExportStatus).mockResolvedValue({
      jobId: "expired-job",
      status: "expired"
    });
    const { host } = await mount(<WellnessExportModal open onClose={() => {}} />);
    await fill(host.querySelector<HTMLInputElement>("#wlexport-from")!, "2026-09-01");
    await selectExport(host);
    await vi.waitFor(() => expect(host.textContent).toContain("expired"));
    await click(host, "Generate again");
    expect(host.querySelector<HTMLInputElement>("#wlexport-from")!.value).toBe("2026-09-01");
    expect(host.querySelectorAll<HTMLInputElement>('input[type="checkbox"]')[4]!.checked).toBe(
      false
    );
  });
  it.each([404, 410])(
    "recovers an unavailable job (%s) without discarding the selection",
    async (code) => {
      vi.mocked(requestWellnessExport).mockResolvedValueOnce({
        jobId: "missing-job",
        status: "pending"
      });
      vi.mocked(api.getDataExportStatus).mockRejectedValue(new api.ApiError(code, "unavailable"));
      const { host } = await mount(<WellnessExportModal open onClose={() => {}} />);
      await fill(host.querySelector<HTMLInputElement>("#wlexport-from")!, "2026-09-01");
      await selectExport(host);
      await vi.waitFor(() => expect(host.textContent).toContain("no longer available"));
      await click(host, "Generate again");
      expect(host.querySelector<HTMLInputElement>("#wlexport-from")!.value).toBe("2026-09-01");
      expect(requestWellnessExport).toHaveBeenCalledTimes(1);
    }
  );

  it("retries a failed status read for the saved job without requesting a duplicate", async () => {
    vi.mocked(requestWellnessExport).mockResolvedValueOnce({
      jobId: "retry-job",
      status: "pending"
    });
    vi.mocked(api.getDataExportStatus).mockRejectedValueOnce(new Error("offline"));
    const { host } = await mount(<WellnessExportModal open onClose={() => {}} />);
    await selectExport(host);
    await vi.waitFor(() => expect(host.textContent).toContain("Could not check your export"));
    vi.mocked(api.getDataExportStatus).mockResolvedValueOnce({
      jobId: "retry-job",
      status: "ready"
    });
    await click(host, "Try again");
    await vi.waitFor(() => expect(host.textContent).toContain("Your export is ready"));
    expect(requestWellnessExport).toHaveBeenCalledTimes(1);
    expect(api.getDataExportStatus).toHaveBeenLastCalledWith("retry-job");
  });

  it("saves the submitted snapshot even when the route unmounts before the response", async () => {
    let finish!: (value: api.ExportJobStatus) => void;
    vi.mocked(requestWellnessExport).mockImplementationOnce(
      () =>
        new Promise((resolve) => {
          finish = resolve;
        })
    );
    vi.mocked(api.getDataExportStatus).mockResolvedValue({
      jobId: "delayed-job",
      status: "building"
    });
    const { host, render } = await mount(<WellnessExportModal open onClose={() => {}} />);
    await fill(host.querySelector<HTMLInputElement>("#wlexport-from")!, "2026-09-01");
    await selectExport(host);
    await vi.waitFor(() =>
      expect(host.querySelector<HTMLInputElement>("#wlexport-from")!.disabled).toBe(true)
    );
    await render(null);
    await render(<WellnessExportModal open onClose={() => {}} />);
    await vi.waitFor(() =>
      expect(host.querySelector<HTMLInputElement>("#wlexport-from")!.disabled).toBe(true)
    );
    expect(button(host, "Starting…").disabled).toBe(true);
    await act(async () => finish({ jobId: "delayed-job", status: "pending" }));
    await vi.waitFor(() => expect(host.textContent).toContain("Building your export"));
    await render(null);
    const freshClient = makeClient();
    await render(
      <QueryClientProvider client={freshClient}>
        <WellnessExportModal open onClose={() => {}} />
      </QueryClientProvider>
    );
    await vi.waitFor(() => expect(host.textContent).toContain("Building your export"));
    expect(api.getDataExportStatus).toHaveBeenCalledWith("delayed-job");
    expect(requestWellnessExport).toHaveBeenCalledTimes(1);
    await render(null);
    freshClient.clear();
    const stored = JSON.parse(sessionStorage.getItem("moss:wellness-export:fictional-owner")!);
    expect(stored.from).toBe("2026-09-01");
    expect(stored).not.toHaveProperty("acknowledged");
  });

  it("does not load another account's selection or job after re-entry", async () => {
    vi.mocked(requestWellnessExport).mockResolvedValueOnce({
      jobId: "owner-job",
      status: "pending"
    });
    vi.mocked(api.getDataExportStatus).mockResolvedValue({
      jobId: "owner-job",
      status: "building"
    });
    const { host, client, render } = await mount(<WellnessExportModal open onClose={() => {}} />);
    await fill(host.querySelector<HTMLInputElement>("#wlexport-from")!, "2026-09-01");
    await selectExport(host);
    await vi.waitFor(() => expect(host.textContent).toContain("Building your export"));
    await render(null);
    await act(async () => {
      client.setQueryData(queryKeys.auth.me, { user: { id: "fictional-other" } });
    });
    await render(<WellnessExportModal open onClose={() => {}} />);
    expect(host.textContent).toContain("Generate export");
    expect(host.querySelector<HTMLInputElement>("#wlexport-from")!.value).not.toBe("2026-09-01");
    expect(host.querySelectorAll<HTMLInputElement>('input[type="checkbox"]')[4]!.checked).toBe(
      false
    );
  });
  it("treats a ready export whose download expired as expired without losing selection", async () => {
    vi.mocked(requestWellnessExport).mockResolvedValueOnce({
      jobId: "ready-expired",
      status: "pending"
    });
    vi.mocked(api.getDataExportStatus).mockResolvedValue({
      jobId: "ready-expired",
      status: "ready",
      expiresAt: "2020-01-01T00:00:00Z"
    });
    const { host } = await mount(<WellnessExportModal open onClose={() => {}} />);
    await fill(host.querySelector<HTMLInputElement>("#wlexport-from")!, "2026-09-01");
    await selectExport(host);
    await vi.waitFor(() => expect(host.textContent).toContain("This export has expired"));
    expect(host.querySelector("a[download]")).toBeNull();
    await click(host, "Generate again");
    expect(host.querySelector<HTMLInputElement>("#wlexport-from")!.value).toBe("2026-09-01");
    expect(button(host, "Generate export").disabled).toBe(true);
  });
  it("keeps untouched dates following the default range after a generated job", async () => {
    vi.mocked(requestWellnessExport).mockResolvedValueOnce({
      jobId: "default-range",
      status: "pending"
    });
    vi.mocked(api.getDataExportStatus).mockResolvedValue({
      jobId: "default-range",
      status: "expired"
    });
    const { host, client } = await mount(<WellnessExportModal open onClose={() => {}} />);
    await selectExport(host);
    await vi.waitFor(() => expect(host.textContent).toContain("This export has expired"));
    expect(client.getQueryData(exportDraftKey("fictional-owner"))).toMatchObject({
      from: null,
      to: null
    });
    await click(host, "Generate again");
    await act(async () => {
      client.setQueryData(queryKeys.settings.locale, {
        locale: { ...DEFAULT_LOCALE_SETTINGS, timezone: "Pacific/Kiritimati" }
      });
    });
    const shifted = defaultExportRange("Pacific/Kiritimati");
    await vi.waitFor(() =>
      expect(host.querySelector<HTMLInputElement>("#wlexport-to")!.value).toBe(shifted.to)
    );
    expect(host.querySelector<HTMLInputElement>("#wlexport-from")!.value).toBe(shifted.from);
  });
  it("updates a ready export when its expiration time crosses while the modal remains open", async () => {
    vi.mocked(requestWellnessExport).mockResolvedValueOnce({
      jobId: "crossing-expiry",
      status: "pending"
    });
    vi.mocked(api.getDataExportStatus).mockImplementation(async () => ({
      jobId: "crossing-expiry",
      status: "ready",
      expiresAt: new Date(Date.now() + 500).toISOString()
    }));
    const { host } = await mount(<WellnessExportModal open onClose={() => {}} />);
    await selectExport(host);
    await vi.waitFor(() => expect(host.querySelector("a[download]")).not.toBeNull());
    await vi.waitFor(() => expect(host.textContent).toContain("This export has expired"));
    expect(host.querySelector("a[download]")).toBeNull();
    expect(requestWellnessExport).toHaveBeenCalledTimes(1);
  });
});
