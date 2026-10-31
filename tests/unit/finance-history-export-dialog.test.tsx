// @vitest-environment jsdom
import "./helpers/install-module-runtime";
import { createElement } from "react";
import { act, create, type ReactTestInstance, type ReactTestRenderer } from "react-test-renderer";
import { afterEach, describe, expect, it, vi } from "vitest";
import { invokeTool, type ToolOutcome } from "../../external-modules/finance/src/web/api";
import { dayYearLabel } from "../../external-modules/finance/src/web/format";
import { HistoryExportDialog } from "../../external-modules/finance/src/web/history-export-dialog";
vi.mock("../../external-modules/finance/src/web/api", () => ({ invokeTool: vi.fn() }));

let rendered: ReactTestRenderer | undefined;
afterEach(async () => {
  if (rendered) await act(async () => rendered!.unmount());
  rendered = undefined;
});

const textOf = (node: ReactTestInstance | string): string =>
  typeof node === "string" ? node : node.children.map(textOf).join("");
const prepareButton = () =>
  rendered!.root.findAllByType("button").find((b) => textOf(b).startsWith("Prepar"))!;
const statusText = () =>
  rendered!.root
    .findAll((n) => n.type === "p" && n.props.role === "status")
    .map(textOf)
    .join(" ");
const alertText = () =>
  rendered!.root
    .findAll((n) => n.type === "p" && n.props.role === "alert")
    .map(textOf)
    .join(" ");

async function open() {
  await act(async () => {
    rendered = create(
      createElement(HistoryExportDialog, {
        accounts: [{ accountId: "cash", name: "Synthetic cash" }],
        onClose: vi.fn()
      })
    );
  });
}
const type = (index: number, value: string) =>
  act(async () =>
    rendered!.root.findAllByType("input")[index]!.props.onChange({ currentTarget: { value } })
  );
const prepare = () => act(async () => prepareButton().props.onClick());

describe("transaction history export dialog", () => {
  it("opens on the controls without explanatory lines", async () => {
    await open();
    const text = JSON.stringify(rendered!.toJSON());
    for (const gone of ["Download your stored", "Leave dates empty", "Household entries"])
      expect(text).not.toContain(gone);
    expect(text).toContain("Export account");
  });

  it("states the ready range with readable dates and nothing else", async () => {
    vi.mocked(invokeTool)
      .mockReset()
      .mockResolvedValue({
        kind: "ok",
        result: {
          status: "ready",
          csv: "date,payee\n",
          totalCount: 2,
          preparedAt: "2026-10-31T14:03:00.000Z"
        }
      });
    await open();
    await type(0, "2026-10-01");
    await type(1, "2026-10-31");
    await prepare();
    const ready = statusText();
    expect(ready).toContain("2 transactions ready.");
    expect(ready).toContain(dayYearLabel("2026-10-01", "short"));
    expect(ready).toContain(dayYearLabel("2026-10-31", "short"));
    expect(ready).not.toContain("2026-10");
    const text = JSON.stringify(rendered!.toJSON());
    for (const gone of ["Prepared at", "Changes made afterward", "Download the CSV when"])
      expect(text).not.toContain(gone);
  });

  it("names the open ends of the range when no dates are chosen", async () => {
    vi.mocked(invokeTool)
      .mockReset()
      .mockResolvedValue({
        kind: "ok",
        result: { status: "ready", csv: "date,payee\n", totalCount: 0 }
      });
    await open();
    await prepare();
    expect(statusText()).toContain("Beginning of history through Latest stored date.");
    expect(JSON.stringify(rendered!.toJSON())).not.toContain("column headings only");
  });

  it("reports progress without a reassurance line", async () => {
    let finish!: (value: ToolOutcome<Record<string, unknown>>) => void;
    vi.mocked(invokeTool)
      .mockReset()
      .mockReturnValue(
        new Promise<ToolOutcome<Record<string, unknown>>>((resolve) => {
          finish = resolve;
        })
      );
    await open();
    await prepare();
    expect(statusText()).toBe("Reading matching records.");
    await act(async () => finish({ kind: "error", message: "stop" }));
  });

  it("puts the row and size limits in the error when a file would exceed them", async () => {
    vi.mocked(invokeTool)
      .mockReset()
      .mockResolvedValue({ kind: "ok", result: { status: "too_many", totalCount: 6000 } });
    await open();
    await prepare();
    expect(alertText()).toContain("at most 5,000 rows");
    vi.mocked(invokeTool).mockResolvedValue({ kind: "ok", result: { status: "too_large" } });
    await prepare();
    expect(alertText()).toContain("2 MiB");
  });
});
