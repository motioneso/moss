import { describe, expect, it, vi } from "vitest";
import { AssistantToolGateway } from "@moss/ai";
import type { ModuleAssistantToolManifest, MossModuleManifest } from "@moss/module-sdk";

function fixture(
  risk: ModuleAssistantToolManifest["risk"] = "read",
  allowed = true,
  isExternal = false
) {
  const execute = vi.fn(async () => ({
    data: { task: { id: "item", title: "Proof", status: "todo" } }
  }));
  const authorizeBackgroundRead = vi.fn(async () => allowed);
  const module: MossModuleManifest = {
    id: "tasks",
    name: "Tasks",
    version: "1.0.0",
    publisher: "moss",
    lifecycle: "optional",
    compatibility: { jarv1s: ">=0.0.0" },
    assistantTools: [
      {
        name: "tasks.get",
        description: "Read",
        permissionId: "tasks.view",
        risk,
        isExternal,
        authorizeBackgroundRead,
        execute
      },
      ...["tasks.update", "tasks.delete", "tasks.list"].map((name) => ({
        name,
        description: "Available operation",
        permissionId: "tasks.view",
        risk: "read" as const,
        authorizeBackgroundRead,
        execute
      }))
    ]
  };
  let enabled = true;
  const gateway = new AssistantToolGateway({
    confirmTimeoutMs: 0,
    resolveActiveModules: async () => (enabled ? [module] : []),
    repository: {} as never,
    runner: {
      withDataContext: async (_ctx: unknown, fn: (db: never) => unknown) => fn({} as never)
    } as never,
    tokens: {} as never,
    confirmations: {} as never,
    notifier: { emit: vi.fn() },
    provenance: { isTainted: async () => false, recordAdmission: vi.fn() }
  });
  return {
    gateway,
    execute,
    authorizeBackgroundRead,
    disable: () => {
      enabled = false;
    }
  };
}
const read = { operation: "tasks.get", itemId: "item", runId: "run" };
describe("the real background read gateway", () => {
  it("marks only classified temporary source failures retryable", async () => {
    const f = fixture();
    f.execute.mockRejectedValueOnce(Object.assign(new Error("private"), { code: "ECONNRESET" }));
    expect(await f.gateway.runBackgroundReadForActor("owner", read)).toMatchObject({
      ok: false,
      retryable: true
    });
    f.execute.mockRejectedValueOnce(new Error("private"));
    expect(await f.gateway.runBackgroundReadForActor("owner", read)).not.toHaveProperty(
      "retryable"
    );
  });
  it("returns source data without touching conversation authority", async () => {
    const f = fixture();
    expect(await f.gateway.runBackgroundReadForActor("owner", read)).toMatchObject({
      ok: true,
      structuredData: { task: { title: "Proof", status: "todo" } }
    });
    expect(f.execute.mock.calls).toHaveLength(1);
  });
  it("does not retry external failures or inspect a hostile proxy", async () => {
    const external = fixture("read", true, true);
    external.execute.mockRejectedValueOnce(
      Object.assign(new Error("private"), { code: "ETIMEDOUT" })
    );
    expect(await external.gateway.runBackgroundReadForActor("owner", read)).not.toHaveProperty(
      "retryable"
    );
    const getCode = vi.fn(() => {
      throw new Error("must not inspect getters");
    });
    const hostile = new Proxy(new Error("private"), { get: getCode });
    const firstParty = fixture();
    firstParty.execute.mockRejectedValueOnce(hostile);
    expect(await firstParty.gateway.runBackgroundReadForActor("owner", read)).not.toHaveProperty(
      "retryable"
    );
    expect(getCode).not.toHaveBeenCalled();
  });
  it.each(["tasks.update", "tasks.delete", "tasks.list"])(
    "refuses %s before invoking a handler",
    async (operation) => {
      const f = fixture();
      expect(
        await f.gateway.runBackgroundReadForActor("owner", { ...read, operation })
      ).toMatchObject({ ok: false });
      expect(f.execute).not.toHaveBeenCalled();
    }
  );
  it.each(["write", "destructive"] as const)(
    "refuses an effective %s even under a read operation",
    async (risk) => {
      const f = fixture(risk);
      expect(await f.gateway.runBackgroundReadForActor("owner", read)).toMatchObject({ ok: false });
      expect(f.execute).not.toHaveBeenCalled();
    }
  );
  it("rechecks disabled capability on every run", async () => {
    const f = fixture();
    f.disable();
    expect(await f.gateway.runBackgroundReadForActor("owner", read)).toMatchObject({ ok: false });
    expect(f.execute).not.toHaveBeenCalled();
  });
  it("refuses a foreign or revoked item before invocation", async () => {
    const f = fixture("read", false);
    expect(await f.gateway.runBackgroundReadForActor("owner", read)).toMatchObject({ ok: false });
    expect(f.execute).not.toHaveBeenCalled();
  });
});
