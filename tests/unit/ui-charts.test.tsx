// @vitest-environment jsdom
import { act, type ReactElement } from "react";
import { createRoot, type Root } from "react-dom/client";
import { afterEach, describe, expect, it } from "vitest";

import { niceTicks } from "../../packages/ui/src/chart-parts.js";
import { ColumnChart } from "../../packages/ui/src/column-chart.js";
import { TrendChart } from "../../packages/ui/src/trend-chart.js";

let root: Root | null = null;
let host: HTMLDivElement | null = null;

function mount(element: ReactElement) {
  host = document.createElement("div");
  document.body.appendChild(host);
  root = createRoot(host);
  act(() => root?.render(element));
}

afterEach(() => {
  act(() => root?.unmount());
  host?.remove();
  root = null;
  host = null;
});

const dollars = (value: number) => (value < 0 ? `-$${-value}` : `$${value}`);
const plot = () => document.querySelector<HTMLElement>(".jds-chart__plot")!;
const spoken = () => document.querySelector(".jds-sr-only")?.textContent ?? "";
const press = (key: string) =>
  act(() => {
    plot().dispatchEvent(new KeyboardEvent("keydown", { key, bubbles: true }));
  });

describe("niceTicks", () => {
  it("steps by 1, 2 or 5 times a power of ten and covers the range", () => {
    expect(niceTicks(0, 1234)).toEqual([0, 500, 1000, 1500]);
    expect(niceTicks(-300, 900)).toEqual([-500, 0, 500, 1000]);
    expect(niceTicks(0, 0.8)).toEqual([0, 0.2, 0.4, 0.6, 0.8]);
  });

  it("returns one tick for a flat range", () => {
    expect(niceTicks(5, 5)).toEqual([5]);
  });
});

describe("ColumnChart", () => {
  const chart = (
    <ColumnChart
      label="Cash flow by month"
      categories={["Aug", "Sep", "Oct"]}
      categoryNames={["August 2026", "September 2026", "October 2026"]}
      series={[
        { key: "in", label: "Income", values: [1000, 2000, 0], total: "$3000" },
        { key: "out", label: "Outflow", values: [500, 1500, 300], total: "$2300" }
      ]}
      marker={{ label: "Net", values: [500, 500, -300], total: "$700" }}
      format={dollars}
    />
  );

  it("shows each series and the marker in the legend with its total", () => {
    mount(chart);
    const items = [...document.querySelectorAll(".jds-chart__legend-item")].map(
      (item) => item.textContent
    );
    expect(items).toEqual(["Income$3000", "Outflow$2300", "Net$700"]);
  });

  it("draws bars from the zero line and puts a negative marker below it", () => {
    mount(chart);
    // Ticks run -1000..2000, so zero sits a third of the way up.
    const cols = document.querySelectorAll(".jds-chart__col");
    const september = cols[1]!.querySelectorAll<HTMLElement>(".jds-chart__bar");
    expect(september[0]!.style.bottom).toBe("33.33333333333333%");
    expect(september[0]!.style.height).toBe("max(2px, 66.66666666666667%)");
    const october = cols[2]!.querySelectorAll<HTMLElement>(".jds-chart__bar");
    expect(october[0]!.style.height).toBe("0px");
    const dot = cols[2]!.querySelector<HTMLElement>(".jds-chart__dot")!;
    expect(Number.parseFloat(dot.style.bottom)).toBeLessThan(33.34);
    expect(document.querySelector(".jds-chart__grid--zero")).not.toBeNull();
  });

  it("reads out the latest month on focus and steps with the arrow keys", () => {
    mount(chart);
    expect(spoken()).toBe("");
    act(() => plot().focus());
    expect(spoken()).toBe("October 2026, Income $0, Outflow $300, Net -$300");
    expect(document.querySelector(".jds-chart__col.is-active")).toBe(
      document.querySelectorAll(".jds-chart__col")[2]
    );
    press("ArrowLeft");
    expect(spoken()).toBe("September 2026, Income $2000, Outflow $1500, Net $500");
    press("Home");
    expect(spoken()).toMatch(/^August 2026/);
    press("ArrowLeft");
    expect(spoken()).toMatch(/^August 2026/);
    press("End");
    expect(spoken()).toMatch(/^October 2026/);
    press("Escape");
    expect(spoken()).toBe("");
    expect(document.querySelector(".jds-chart__tip")).toBeNull();
  });

  it("clears the readout when focus leaves the plot", () => {
    mount(chart);
    act(() => plot().focus());
    expect(document.querySelector(".jds-chart__tip")).not.toBeNull();
    act(() => plot().blur());
    expect(document.querySelector(".jds-chart__tip")).toBeNull();
  });
});

describe("TrendChart", () => {
  const day = 86_400_000;
  const points = [
    { at: 0, value: 1000, name: "July 1" },
    { at: 10 * day, value: 1050, name: "July 11" },
    { at: 30 * day, value: 1100, name: "July 31" }
  ];

  it("spaces points by time and leaves zero off a range far from it", () => {
    mount(<TrendChart label="Net worth" points={points} format={dollars} />);
    const line = document.querySelector(".jds-chart__line")!.getAttribute("d")!;
    expect(line.startsWith("M0.000,")).toBe(true);
    expect(line).toContain("L33.333,");
    expect(line).toContain("L100.000,");
    const ticks = [...document.querySelectorAll(".jds-chart__tick")].map(
      (tick) => tick.textContent
    );
    expect(ticks).not.toContain("$0");
    expect(ticks[0]).toBe("$1000");
  });

  it("keeps zero on the axis when the values sit near it", () => {
    mount(
      <TrendChart
        label="Net worth"
        points={[
          { at: 0, value: 200, name: "July 1" },
          { at: day, value: 900, name: "July 2" }
        ]}
        format={dollars}
      />
    );
    expect(document.querySelector(".jds-chart__grid--zero")).not.toBeNull();
  });

  it("reads out the latest point on focus and steps back with the arrow keys", () => {
    mount(
      <TrendChart
        label="Net worth"
        points={points}
        format={dollars}
        startLabel="Jul 1"
        endLabel="Jul 31"
      />
    );
    expect(document.querySelector(".jds-chart__x--ends")?.textContent).toBe("Jul 1Jul 31");
    act(() => plot().focus());
    expect(spoken()).toBe("July 31, Net worth $1100");
    press("ArrowLeft");
    expect(spoken()).toBe("July 11, Net worth $1050");
    expect(document.querySelector<HTMLElement>(".jds-chart__cross")?.style.left).toBe(
      `${(10 / 30) * 100}%`
    );
  });

  it("draws nothing to focus when there are no points", () => {
    mount(<TrendChart label="Net worth" points={[]} format={dollars} />);
    expect(plot().tabIndex).toBe(-1);
    expect(document.querySelector(".jds-chart__svg")).toBeNull();
    expect(document.querySelector(".jds-chart__dot")).toBeNull();
  });
});
