// @vitest-environment jsdom
// #1970 — the add-a-medication form. The schedule rules themselves are tested directly in
// tests/unit/wellness-med-builder-form.test.ts; what these tests prove is the WIRING: that the
// component shows the right fields for each of the six choices, that the preview recomputes from
// what is on screen, and that pressing add sends the request the form built rather than a default.
//
// jsdom + react-test-renderer's `act` is this repo's established way to drive real handlers —
// there is no @testing-library/react here. Same pattern as tests/unit/settings-ai-pane.test.tsx.
import { createElement } from "react";
import { act, create, type ReactTestRenderer } from "react-test-renderer";
import { QueryClient, QueryClientProvider } from "@tanstack/react-query";
import { beforeEach, describe, expect, it, vi } from "vitest";

import type { CreateMedicationRequest } from "@moss/shared";

const createMedicationMock = vi.fn(async (input: CreateMedicationRequest) => ({
  medication: { id: "m1", ...input }
}));
const listMedicationsMock = vi.fn(async () => ({ medications: [] }));

vi.mock("../../apps/web/src/api/client", () => ({
  createMedication: (input: CreateMedicationRequest) => createMedicationMock(input),
  listMedications: () => listMedicationsMock(),
  updateMedication: vi.fn(async () => ({}))
}));

import { ManageMedsModal } from "../../apps/web/src/wellness/manage-meds-modal.js";

/** react-test-renderer has no textContent; walk the tree and join every string leaf. */
function renderedText(node: unknown): string {
  if (node === null || node === undefined) return "";
  if (typeof node === "string") return node;
  if (Array.isArray(node)) return node.map(renderedText).join("");
  if (typeof node === "object" && "children" in (node as Record<string, unknown>)) {
    return renderedText((node as { children: unknown }).children);
  }
  return "";
}

async function flush(): Promise<void> {
  await act(async () => {
    await new Promise((resolve) => setTimeout(resolve, 0));
  });
}

async function renderModal(): Promise<ReactTestRenderer> {
  const client = new QueryClient({ defaultOptions: { queries: { retry: false } } });
  let renderer!: ReactTestRenderer;
  await act(async () => {
    renderer = create(
      createElement(
        QueryClientProvider,
        { client },
        createElement(ManageMedsModal, { open: true, onClose: () => {} })
      )
    );
  });
  await flush();
  return renderer;
}

/** Click the button whose visible label is exactly `label`. */
async function clickButton(renderer: ReactTestRenderer, label: string): Promise<void> {
  const button = renderer.root
    .findAllByType("button")
    .find((instance) => renderedText(instance.props.children) === label);
  if (!button) throw new Error(`No button labelled "${label}"`);
  await act(async () => {
    button.props.onClick();
  });
}

/** Type into the field with this accessible name. */
async function setField(
  renderer: ReactTestRenderer,
  ariaLabel: string,
  value: string
): Promise<void> {
  const field = renderer.root.findByProps({ "aria-label": ariaLabel });
  await act(async () => {
    field.props.onChange({ target: { value } });
  });
}

/** Flip the checkbox with this accessible name. */
async function setCheckbox(
  renderer: ReactTestRenderer,
  ariaLabel: string,
  checked: boolean
): Promise<void> {
  const field = renderer.root.findByProps({ "aria-label": ariaLabel });
  await act(async () => {
    field.props.onChange({ target: { checked } });
  });
}

beforeEach(() => {
  createMedicationMock.mockClear();
  listMedicationsMock.mockClear();
});

describe("the six schedule choices each show their own fields", () => {
  const WEEKDAYS = "Days of the week";
  const INTERVAL = "How often it repeats";
  const MONTHLY = "Which day of the month";
  const CYCLE = "Days on, then days off";
  const TIMES = "Time of day";
  const NO_SCHEDULE = "As-needed medications have no fixed schedule.";

  const cases: { choice: string; shows: string[]; hides: string[] }[] = [
    { choice: "Every day", shows: [TIMES], hides: [WEEKDAYS, INTERVAL, MONTHLY, CYCLE] },
    { choice: "Certain days", shows: [WEEKDAYS, TIMES], hides: [INTERVAL, MONTHLY, CYCLE] },
    { choice: "Every so often", shows: [INTERVAL, TIMES], hides: [MONTHLY, CYCLE] },
    { choice: "Monthly", shows: [MONTHLY, TIMES], hides: [WEEKDAYS, INTERVAL, CYCLE] },
    { choice: "In a cycle", shows: [CYCLE, TIMES], hides: [WEEKDAYS, INTERVAL, MONTHLY] },
    {
      choice: "Only when needed",
      shows: [NO_SCHEDULE],
      hides: [WEEKDAYS, INTERVAL, MONTHLY, CYCLE, TIMES]
    }
  ];

  for (const testCase of cases) {
    it(`"${testCase.choice}"`, async () => {
      const renderer = await renderModal();
      await clickButton(renderer, testCase.choice);
      const text = renderedText(renderer.toJSON());
      for (const shown of testCase.shows) expect(text).toContain(shown);
      for (const hidden of testCase.hides) expect(text).not.toContain(hidden);
      await act(async () => {
        renderer.unmount();
      });
    });
  }

  it("switching to weeks on 'every so often' brings the weekday buttons in", async () => {
    const renderer = await renderModal();
    await clickButton(renderer, "Every so often");
    expect(renderedText(renderer.toJSON())).not.toContain(WEEKDAYS);
    await clickButton(renderer, "weeks");
    expect(renderedText(renderer.toJSON())).toContain(WEEKDAYS);
    await act(async () => {
      renderer.unmount();
    });
  });
});

describe("the preview is computed from what is on screen", () => {
  it("shows the sentence and three dose times, and both follow the clock time", async () => {
    const renderer = await renderModal();
    await setField(renderer, "Medication name", "Bupropion");
    await setField(renderer, "Dose time 1", "09:15");

    const sentence = () =>
      renderedText(
        renderer.root.findByProps({ className: "wl-medform__previewline" }).props.children
      );
    const doses = () =>
      renderedText(
        renderer.root.findByProps({ className: "wl-medform__previewdoses" }).props.children
      );

    expect(sentence().length).toBeGreaterThan(0);
    expect(doses()).toContain("09:15");
    // Three upcoming doses, separated by the middle dot the component joins them with.
    expect(doses().split("·")).toHaveLength(3);

    await setField(renderer, "Dose time 1", "21:45");
    expect(doses()).toContain("21:45");
    expect(doses()).not.toContain("09:15");

    await act(async () => {
      renderer.unmount();
    });
  });
});

describe("pressing add sends the form's own values", () => {
  it("sends the weekday schedule that was picked, not a default", async () => {
    const renderer = await renderModal();
    await clickButton(renderer, "Certain days");
    await setField(renderer, "Medication name", "  Sertraline  ");
    await setField(renderer, "Dose", " 50 mg ");
    await clickButton(renderer, "Tue");
    await clickButton(renderer, "Thu");
    await setField(renderer, "Dose time 1", "07:30");
    await setField(renderer, "Start date", "2026-09-01");
    await setCheckbox(renderer, "Remind me when a dose is due", true);

    await clickButton(renderer, "Add medication");
    await flush();

    expect(createMedicationMock).toHaveBeenCalledTimes(1);
    expect(createMedicationMock).toHaveBeenCalledWith({
      name: "Sertraline",
      dosage: "50 mg",
      startDate: "2026-09-01",
      frequencyType: "specific_weekdays",
      weekdays: [2, 4],
      scheduleTimes: ["07:30"],
      remindersEnabled: true
    });

    await act(async () => {
      renderer.unmount();
    });
  });

  it("stays disabled while something is missing, and says what", async () => {
    const renderer = await renderModal();
    await clickButton(renderer, "Certain days");
    await setField(renderer, "Medication name", "Sertraline");

    const addButton = renderer.root
      .findAllByType("button")
      .find((instance) => renderedText(instance.props.children) === "Add medication");
    expect(addButton?.props.disabled).toBe(true);
    expect(renderedText(renderer.toJSON())).toContain("Pick at least one day of the week.");

    await act(async () => {
      renderer.unmount();
    });
  });
});

describe("the reminder switch", () => {
  const withReminders = ["Every day", "Certain days", "Every so often", "Monthly", "In a cycle"];

  for (const choice of withReminders) {
    it(`is offered for "${choice}"`, async () => {
      const renderer = await renderModal();
      await clickButton(renderer, choice);
      expect(
        renderer.root.findAllByProps({ "aria-label": "Remind me when a dose is due" }).length
      ).toBeGreaterThan(0);
      await act(async () => {
        renderer.unmount();
      });
    });
  }

  it('is hidden for "Only when needed", because there is nothing to remind about', async () => {
    const renderer = await renderModal();
    await clickButton(renderer, "Only when needed");
    expect(
      renderer.root.findAllByProps({ "aria-label": "Remind me when a dose is due" })
    ).toHaveLength(0);
    await act(async () => {
      renderer.unmount();
    });
  });
});
