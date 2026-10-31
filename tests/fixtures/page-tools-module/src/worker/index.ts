// Installed synthetic module: real worker RPC and owner-scoped KV, no external service.
import { defineModuleWorker } from "@moss/module-sdk/worker";
const namespace = "page-tools-proof.records";
defineModuleWorker({
  handlers: {
    save: async (ctx) => {
      await ctx.kv.set("user", namespace, "synthetic", { label: "Synthetic entry" });
      return { saved: true };
    },
    read: async (ctx) => ({
      exists: (await ctx.kv.get("user", namespace, "synthetic")) !== null,
      delivered: (await ctx.kv.get("user", namespace, "recipient-stand-in")) !== null
    }),
    // Disclosed external-recipient stand-in; host route, worker and storage remain real.
    send: async (ctx) => {
      await ctx.kv.set("user", namespace, "recipient-stand-in", { delivered: true });
      return { delivered: true };
    },
    delete: async (ctx) => {
      await ctx.kv.delete("user", namespace, "synthetic");
      return { deleted: true };
    }
  }
});
