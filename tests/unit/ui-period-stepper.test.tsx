// @vitest-environment jsdom
import { act } from "react";
import { createRoot, type Root } from "react-dom/client";
import { afterEach, describe, expect, it, vi } from "vitest";

import { PeriodStepper } from "../../packages/ui/src/period-stepper.js";

let root: Root | null = null;
let host: HTMLDivElement | null = null;

function mount(props: Partial<Parameters<typeof PeriodStepper>[0]> = {}) {
  const onPrevious = vi.fn();
  const onNext = vi.fn();
  host = document.createElement("div");
  document.body.appendChild(host);
  root = createRoot(host);
  act(() =>
    root?.render(
      <PeriodStepper
        label="October 2026"
        previousLabel="September 2026"
        nextLabel="November 2026"
        onPrevious={onPrevious}
        onNext={onNext}
        {...props}
      />
    )
  );
  return { onPrevious, onNext };
}

afterEach(() => {
  act(() => root?.unmount());
  host?.remove();
  root = null;
  host = null;
});

const button = (name: string) =>
  document.querySelector<HTMLButtonElement>(`button[aria-label="${name}"]`)!;

describe("PeriodStepper", () => {
  it("names each arrow by the period it opens and steps on click", () => {
    const { onPrevious, onNext } = mount();
    expect(document.querySelector(".jds-stepper__label")?.textContent).toBe("October 2026");
    act(() => button("September 2026").click());
    act(() => button("November 2026").click());
    expect(onPrevious).toHaveBeenCalledTimes(1);
    expect(onNext).toHaveBeenCalledTimes(1);
  });

  it("disables both arrows together", () => {
    const { onPrevious } = mount({ disabled: true });
    expect(button("September 2026").disabled).toBe(true);
    expect(button("November 2026").disabled).toBe(true);
    act(() => button("September 2026").click());
    expect(onPrevious).not.toHaveBeenCalled();
  });
});
