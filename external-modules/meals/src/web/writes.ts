// external-modules/meals/src/web/writes.ts
//
// The only file that knows the host's write handle. The host passes `tools` (module page write
// tools spec, section 5); without it every write control stays hidden.
export type MealsWriteToolName =
  | "meals.kitchen.save"
  | "meals.household.save"
  | "meals.household.remove"
  | "meals.plan.create"
  | "meals.plan.control"
  | "meals.plan.delete"
  | "meals.meal.cooked"
  | "meals.meal.servings"
  | "meals.meal.rate"
  | "meals.favourites.edit"
  | "meals.meal.edit"
  | "meals.meal.swap"
  | "meals.day.edit"
  | "meals.list.build"
  | "meals.list.edit"
  | "meals.list.bought"
  | "meals.list.clear"
  | "meals.pantry.edit"
  | "meals.log.add"
  | "meals.log.correct"
  | "meals.log.delete"
  | "meals.log.reestimate"
  | "meals.undo";

export type MealsWriteOutcome =
  | { readonly kind: "succeeded"; readonly result: unknown }
  | { readonly kind: "cancelled" }
  | { readonly kind: "rejected"; readonly moduleCode?: string }
  | { readonly kind: "invalid_input" }
  | { readonly kind: "saved" }
  | { readonly kind: "failed" };

export interface MealsWrites {
  invoke(
    name: MealsWriteToolName,
    input: Readonly<Record<string, unknown>>
  ): Promise<MealsWriteOutcome>;
}

type HostInvocation = { status?: string; result?: unknown; moduleCode?: string };
type HostTools = { invoke: (name: string, input: unknown) => Promise<HostInvocation> };

function isHostTools(value: unknown): value is HostTools {
  return (
    typeof value === "object" &&
    value !== null &&
    typeof (value as { invoke?: unknown }).invoke === "function"
  );
}

/** Null when the host passes no tools handle. Every write control then stays hidden. */
export function bindWrites(props: Readonly<Record<string, unknown>>): MealsWrites | null {
  const tools = props.tools;
  if (!isHostTools(tools)) return null;
  return {
    async invoke(name, input) {
      let outcome: HostInvocation;
      try {
        outcome = await tools.invoke(name, input);
      } catch {
        return { kind: "failed" };
      }
      switch (outcome?.status) {
        case "succeeded":
          return { kind: "succeeded", result: outcome.result };
        case "cancelled":
          return { kind: "cancelled" };
        case "rejected":
          return { kind: "rejected", moduleCode: outcome.moduleCode };
        case "invalid_input":
          return { kind: "invalid_input" };
        case "saved":
          return { kind: "saved" };
        default:
          return { kind: "failed" };
      }
    }
  };
}

/**
 * The message for an outcome that needs one. Success and a person's own cancel return null.
 * Each of the other four outcomes says something different, because the next step differs.
 */
export function noticeFor(outcome: Pick<MealsWriteOutcome, "kind">): string | null {
  switch (outcome.kind) {
    case "succeeded":
    case "cancelled":
      return null;
    case "rejected":
      return "Meals did not accept that change. Check it and try again.";
    case "invalid_input":
      return "That entry was not valid. Check it and try again.";
    case "saved":
      return "The change was saved. Refresh this page to see it.";
    default:
      return "Moss could not confirm that change. Refresh the page and check before trying again.";
  }
}
