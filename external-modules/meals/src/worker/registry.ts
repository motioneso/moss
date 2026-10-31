// external-modules/meals/src/worker/registry.ts
//
// The one handler-key to handler map for tools and queues. Keys match the manifest's
// assistantTools[].handler.
import type { ModuleWorkerContext } from "@moss/module-sdk/worker";

export type Handler = (ctx: ModuleWorkerContext) => Promise<unknown>;

export const HANDLERS: Readonly<Record<string, Handler>> = {};
