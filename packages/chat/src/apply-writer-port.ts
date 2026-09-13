// Adapter between the reserved-addition execution port and the transaction
// scoped calendar writer. The adapter opens no transaction of its own: the
// writer stages its own short transactions around database reads alone and
// runs every token refresh and provider call with none open. The execution
// service therefore observes zero open transactions on every provider call.
import type { AccessContext } from "@moss/db";
import {
  type ApplyWriterPort,
  type CalendarWriteService,
  type FocusBlockWindow
} from "@moss/calendar";
import type { ApplyEventProvenance } from "@moss/shared";
import type { ToolContext } from "@moss/module-sdk";

export type { ApplyWriterPort } from "@moss/calendar";

export interface ApplyWriterPortDeps {
  readonly writer: Pick<CalendarWriteService, "createEvent" | "lookupEvent">;
}

export function buildApplyWriterPort(deps: ApplyWriterPortDeps): {
  forAccess(access: AccessContext): ApplyWriterPort;
} {
  return {
    forAccess(_access: AccessContext): ApplyWriterPort {
      return {
        async createAddition(input: {
          readonly ctx: ToolContext;
          readonly window: FocusBlockWindow;
          readonly provenance: ApplyEventProvenance;
        }) {
          // The handle is unused on the apply path: the writer derives actor
          // and request from ctx and stages its own transactions internally.
          return deps.writer.createEvent(undefined, input.ctx, input.window, {
            provenance: input.provenance
          });
        },
        async lookupAddition(input: { readonly ctx: ToolContext; readonly eventId: string }) {
          return deps.writer.lookupEvent(undefined, input.ctx, input);
        }
      };
    }
  };
}
