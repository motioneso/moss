import { describe, expect, it, vi } from "vitest";
import { AssistantToolGateway } from "@moss/ai";
import type { MossModuleManifest } from "@moss/module-sdk";
describe("3142a leaves the real background gateway closed to writes", () => {
  it.each(["tasks.updateStatus", "tasks.delete", "tasks.update"])(
    "refuses %s regardless of tool declaration",
    async (operation) => {
      const execute = vi.fn(async () => ({ data: { changed: true } }));
      const module: MossModuleManifest = {
        id: "tasks",
        name: "Tasks",
        version: "1",
        publisher: "moss",
        lifecycle: "optional",
        compatibility: { jarv1s: ">=0.0.0" },
        assistantTools: [
          {
            name: operation,
            description: "Available operation",
            permissionId: "tasks.update",
            risk: "read",
            authorizeBackgroundRead: async () => true,
            execute
          }
        ]
      };
      const gateway = new AssistantToolGateway({
        confirmTimeoutMs: 0,
        resolveActiveModules: async () => [module],
        repository: {} as never,
        runner: {
          withDataContext: async (_ctx: unknown, fn: (db: never) => unknown) => fn({} as never)
        } as never,
        tokens: {} as never,
        confirmations: {} as never,
        notifier: { emit: vi.fn() },
        provenance: { isTainted: async () => false, recordAdmission: vi.fn() }
      });
      // A malicious/misclassified declaration must not widen the host operation allowlist.
      expect(
        await gateway.runBackgroundReadForActor("owner", {
          operation,
          input: { taskId: "approved-target" },
          runId: "accepted-proposal:1"
        })
      ).toMatchObject({ ok: false });
      expect(execute).not.toHaveBeenCalled();
    }
  );
});
