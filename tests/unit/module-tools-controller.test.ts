import { afterEach, describe, expect, it, vi } from "vitest";
import { createModuleToolsController } from "../../apps/web/src/external-modules/tool-controller.js";

const id = "00000000-0000-4000-8000-000000000001";
const success = () =>
  new Response(JSON.stringify({ invocation: { status: "succeeded", result: { saved: true } } }), {
    status: 200
  });
function pending(overrides: Record<string, unknown> = {}) {
  return new Response(
    JSON.stringify({
      invocation: { status: "blocked", reason: "confirmation_required" },
      confirmation: {
        id,
        expiresAt: new Date(Date.now() + 120_000).toISOString(),
        moduleName: "Synthetic Finance",
        actionLabel: "Remove a synthetic entry",
        risk: "destructive",
        inputSummary: { inputKeys: ["id"] },
        ...overrides
      }
    }),
    { status: 409 }
  );
}
const active: Array<ReturnType<typeof createModuleToolsController>> = [];
function controller(request: typeof fetch) {
  const c = createModuleToolsController("finance", request);
  active.push(c);
  return c;
}
afterEach(() => {
  active.forEach((c) => c.dispose());
  active.length = 0;
  vi.useRealTimers();
});
const payload = (request: ReturnType<typeof vi.fn<typeof fetch>>, index: number) =>
  JSON.parse(String(request.mock.calls[index]?.[1]?.body));

describe("module page host bridge (explicit HTTP stand-ins)", () => {
  it("binds the module path, sends credentials and awaits a direct result exactly once", async () => {
    const request = vi.fn<typeof fetch>().mockResolvedValue(success());
    const c = controller(request);
    expect(await c.handle.invoke("finance.save", { id: "synthetic" })).toEqual({
      status: "succeeded",
      result: { saved: true }
    });
    expect(request).toHaveBeenCalledTimes(1);
    expect(request.mock.calls[0]?.[0]).toBe("/api/modules/finance/tools/finance.save/invoke");
    expect(request.mock.calls[0]?.[1]?.credentials).toBe("include");
    expect(payload(request, 0)).toEqual({ input: { id: "synthetic" } });
    expect(c.getSnapshot()).toBeNull();
  });

  it("holds a destructive request for host confirmation and retries an immutable input snapshot once", async () => {
    const request = vi
      .fn<typeof fetch>()
      .mockResolvedValueOnce(pending())
      .mockResolvedValueOnce(success());
    const c = controller(request);
    const input = { id: "synthetic", nested: { values: [1, 2] } };
    const outcome = c.handle.invoke("finance.delete", input);
    await vi.waitFor(() => expect(c.getSnapshot()?.kind).toBe("confirmation"));
    input.id = "different";
    input.nested.values.push(3);
    expect(request).toHaveBeenCalledTimes(1);
    expect(await c.handle.invoke("finance.save", {})).toEqual({ status: "failed" });
    expect(request).toHaveBeenCalledTimes(1);
    c.decide(true);
    c.decide(true);
    expect(await outcome).toMatchObject({ status: "succeeded" });
    expect(request).toHaveBeenCalledTimes(2);
    expect(payload(request, 1)).toEqual({
      input: { id: "synthetic", nested: { values: [1, 2] } },
      confirmationId: id
    });
  });

  it("cancels through the existing owner route and never resubmits tool input", async () => {
    const request = vi
      .fn<typeof fetch>()
      .mockResolvedValueOnce(pending())
      .mockResolvedValueOnce(new Response("{}", { status: 200 }));
    const c = controller(request);
    const outcome = c.handle.invoke("finance.delete", { id: "synthetic" });
    await vi.waitFor(() => expect(c.getSnapshot()?.kind).toBe("confirmation"));
    c.decide(false);
    expect(await outcome).toEqual({ status: "cancelled" });
    expect(request).toHaveBeenCalledTimes(2);
    expect(request.mock.calls[1]?.[0]).toBe(`/api/ai/assistant-actions/${id}/resolve`);
    expect(payload(request, 1)).toEqual({ status: "cancelled" });
  });

  it.each([
    null,
    [],
    { invocation: { status: "succeeded", result: [] } },
    { invocation: { status: "pending", result: {} } }
  ])("never treats malformed success data as a save (%j)", async (body) => {
    const request = vi
      .fn<typeof fetch>()
      .mockResolvedValue(new Response(JSON.stringify(body), { status: 200 }));
    const c = controller(request);
    expect(await c.handle.invoke("finance.save", {})).toEqual({ status: "failed" });
    expect(c.getSnapshot()).toMatchObject({
      kind: "notice",
      message: expect.stringContaining("check whether the change saved")
    });
    expect(request).toHaveBeenCalledTimes(1);
  });

  it.each([400, 401, 403, 404, 413, 429, 503])(
    "handles HTTP %s without replaying a possible write",
    async (status) => {
      const request = vi
        .fn<typeof fetch>()
        .mockResolvedValue(
          new Response(JSON.stringify({ error: "PRIVATE-SYNTHETIC-ERROR" }), { status })
        );
      const c = controller(request);
      expect(await c.handle.invoke("finance.save", {})).toEqual({
        status: status === 400 ? "invalid_input" : "failed"
      });
      expect(request).toHaveBeenCalledTimes(1);
      expect(JSON.stringify(c.getSnapshot())).not.toContain("PRIVATE-SYNTHETIC-ERROR");
    }
  );

  it("does not open a confirmation for invalid or already expired metadata", async () => {
    for (const overrides of [
      { id: "not-an-id" },
      { actionLabel: "x".repeat(241) },
      { risk: "read" },
      { expiresAt: "not-a-date" },
      { expiresAt: "2000-01-01T00:00:00Z" }
    ]) {
      const request = vi
        .fn<typeof fetch>()
        .mockResolvedValueOnce(pending(overrides))
        .mockResolvedValue(new Response("{}"));
      const c = controller(request);
      expect(await c.handle.invoke("finance.delete", {})).toEqual({ status: "failed" });
      expect(c.getSnapshot()?.kind).toBe("notice");
      expect(request.mock.calls.filter(([path]) => String(path).endsWith("/invoke"))).toHaveLength(
        1
      );
    }
  });

  it("does not loop if the confirmed request expires or asks again", async () => {
    for (const second of [
      new Response(JSON.stringify({ code: "confirmation_invalid" }), { status: 409 }),
      pending()
    ]) {
      const request = vi
        .fn<typeof fetch>()
        .mockResolvedValueOnce(pending())
        .mockResolvedValueOnce(second);
      const c = controller(request);
      const outcome = c.handle.invoke("finance.delete", {});
      await vi.waitFor(() => expect(c.getSnapshot()?.kind).toBe("confirmation"));
      c.decide(true);
      expect(await outcome).toEqual({ status: "failed" });
      expect(request).toHaveBeenCalledTimes(2);
    }
  });

  it("limits rejection output to identifier codes and never presents module text", async () => {
    for (const code of ["finance.duplicate", "PRIVATE SYNTHETIC TEXT"]) {
      const request = vi.fn<typeof fetch>().mockResolvedValue(
        new Response(JSON.stringify({ code: "module_rejected", moduleCode: code }), {
          status: 422
        })
      );
      const c = controller(request);
      expect(await c.handle.invoke("finance.save", {})).toEqual({
        status: "rejected",
        ...(code === "finance.duplicate" ? { moduleCode: code } : {})
      });
    }
  });

  it("fails uncertain network outcomes once, retaining no raw exception", async () => {
    const request = vi
      .fn<typeof fetch>()
      .mockRejectedValue(new Error("PRIVATE-SYNTHETIC-TRANSPORT"));
    const c = controller(request);
    expect(await c.handle.invoke("finance.save", {})).toEqual({ status: "failed" });
    expect(request).toHaveBeenCalledTimes(1);
    expect(JSON.stringify(c.getSnapshot())).not.toContain("PRIVATE-SYNTHETIC-TRANSPORT");
  });

  it("invalidates an open decision when its module/actor unmounts", async () => {
    const request = vi
      .fn<typeof fetch>()
      .mockResolvedValueOnce(pending())
      .mockResolvedValue(new Response("{}"));
    const c = controller(request);
    const outcome = c.handle.invoke("finance.delete", {});
    await vi.waitFor(() => expect(c.getSnapshot()?.kind).toBe("confirmation"));
    c.dispose();
    c.decide(true);
    expect(await outcome).toEqual({ status: "cancelled" });
    expect(await c.handle.invoke("finance.save", {})).toEqual({ status: "failed" });
    expect(request.mock.calls.filter(([path]) => String(path).endsWith("/invoke"))).toHaveLength(1);
  });

  it("discards late results after unmount and cannot reopen a decision", async () => {
    let resolve!: (value: Response) => void;
    const request = vi
      .fn<typeof fetch>()
      .mockImplementationOnce(
        () =>
          new Promise<Response>((done) => {
            resolve = done;
          })
      )
      .mockResolvedValue(new Response("{}"));
    const c = controller(request);
    const outcome = c.handle.invoke("finance.delete", {});
    c.dispose();
    c.activate();
    resolve(pending());
    expect(await outcome).toEqual({ status: "failed" });
    expect(c.getSnapshot()).toBeNull();
    expect(request.mock.calls.filter(([path]) => String(path).endsWith("/invoke"))).toHaveLength(1);
  });

  it("refuses non-JSON or overlarge input before any HTTP call", async () => {
    const request = vi.fn<typeof fetch>();
    const c = controller(request);
    for (const value of [undefined, NaN, Infinity, 1n, () => true, new Date(), "x".repeat(900_001)])
      expect(await c.handle.invoke("finance.save", { value })).toEqual({ status: "invalid_input" });
    expect(request).not.toHaveBeenCalled();
  });
});
