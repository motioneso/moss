// @vitest-environment jsdom
import "./helpers/install-module-runtime";
import { createElement } from "react";
import { act, create, type ReactTestRenderer } from "react-test-renderer";
import { afterEach, describe, expect, it, vi } from "vitest";
import type { ModuleToolOutcome } from "@moss/module-web-sdk";
import { dayYearLabel } from "../../external-modules/finance/src/web/format";
import { ImportDialog } from "../../external-modules/finance/src/web/import-dialog";
let rendered: ReactTestRenderer | undefined;
afterEach(async () => {
  if (rendered) await act(async () => rendered!.unmount());
  rendered = undefined;
});
const preview: ModuleToolOutcome = {
  status: "succeeded",
  result: {
    status: "ok",
    view: {
      accountId: "cash",
      isoCurrency: "USD",
      openingDate: "2026-10-01",
      lastReconciledDate: null,
      revision: 3,
      balanceCents: 1000,
      debt: false,
      duplicateRows: [1]
    }
  }
};
async function form(outcome: ModuleToolOutcome, previewOutcome: ModuleToolOutcome = preview) {
  const invoke = vi.fn(async (name: string, _input: Record<string, unknown>) =>
    name === "finance.import.preview" ? previewOutcome : outcome
  );
  const onSaved = vi.fn();
  await act(async () => {
    rendered = create(
      createElement(ImportDialog, {
        tools: { invoke },
        account: { accountId: "cash", name: "Synthetic cash", isoCurrency: "USD", type: "other" },
        onClose: vi.fn(),
        onSaved
      })
    );
  });
  const field = (label: string) => rendered!.root.findByProps({ "aria-label": label });
  const button = (label: string) =>
    rendered!.root.findAllByType("button").find((b) => b.children.includes(label))!;
  const choose = (label: string, value: string) =>
    act(async () => field(label).props.onChange({ target: { value } }));
  const load = async () => {
    await act(async () =>
      field("CSV file").props.onChange({
        target: {
          files: [
            {
              size: 70,
              arrayBuffer: async () =>
                new TextEncoder().encode("Date,Payee,Amount\n2026-10-02,Synthetic,1.23").buffer
            }
          ]
        }
      })
    );
    for (const [label, value] of [
      ["Date column", "0"],
      ["Payee column", "1"],
      ["Amount column", "2"],
      ["Date format", "iso"],
      ["Amount meaning", "positive-out"]
    ])
      await choose(label!, value!);
    await act(async () => button("Preview import").props.onClick());
  };
  return { invoke, onSaved, field, button, choose, load };
}
describe("CSV review form", () => {
  it("requires explicit mapping and duplicate decisions before saving", async () => {
    const f = await form({ status: "succeeded", result: { status: "ok" } });
    expect(f.button("Preview import").props.disabled).toBe(true);
    await f.load();
    expect(f.button("Import 1 transaction").props.disabled).toBe(true);
    await f.choose("Duplicate decision for row 1", "skip");
    expect(f.button("Import 0 transactions").props.disabled).toBe(true);
    await f.choose("Duplicate decision for row 1", "import");
    await act(async () => f.button("Import 1 transaction").props.onClick());
    expect(f.invoke).toHaveBeenLastCalledWith(
      "finance.import.apply",
      expect.objectContaining({
        expectedRevision: 3,
        rows: [expect.objectContaining({ sourceRow: 1, amountCents: 123, allowDuplicate: true })]
      })
    );
    expect(f.onSaved).toHaveBeenCalledOnce();
  });
  it("clears the file picker after every pick so the same file can be chosen again", async () => {
    const f = await form({ status: "succeeded", result: { status: "ok" } });
    const bad = {
      value: "C:\\fakepath\\bank.csv",
      files: [{ size: 1, arrayBuffer: async () => new Uint8Array([0xff]).buffer }]
    };
    await act(async () => f.field("CSV file").props.onChange({ target: bad }));
    expect(JSON.stringify(rendered!.toJSON())).toContain("Save the CSV as UTF-8");
    expect(bad.value).toBe("");
    expect(() => f.field("Date column")).toThrow();
    const fixed = {
      value: "C:\\fakepath\\bank.csv",
      files: [
        {
          size: 70,
          arrayBuffer: async () =>
            new TextEncoder().encode("Date,Payee,Amount\n2026-10-02,Synthetic,1.23").buffer
        }
      ]
    };
    await act(async () => f.field("CSV file").props.onChange({ target: fixed }));
    expect(fixed.value).toBe("");
    expect(f.field("Date column")).toBeDefined();
    expect(JSON.stringify(rendered!.toJSON())).not.toContain("Save the CSV as UTF-8");
  });
  it("reports counts and readable dates without explanatory captions", async () => {
    const f = await form({ status: "succeeded", result: { status: "ok" } });
    await act(async () =>
      f.field("CSV file").props.onChange({
        target: {
          files: [
            {
              size: 70,
              arrayBuffer: async () =>
                new TextEncoder().encode("Date,Payee,Amount\n2026-10-02,Synthetic,1.23").buffer
            }
          ]
        }
      })
    );
    const mapped = JSON.stringify(rendered!.toJSON());
    expect(mapped).toContain(" data rows · ");
    for (const gone of ["Add posted transactions", "Choose how to read", "Every row uses"])
      expect(mapped).not.toContain(gone);
    await f.load();
    const reviewed = JSON.stringify(rendered!.toJSON());
    expect(reviewed).toContain("1 possible duplicate. 1 decision remaining.");
    expect(reviewed).toContain(dayYearLabel("2026-10-02", "short"));
    expect(reviewed).not.toContain("2026-10-02");
    for (const gone of ["Cleared means", "Entries begin uncategorized", "Choose Skip or Import"])
      expect(reviewed).not.toContain(gone);
    await f.choose("Duplicate decision for row 1", "skip");
    expect(JSON.stringify(rendered!.toJSON())).toContain("0 decisions remaining.");
  });
  it("explains a failed read without suggesting an import was saved", async () => {
    const f = await form({ status: "succeeded", result: { status: "ok" } }, { status: "failed" });
    await f.load();
    expect(JSON.stringify(rendered!.toJSON())).toContain("No entries were added");
    expect(f.invoke.mock.calls.every((call) => call[0] === "finance.import.preview")).toBe(true);
    expect(f.button("Check saved records")).toBeUndefined();
  });
  it("rejects invalid UTF-8 before preview", async () => {
    const f = await form({ status: "succeeded", result: { status: "ok" } });
    await act(async () =>
      f.field("CSV file").props.onChange({
        target: { files: [{ size: 1, arrayBuffer: async () => new Uint8Array([0xff]).buffer }] }
      })
    );
    expect(JSON.stringify(rendered!.toJSON())).toContain("Save the CSV as UTF-8");
    expect(f.invoke).not.toHaveBeenCalled();
  });
  it("keeps cancellation editable with the same operation ID and never calls it saved", async () => {
    const f = await form({ status: "cancelled" });
    await f.load();
    await f.choose("Duplicate decision for row 1", "import");
    await act(async () => f.button("Import 1 transaction").props.onClick());
    await act(async () => f.button("Import 1 transaction").props.onClick());
    const calls = f.invoke.mock.calls.filter((call) => call[0] === "finance.import.apply");
    expect(calls).toHaveLength(2);
    expect(calls[0]).toEqual(calls[1]);
    expect(f.onSaved).not.toHaveBeenCalled();
  });
  it("requires a refreshed review after a stale ledger and resets duplicate consent", async () => {
    const f = await form({ status: "rejected", moduleCode: "stale_import" });
    await f.load();
    await f.choose("Duplicate decision for row 1", "import");
    await act(async () => f.button("Import 1 transaction").props.onClick());
    expect(f.button("Import 1 transaction").props.disabled).toBe(true);
    await act(async () => f.button("Refresh preview").props.onClick());
    expect(f.field("Duplicate decision for row 1").props.value).toBe("");
    expect(f.button("Import 1 transaction").props.disabled).toBe(true);
    expect(f.onSaved).not.toHaveBeenCalled();
  });
  it("freezes ambiguous transport and offers saved records without automatic retry", async () => {
    const f = await form({ status: "failed" });
    await f.load();
    await f.choose("Duplicate decision for row 1", "import");
    await act(async () => f.button("Import 1 transaction").props.onClick());
    expect(f.field("Duplicate decision for row 1").props.disabled).toBe(true);
    expect(f.button("Check saved records")).toBeDefined();
    expect(f.invoke.mock.calls.filter((call) => call[0] === "finance.import.apply")).toHaveLength(
      1
    );
    expect(f.onSaved).not.toHaveBeenCalled();
  });
});
