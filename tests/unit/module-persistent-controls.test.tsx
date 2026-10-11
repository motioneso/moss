// @vitest-environment jsdom
import { act, useState } from "react";
import { createRoot, type Root } from "react-dom/client";
import { MemoryRouter, useNavigate } from "react-router";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { ModulePersistentControls } from "../../apps/web/src/shell/module-persistent-controls.js";

const loaders = vi.hoisted(() => ({
  news: vi.fn(),
  sports: vi.fn(),
  meetings: vi.fn(),
  controls: vi.fn(),
  secondaryControls: vi.fn()
}));
vi.mock("virtual:moss-module-web", () => ({
  MODULE_WEB_CONTRIBUTIONS: [
    { moduleId: "news", load: loaders.news },
    { moduleId: "sports", load: loaders.sports },
    { moduleId: "meetings", load: loaders.meetings }
  ],
  MODULE_PERSISTENT_CONTROLS: [
    { moduleId: "meetings", load: loaders.controls },
    { moduleId: "secondary", load: loaders.secondaryControls }
  ]
}));

let root: Root;
let host: HTMLDivElement;
function StatefulControls() {
  const [paused, setPaused] = useState(false);
  return <button onClick={() => setPaused(true)}>{paused ? "Paused" : "Pause"}</button>;
}
function Shell({ disabled = ["secondary"] }: { readonly disabled?: readonly string[] }) {
  const navigate = useNavigate();
  return (
    <>
      <button onClick={() => navigate("/settings")}>Navigate</button>
      <ModulePersistentControls disabledModuleIds={disabled} />
    </>
  );
}
async function render(disabled?: readonly string[]) {
  await act(async () =>
    root.render(
      <MemoryRouter>
        <Shell disabled={disabled} />
      </MemoryRouter>
    )
  );
}
async function click(text: string) {
  const button = [...host.querySelectorAll("button")].find((item) => item.textContent === text);
  expect(button).toBeDefined();
  await act(async () => button!.click());
}
function expectNoScreenLoads() {
  expect(loaders.news).not.toHaveBeenCalled();
  expect(loaders.sports).not.toHaveBeenCalled();
  expect(loaders.meetings).not.toHaveBeenCalled();
}
beforeEach(() => {
  vi.stubGlobal("IS_REACT_ACT_ENVIRONMENT", true);
  vi.resetAllMocks();
  for (const name of ["news", "sports", "meetings"] as const)
    loaders[name].mockResolvedValue({ default: { moduleId: name } });
  loaders.controls.mockResolvedValue({
    default: { moduleId: "meetings", element: <StatefulControls /> }
  });
  loaders.secondaryControls.mockResolvedValue({
    default: { moduleId: "secondary", element: <p>Other controls</p> }
  });
  host = document.createElement("div");
  document.body.append(host);
  root = createRoot(host);
});
afterEach(async () => {
  await act(async () => root.unmount());
  host.remove();
  vi.restoreAllMocks();
  vi.unstubAllGlobals();
});

describe("dedicated module persistent controls", () => {
  it("loads only declared enabled controls and keeps them mounted across navigation", async () => {
    await render();
    expectNoScreenLoads();
    expect(loaders.controls).toHaveBeenCalledTimes(1);
    expect(loaders.secondaryControls).not.toHaveBeenCalled();
    await click("Pause");
    await click("Navigate");
    expect(host.textContent).toContain("Paused");
    expect(loaders.controls).toHaveBeenCalledTimes(1);
    expectNoScreenLoads();
  });
  it("does not load disabled modules and removes their mounted controls when disabled", async () => {
    await render(["meetings", "secondary"]);
    expect(loaders.controls).not.toHaveBeenCalled();
    expect(loaders.secondaryControls).not.toHaveBeenCalled();
    await render();
    expect(host.textContent).toContain("Pause");
    await render(["meetings", "secondary"]);
    expect(host.textContent).not.toContain("Pause");
    expectNoScreenLoads();
  });
  it("isolates a failed controls import and retries with a fresh lazy loader", async () => {
    vi.spyOn(console, "error").mockImplementation(() => {});
    loaders.controls.mockRejectedValueOnce(new Error("controls chunk unavailable"));
    await render([]);
    expect(host.querySelector('[role="alert"]')?.textContent).toContain(
      "Use Trail Marker’s local Stop"
    );
    expect(host.textContent).toContain("Other controls");
    expect(loaders.controls).toHaveBeenCalledTimes(1);
    await click("Retry controls");
    expect(host.querySelector('[role="alert"]')).toBeNull();
    expect(host.textContent).toContain("Pause");
    expect(loaders.controls).toHaveBeenCalledTimes(2);
    expect(loaders.secondaryControls).toHaveBeenCalledTimes(1);
    expectNoScreenLoads();
  });
});
