import type { FastifyInstance } from "fastify";
import type { CatalogRoute } from "@moss/module-sdk";
import type { AppActionCallInput } from "./app-actions.js";

type Validator = ReturnType<NonNullable<FastifyInstance["validatorCompiler"]>>;
type Part = "body" | "querystring" | "params";

/** Detect schema removal on the clone without dropping any submitted field from disclosure. */
function removedSubmittedField(original: unknown, validated: unknown): boolean {
  if (original === null || typeof original !== "object") return false;
  if (validated === null || typeof validated !== "object") return true;
  return Object.entries(original).some(
    ([key, value]) =>
      !Object.hasOwn(validated, key) ||
      removedSubmittedField(value, (validated as Record<string, unknown>)[key])
  );
}

/** Reuse the running server's compiler; validation never injects a route or grants execution. */
export function createAppActionValidator(server: FastifyInstance) {
  const cache = new WeakMap<CatalogRoute, Partial<Record<Part, Validator>>>();
  return async (
    input: AppActionCallInput,
    route: CatalogRoute,
    params: Record<string, string>
  ): Promise<string | null> => {
    const shape = route.inputShape;
    if (!shape) return null;
    const compiler = server.validatorCompiler;
    if (!compiler) throw new Error("App input validation is not ready");
    let validators = cache.get(route);
    if (!validators) {
      validators = {};
      cache.set(route, validators);
    }
    for (const part of ["params", "querystring", "body"] as const) {
      const schema = shape[part];
      if (schema === undefined) continue;
      const original =
        part === "body" ? input.body : part === "querystring" ? (input.query ?? {}) : params;
      // Only a route that explicitly mirrors its preValidation normalization may omit this body.
      const clone = structuredClone(
        part === "body" &&
          (original === undefined || original === null) &&
          route.policy.emptyBody === "object"
          ? {}
          : original
      );
      const validate = (validators[part] ??= compiler({
        schema,
        method: input.method,
        url: route.path,
        httpPart: part
      }));
      const pending = validate(clone);
      const issues = validate.errors;
      const result: unknown = await pending;
      const label = part === "querystring" ? "query" : part;
      if (
        result === false ||
        (result !== null && typeof result === "object" && "error" in result && result.error)
      ) {
        const issue = issues?.[0];
        const detail = issue?.message ?? "does not match the action's input schema";
        const choices =
          issue?.keyword === "enum" && Array.isArray(issue.params.allowedValues)
            ? ` Allowed values: ${JSON.stringify(issue.params.allowedValues)}.`
            : "";
        return `Invalid ${label}${issue?.instancePath ?? ""}: ${detail}.${choices}`;
      }
      const normalized =
        result !== null && typeof result === "object" && "value" in result ? result.value : clone;
      if (removedSubmittedField(original, normalized))
        return `Invalid ${label}: remove fields not declared for this action.`;
    }
    return null;
  };
}
