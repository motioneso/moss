import type { ExternalModuleToolsHandleV1, ModuleToolOutcome } from "@moss/module-web-sdk";
import {
  isRecord,
  readModuleConfirmation,
  snapshotModuleToolInput,
  type ModuleToolConfirmation
} from "./tool-responses.js";

export type ModuleToolsView =
  | { readonly kind: "confirmation"; readonly confirmation: ModuleToolConfirmation }
  | { readonly kind: "notice"; readonly message: string }
  | null;

const UNCERTAIN =
  "Moss could not confirm the result. Refresh this page and check whether the change saved before trying again.";
function failureMessage(status: number, body: unknown): string {
  if (status === 409 && isRecord(body) && body.code === "confirmation_invalid")
    return "This confirmation is no longer valid. Refresh the page before starting the change again.";
  if (status === 413 && isRecord(body) && body.saved === false)
    return "This result is too large to show. Nothing was changed.";
  if (status === 429) return "Too many changes at once. Wait a minute before trying again.";
  if (status === 401) return "Your session has expired. Sign in again to make changes.";
  if (status === 403 || status === 404)
    return "This action is not available. Refresh the page to check your access.";
  return UNCERTAIN;
}

/** One controller per mounted module and actor. At most one gesture/confirmation is in flight. */
export function createModuleToolsController(moduleId: string, request: typeof fetch = fetch) {
  let active = true;
  let generation = 0;
  let busy = false;
  let view: ModuleToolsView = null;
  let decision: ((confirmed: boolean) => void) | null = null;
  const listeners = new Set<() => void>();
  const controllers = new Set<AbortController>();
  const publish = (next: ModuleToolsView) => {
    view = next;
    listeners.forEach((listener) => listener());
  };
  async function post(path: string, body: unknown) {
    const controller = new AbortController();
    controllers.add(controller);
    const timeout = setTimeout(() => controller.abort(), 45_000);
    try {
      const response = await request(path, {
        method: "POST",
        credentials: "include",
        headers: { "content-type": "application/json", accept: "application/json" },
        body: JSON.stringify(body),
        signal: controller.signal
      });
      const data: unknown = await response.json().catch(() => null);
      return { status: response.status, body: data };
    } finally {
      clearTimeout(timeout);
      controllers.delete(controller);
    }
  }
  async function cancel(id: string) {
    try {
      await post(`/api/ai/assistant-actions/${encodeURIComponent(id)}/resolve`, {
        status: "cancelled"
      });
    } catch {
      /* No execution was requested. Abandoned server decisions expire independently. */
    }
  }
  const handle: ExternalModuleToolsHandleV1 = Object.freeze({
    async invoke(name: string, rawInput: Record<string, unknown>): Promise<ModuleToolOutcome> {
      if (!active || busy) return { status: "failed" };
      if (
        !/^[a-z0-9]+(?:-[a-z0-9]+)*$/.test(moduleId) ||
        typeof name !== "string" ||
        name.length === 0 ||
        name.length > 240
      )
        return { status: "invalid_input" };
      let input: Record<string, unknown>;
      try {
        input = snapshotModuleToolInput(rawInput);
      } catch {
        return { status: "invalid_input" };
      }
      const epoch = generation;
      const current = () => active && generation === epoch;
      const path = `/api/modules/${encodeURIComponent(moduleId)}/tools/${encodeURIComponent(name)}/invoke`;
      busy = true;
      publish(null);
      try {
        let reply = await post(path, { input });
        const confirmation = reply.status === 409 ? readModuleConfirmation(reply.body) : null;
        if (!current()) {
          if (confirmation) void cancel(confirmation.id);
          return { status: "failed" };
        }
        if (confirmation) {
          // Expiry is the server's to judge. A device clock running fast would refuse every
          // confirmation, and the server already answers confirmation_invalid once it lapses.
          const confirmed = await new Promise<boolean>((resolve) => {
            decision = resolve;
            publish({ kind: "confirmation", confirmation });
          });
          if (!confirmed || !current()) {
            // Cancellation never sends the input again and cannot execute the tool.
            await cancel(confirmation.id);
            return { status: "cancelled" };
          }
          reply = await post(path, { input, confirmationId: confirmation.id });
        }
        if (!current()) return { status: "failed" };
        if (
          reply.status === 200 &&
          isRecord(reply.body) &&
          isRecord(reply.body.invocation) &&
          reply.body.invocation.status === "succeeded" &&
          isRecord(reply.body.invocation.result)
        )
          return { status: "succeeded", result: reply.body.invocation.result };
        if (reply.status === 400) return { status: "invalid_input" };
        if (reply.status === 422 && isRecord(reply.body) && reply.body.code === "module_rejected") {
          const code = reply.body.moduleCode;
          return {
            status: "rejected",
            ...(typeof code === "string" && /^[a-z][a-z0-9._-]{0,63}$/.test(code)
              ? { moduleCode: code }
              : {})
          };
        }
        if (reply.status === 413 && isRecord(reply.body) && reply.body.saved === true) {
          // The write ran; only its result was too large to return. A retry would apply it twice.
          publish({
            kind: "notice",
            message: "The change was saved. Refresh this page to see it."
          });
          return { status: "saved" };
        }
        publish({ kind: "notice", message: failureMessage(reply.status, reply.body) });
        return { status: "failed" };
      } catch {
        if (current()) publish({ kind: "notice", message: UNCERTAIN });
        return { status: "failed" };
      } finally {
        if (current()) busy = false;
      }
    }
  });
  return {
    handle,
    subscribe(listener: () => void) {
      listeners.add(listener);
      return () => {
        listeners.delete(listener);
      };
    },
    getSnapshot: () => view,
    decide(confirmed: boolean) {
      if (!decision) return;
      const resolve = decision;
      decision = null;
      publish(null);
      resolve(confirmed);
    },
    dismissNotice() {
      if (view?.kind === "notice") publish(null);
    },
    activate() {
      active = true;
    },
    dispose() {
      active = false;
      generation += 1;
      busy = false;
      controllers.forEach((controller) => controller.abort());
      const resolve = decision;
      decision = null;
      publish(null);
      resolve?.(false);
    }
  };
}
