// @vitest-environment jsdom
import "./helpers/install-module-runtime";
import { createElement } from "react";
import { act, create, type ReactTestRenderer } from "react-test-renderer";
import { describe, it, expect, vi } from "vitest";
import type { ExternalModuleToolsHandleV1, ModuleToolOutcome } from "@moss/module-web-sdk";
import {
  TargetFundingDialog,
  type TargetFundingView
} from "../../external-modules/finance/src/web/target-funding-dialog";
const data: TargetFundingView = {
  month: "2026-10",
  currency: "USD",
  revision: 4,
  fingerprint: "a".repeat(32),
  readyCents: 10000,
  lines: [
    {
      categoryId: "a",
      name: "Monthly",
      kind: "monthly",
      dueDate: null,
      previousCents: 100,
      amountCents: 3000,
      newAssignedCents: 3100,
      unavailableReason: null
    },
    {
      categoryId: "b",
      name: "Dated",
      kind: "balance",
      dueDate: "2026-12-31",
      previousCents: 5000,
      amountCents: 2000,
      newAssignedCents: 7000,
      unavailableReason: null
    }
  ]
};
async function render(invoke: ExternalModuleToolsHandleV1["invoke"], view = data) {
  let renderer!: ReactTestRenderer;
  const props = {
    data: view,
    tools: { invoke },
    onClose: vi.fn(),
    onUncertain: vi.fn(),
    onSaved: vi.fn()
  };
  await act(async () => {
    renderer = create(createElement(TargetFundingDialog, props));
  });
  return { renderer, props };
}
const button = (r: ReactTestRenderer, name: string) =>
  r.root.findAllByType("button").find((b) => b.children.includes(name))!;
async function select(r: ReactTestRenderer, name: string, checked = true) {
  await act(async () =>
    r.root.findByProps({ "aria-label": `Fund ${name}` }).props.onChange({ target: { checked } })
  );
}
async function review(r: ReactTestRenderer) {
  await select(r, "Monthly");
  await select(r, "Dated");
  await act(async () => button(r, "Review selected amounts").props.onClick());
}
describe("captured selected target funding", () => {
  it("starts with no selected target and prepares no action before review", async () => {
    const invoke = vi.fn(async (): Promise<ModuleToolOutcome> => ({ status: "cancelled" }));
    const { renderer } = await render(invoke);
    expect(button(renderer, "Review selected amounts").props.disabled).toBe(true);
    await act(async () => button(renderer, "Review selected amounts").props.onClick());
    expect(invoke).not.toHaveBeenCalled();
    await select(renderer, "Monthly");
    expect(button(renderer, "Review selected amounts").props.disabled).toBe(false);
    expect(invoke).not.toHaveBeenCalled();
  });
  it("captures original cents, selection and budget review across a host cancellation and rerender", async () => {
    const invoke = vi.fn(async (): Promise<ModuleToolOutcome> => ({ status: "cancelled" }));
    const { renderer, props } = await render(invoke);
    await review(renderer);
    await act(async () =>
      renderer.update(
        createElement(TargetFundingDialog, {
          ...props,
          data: { ...data, revision: 9, fingerprint: "b".repeat(32), readyCents: 0 }
        })
      )
    );
    await act(async () => button(renderer, "Confirm target assignments").props.onClick());
    expect(invoke).toHaveBeenCalledWith("finance.targets.fund", {
      month: "2026-10",
      categoryIds: ["a", "b"],
      expectedAmountsCents: [3000, 2000],
      expectedRevision: 4,
      expectedFingerprint: "a".repeat(32)
    });
    expect(props.onClose).not.toHaveBeenCalled();
    expect(props.onUncertain).not.toHaveBeenCalled();
    await act(async () => button(renderer, "Confirm target assignments").props.onClick());
    expect(invoke.mock.calls[1]).toEqual(invoke.mock.calls[0]);
  });
  it("blocks uncertain outcomes and repeated submission until a fresh parent workflow", async () => {
    const invoke = vi.fn(async (): Promise<ModuleToolOutcome> => ({ status: "failed" }));
    const { renderer, props } = await render(invoke);
    await review(renderer);
    await act(async () => button(renderer, "Confirm target assignments").props.onClick());
    expect(button(renderer, "Confirm target assignments").props.disabled).toBe(true);
    await act(async () => button(renderer, "Confirm target assignments").props.onClick());
    expect(invoke).toHaveBeenCalledOnce();
    expect(props.onUncertain).toHaveBeenCalledOnce();
    expect(props.onClose).not.toHaveBeenCalled();
  });
  it("rejects an unaffordable selection locally without silently reducing it", async () => {
    const invoke = vi.fn(async (): Promise<ModuleToolOutcome> => ({ status: "cancelled" }));
    const { renderer } = await render(invoke, { ...data, readyCents: 4000 });
    await select(renderer, "Monthly");
    await select(renderer, "Dated");
    expect(button(renderer, "Review selected amounts").props.disabled).toBe(true);
    await act(async () => button(renderer, "Review selected amounts").props.onClick());
    expect(invoke).not.toHaveBeenCalled();
    expect(renderer.root.findByProps({ "aria-label": "Fund Monthly" }).props.checked).toBe(true);
    expect(renderer.root.findByProps({ "aria-label": "Fund Dated" }).props.checked).toBe(true);
    await select(renderer, "Dated", false);
    expect(button(renderer, "Review selected amounts").props.disabled).toBe(false);
  });
  it("suppresses duplicate action and dismissal immediately while saving", async () => {
    let resolve!: (result: ModuleToolOutcome) => void;
    const invoke = vi.fn(
      () =>
        new Promise<ModuleToolOutcome>((done) => {
          resolve = done;
        })
    );
    const { renderer, props } = await render(invoke);
    await review(renderer);
    const save = button(renderer, "Confirm target assignments").props.onClick,
      cancel = button(renderer, "Cancel").props.onClick;
    await act(async () => {
      void save();
      void save();
      cancel();
    });
    expect(invoke).toHaveBeenCalledOnce();
    expect(props.onClose).not.toHaveBeenCalled();
    await act(async () => resolve({ status: "succeeded", result: { status: "ok" } }));
    expect(props.onClose).toHaveBeenCalledOnce();
    expect(props.onSaved).toHaveBeenCalledWith(data.fingerprint);
  });
  it("preserves selection when editing a captured review", async () => {
    const invoke = vi.fn(async (): Promise<ModuleToolOutcome> => ({ status: "cancelled" }));
    const { renderer } = await render(invoke);
    await review(renderer);
    await act(async () => button(renderer, "Edit selection").props.onClick());
    expect(renderer.root.findByProps({ "aria-label": "Fund Monthly" }).props.checked).toBe(true);
    expect(renderer.root.findByProps({ "aria-label": "Fund Dated" }).props.checked).toBe(true);
    expect(invoke).not.toHaveBeenCalled();
  });
});
