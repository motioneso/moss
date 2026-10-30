import { describe, expect, it, vi } from "vitest";
import {
  accountReviewHandler,
  accountUpdateHandler
} from "../../external-modules/finance/src/worker/handlers/account-lifecycle.js";
import type { WorkerPorts } from "../../external-modules/finance/src/worker/ports.js";
const input = {
  accountId: "manual:synthetic",
  expectedRevision: "a".repeat(32),
  operation: "rename",
  name: "  Synthetic cash  "
};
function fixture() {
  const update = vi.fn(async () => true),
    review = vi.fn(async () => ({ accountId: input.accountId }));
  const ports = {
    localTimezone: "America/Los_Angeles",
    now: () => new Date("2026-10-30T00:30:00Z"),
    store: async () => ({ accountLifecycle: { update, review } })
  } as unknown as WorkerPorts;
  return { ports, update, review };
}
describe("reviewed manual account handler", () => {
  it("uses the host date and a captured version, and trims only the display name", async () => {
    const f = fixture();
    await accountUpdateHandler(f.ports)({
      ...input,
      localTimezone: "Pacific/Kiritimati",
      today: "2026-10-30"
    });
    expect(f.update).toHaveBeenCalledWith({
      accountId: input.accountId,
      expectedRevision: input.expectedRevision,
      operation: "rename",
      name: "Synthetic cash",
      today: "2026-10-29",
      at: "2026-10-30T00:30:00.000Z"
    });
    expect(await accountReviewHandler(f.ports)({ accountId: input.accountId })).toMatchObject({
      status: "ok",
      today: "2026-10-29"
    });
  });
  it.each([
    { expectedRevision: "stale" },
    { operation: "delete" },
    { name: " " },
    { name: "x".repeat(81) },
    { accountId: "x".repeat(257) },
    { operation: "close", name: "unexpected" }
  ])("rejects invalid requests before writing: %j", async (patch) => {
    const f = fixture();
    await expect(accountUpdateHandler(f.ports)({ ...input, ...patch })).rejects.toThrow();
    expect(f.update).not.toHaveBeenCalled();
  });
  it("requires a supplied timezone before mutation and reports a stale captured version", async () => {
    const f = fixture();
    f.ports.localTimezone = undefined;
    await expect(accountUpdateHandler(f.ports)(input)).rejects.toMatchObject({
      code: "timezone_required"
    });
    expect(f.update).not.toHaveBeenCalled();
    f.ports.localTimezone = "Etc/UTC";
    f.update.mockResolvedValueOnce(false);
    await expect(accountUpdateHandler(f.ports)(input)).rejects.toMatchObject({
      code: "account_changed"
    });
    expect(f.update).toHaveBeenCalledTimes(1);
  });
  it("reports unavailable owned state without disclosing another account", async () => {
    const f = fixture();
    f.review.mockResolvedValueOnce(null as never);
    expect(await accountReviewHandler(f.ports)({ accountId: input.accountId })).toEqual({
      status: "unavailable",
      today: "2026-10-29"
    });
  });
});
