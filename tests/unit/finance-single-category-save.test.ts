import { describe, expect, it, vi } from "vitest";
import type { ExternalModuleToolsHandleV1, ModuleToolOutcome } from "@moss/module-web-sdk";
import { saveSingleCategory } from "../../external-modules/finance/src/web/transaction-single.js";

const row = { id: "synthetic", writeRevision: "a".repeat(32), extra: "dropped" };
const tools = (outcome: ModuleToolOutcome | Error) =>
  ({
    invoke: vi.fn(async () => {
      if (outcome instanceof Error) throw outcome;
      return outcome;
    })
  }) as unknown as ExternalModuleToolsHandleV1 & { invoke: ReturnType<typeof vi.fn> };

describe("saving one category directly", () => {
  it("changes the category with one call carrying only the id and revision", async () => {
    const handle = tools({ status: "succeeded", result: { status: "ok" } });
    await expect(saveSingleCategory(handle, row, "dining", false)).resolves.toBe("saved");
    expect(handle.invoke).toHaveBeenCalledOnce();
    expect(handle.invoke).toHaveBeenCalledWith("finance.transactions.bulk-category", {
      categoryId: "dining",
      rows: [{ id: "synthetic", writeRevision: "a".repeat(32) }]
    });
  });

  it("confirms the existing category without sending a category", async () => {
    const handle = tools({ status: "succeeded", result: { status: "ok" } });
    await expect(saveSingleCategory(handle, row, "dining", true)).resolves.toBe("saved");
    expect(handle.invoke).toHaveBeenCalledWith("finance.transactions.confirm", {
      rows: [{ id: "synthetic", writeRevision: "a".repeat(32) }]
    });
  });

  it.each([
    [{ status: "cancelled" }, "cancelled"],
    [{ status: "rejected", moduleCode: "stale_transactions" }, "stale"],
    [{ status: "rejected", moduleCode: "invalid_category" }, "refused"],
    [{ status: "failed" }, "uncertain"],
    [{ status: "succeeded", result: { status: "error" } }, "uncertain"]
  ] as const)("reports %j as %s", async (outcome, expected) => {
    const handle = tools(outcome as unknown as ModuleToolOutcome);
    await expect(saveSingleCategory(handle, row, "dining", false)).resolves.toBe(expected);
  });

  it("treats a thrown call as unconfirmed", async () => {
    const handle = tools(new Error("network"));
    await expect(saveSingleCategory(handle, row, "dining", false)).resolves.toBe("uncertain");
  });
});
