import type { JsonSchema, ToolInput } from "@moss/module-sdk";
import { Worker } from "node:worker_threads";

export class ToolInputValidationError extends Error {
  constructor(message: string) {
    super(message);
    this.name = "ToolInputValidationError";
  }
}

const JSON_TYPE_OF: Record<string, (v: unknown) => boolean> = {
  string: (v) => typeof v === "string",
  number: (v) => typeof v === "number",
  boolean: (v) => typeof v === "boolean",
  object: (v) => typeof v === "object" && v !== null && !Array.isArray(v),
  array: (v) => Array.isArray(v)
};

interface SchemaNode {
  readonly type?: string;
  readonly enum?: readonly unknown[];
  readonly required?: readonly string[];
  readonly properties?: Record<string, SchemaNode>;
  readonly items?: SchemaNode;
  readonly minLength?: number;
  readonly maxLength?: number;
  readonly pattern?: string;
}

/** Compiled `pattern` cache — manifests are static, so each pattern compiles once per process
 *  instead of once per tool call. For BUILT-IN modules this is not a new trust boundary: the
 *  pattern is trusted code, same as everything else in the manifest.
 *
 *  For EXTERNAL (third-party) modules, matching runs in a short-lived Worker with a hard timeout
 *  and resource limits. Built-in modules keep the synchronous compiled-RegExp path below. */
const PATTERN_INVALID = Symbol("pattern-invalid");
const patternCache = new Map<string, RegExp | typeof PATTERN_INVALID>();
const PATTERN_WORKER_TIMEOUT_MS = 100;
const MAX_PATTERN_WORKERS = 8;
const patternWorkerWaiters: Array<() => void> = [];
let activePatternWorkers = 0;

async function acquirePatternWorker(): Promise<() => void> {
  if (activePatternWorkers >= MAX_PATTERN_WORKERS) {
    await new Promise<void>((resolve) => patternWorkerWaiters.push(resolve));
  }
  activePatternWorkers += 1;
  let released = false;
  return () => {
    if (released) return;
    released = true;
    activePatternWorkers -= 1;
    patternWorkerWaiters.shift()?.();
  };
}

async function matchExternalPattern(pattern: string, value: string): Promise<boolean> {
  const release = await acquirePatternWorker();
  let worker: Worker | undefined;
  let timer: ReturnType<typeof setTimeout> | undefined;
  try {
    worker = new Worker(new URL("./pattern-worker.mjs", import.meta.url), {
      workerData: { pattern, value },
      resourceLimits: {
        maxOldGenerationSizeMb: 16,
        maxYoungGenerationSizeMb: 4,
        codeRangeSizeMb: 8,
        stackSizeMb: 1
      }
    });
    const result = await new Promise<unknown>((resolve, reject) => {
      const onMessage = (message: unknown) => resolve(message);
      const onError = () => reject(new Error("pattern worker failed"));
      const onExit = (code: number) => {
        if (code !== 0) reject(new Error("pattern worker exited"));
      };
      worker!.once("message", onMessage);
      worker!.once("error", onError);
      worker!.once("exit", onExit);
      timer = setTimeout(
        () => reject(new Error("pattern worker timed out")),
        PATTERN_WORKER_TIMEOUT_MS
      );
    });
    if (typeof result !== "boolean")
      throw new Error("pattern worker returned a non-boolean result");
    return result;
  } catch {
    throw new ToolInputValidationError("Pattern matching failed and was rejected");
  } finally {
    if (timer) clearTimeout(timer);
    if (worker) {
      worker.removeAllListeners("message");
      worker.removeAllListeners("error");
      worker.removeAllListeners("exit");
      await worker.terminate();
    }
    release();
  }
}

/**
 * Compiles a manifest `pattern` for whole-string matching, or throws. Fails CLOSED (#1265
 * security QA BLOCKING-1): a broken pattern used to compile to `null` and get silently skipped,
 * admitting any value for that field. That is worse than no bound at all, since a bound that
 * reads as protection in review and does nothing at runtime is a silent hole. A manifest author's
 * typo now breaks every call to that tool loudly instead — a loud break is recoverable, a silent
 * admit is not.
 *
 * Compiles the pattern BARE first, purely as a validity probe, before compiling the wrapped
 * `^(?:...)$` form used for matching. This is not just about catching `new RegExp` throwing
 * (e.g. `\-` outside a character class under the `/u` flag) — it also closes a second fail-open:
 * an unbalanced-paren pattern like `[a-z]+)|(.*` still compiles once wrapped (the pattern's stray
 * `)` closes the wrapper's `(?:` early and its stray `(` reopens a group closed by the appended
 * `)`), producing `^(?:[a-z]+)|(.*)$` — a top-level alternation that sits OUTSIDE the anchors and
 * matches anything. Valid regex requires balanced parens, so any pattern whose wrapped form could
 * suffer that escape is, by construction, unbalanced on its own and fails the bare compile first.
 * (Verified: `[a-z]+)|(.*` throws on both the bare and wrapped compile; exhaustive search over
 * short paren/alternation combinations found no bare-compilable pattern whose wrapped form still
 * escapes the anchors.)
 *
 * Kept under the `/u` flag deliberately: `/u` rejects more author patterns (e.g. bare `\-`), which
 * is more noise but fails closed — dropping `/u` would silently accept patterns it used to reject
 * and change what already-declared patterns match.
 */
export function compilePattern(pattern: string): RegExp {
  const cached = patternCache.get(pattern);
  if (cached === PATTERN_INVALID) {
    throw new ToolInputValidationError(`Pattern is invalid: ${pattern}`);
  }
  if (cached !== undefined) return cached;

  let compiled: RegExp;
  try {
    // Validity probe — see doc comment above for why this also closes the anchor-escape case.
    new RegExp(pattern, "u");
    // Anchored on both ends: an unanchored manifest pattern must not be satisfied by a matching
    // substring of a hostile value ("ok/../../etc" vs `[a-z]+`). `(?:...)` keeps any top-level
    // alternation in the manifest pattern inside the anchors.
    compiled = new RegExp(`^(?:${pattern})$`, "u");
  } catch {
    patternCache.set(pattern, PATTERN_INVALID);
    throw new ToolInputValidationError(`Pattern is invalid: ${pattern}`);
  }
  patternCache.set(pattern, compiled);
  return compiled;
}

/** String bounds (#1265 security QA BLOCKING-1b). These are enforced because modules declare them
 *  as a real safety belt — the sports follow tools bound their catalog keys so a model-supplied
 *  key cannot be arbitrary before it reaches a persisted row and, later, an outbound URL. A
 *  declared bound that nothing enforces is worse than no bound: it reads as protection in review. */
async function validateStringBounds(
  schema: SchemaNode,
  value: string,
  path: string,
  external: boolean
): Promise<void> {
  if (typeof schema.minLength === "number" && value.length < schema.minLength) {
    throw new ToolInputValidationError(
      `Field ${path} must be at least ${schema.minLength} characters`
    );
  }
  if (typeof schema.maxLength === "number" && value.length > schema.maxLength) {
    throw new ToolInputValidationError(
      `Field ${path} must be at most ${schema.maxLength} characters`
    );
  }
  if (typeof schema.pattern === "string") {
    const matches = external
      ? await matchExternalPattern(schema.pattern, value)
      : (() => {
          let compiled: RegExp;
          try {
            compiled = compilePattern(schema.pattern);
          } catch {
            throw new ToolInputValidationError(
              `Field ${path} has an unusable pattern and was rejected`
            );
          }
          return compiled.test(value);
        })();
    if (!matches) {
      throw new ToolInputValidationError(`Field ${path} has an invalid format`);
    }
  }
}

function joinPath(base: string, key: string): string {
  return base === "" ? key : `${base}.${key}`;
}

async function validateObject(
  schema: SchemaNode,
  value: ToolInput,
  basePath: string,
  external: boolean
): Promise<void> {
  const required = Array.isArray(schema.required) ? schema.required : [];
  for (const key of required) {
    if (!(key in value)) {
      throw new ToolInputValidationError(`Missing required field: ${joinPath(basePath, key)}`);
    }
  }

  const properties = schema.properties ?? {};
  for (const [key, declared] of Object.entries(properties)) {
    if (!(key in value)) {
      continue;
    }
    await validateValue(declared, value[key], joinPath(basePath, key), external);
  }
}

async function validateValue(
  schema: SchemaNode,
  value: unknown,
  path: string,
  external: boolean
): Promise<void> {
  if (Array.isArray(schema.enum) && !schema.enum.some((option) => option === value)) {
    const allowed = schema.enum.map((option) => JSON.stringify(option)).join(", ");
    throw new ToolInputValidationError(`Field ${path} must be one of: ${allowed}`);
  }

  if (schema.type !== undefined) {
    const check = JSON_TYPE_OF[schema.type];
    if (check && !check(value)) {
      throw new ToolInputValidationError(`Field ${path} must be a ${schema.type}`);
    }
  }

  if (typeof value === "string") {
    await validateStringBounds(schema, value, path, external);
  }

  if (schema.type === "object" && schema.properties) {
    await validateObject(schema, value as ToolInput, path, external);
  }

  if (schema.type === "array" && schema.items && Array.isArray(value)) {
    for (const [index, item] of value.entries()) {
      await validateValue(schema.items as SchemaNode, item, `${path}[${index}]`, external);
    }
  }
}

/**
 * Dependency-free structural validation for assistant-tool input. This is the
 * security chokepoint for caller-supplied tool input on the gateway/REST paths,
 * so it enforces the structural constraints that matter for safety:
 *   - the top-level input is a JSON object;
 *   - all `required` keys are present, recursively into nested objects;
 *   - each declared property matches its `type`
 *     (string/number/boolean/object/array);
 *   - `enum` membership, and `array` `items` types, recursively;
 *   - string `minLength`/`maxLength`/`pattern` (added for #1265 — see below).
 *
 * It deliberately does NOT enforce `format`, numeric bounds (minimum/maximum),
 * `additionalProperties`, or composition keywords (`oneOf`/`anyOf`/`allOf`/`$ref`).
 * Callers MUST NOT treat a passing result as full JSON-Schema conformance. When a
 * real module ships a schema that needs those, swap in a full validator (ajv)
 * rather than extending this by hand (#133).
 *
 * String bounds are the one deliberate exception to that "don't extend by hand"
 * rule (#1265 security QA). The sports follow tools auto-run under a
 * granted_at_install grant and bound their catalog keys with minLength/maxLength/
 * pattern as a safety belt; leaving those keywords unenforced would have shipped a
 * bound that reads as protection in review and does nothing at runtime. Three
 * string keywords are a far smaller change than adopting ajv, and this is the
 * chokepoint every module's tool input passes through.
 *
 * MANIFEST AUTHORS, note two consequences of that change (#1265):
 *   1. `pattern` is matched against the WHOLE string — it is anchored here even
 *      if you wrote it unanchored. An unanchored pattern that used to be
 *      satisfied by a matching substring now requires a full-string match. This
 *      is deliberate: a substring match would let "ok/../../etc" satisfy
 *      `[a-z]+`. Write patterns as if `^...$` were implied, because it is.
 *   2. This applies to EXTERNAL installed modules too. A third-party manifest
 *      that already declares string bounds now has them enforced where it
 *      previously did not, so a bound that was decorative becomes a real
 *      rejection.
 * An unparseable or non-self-contained `pattern` fails CLOSED (#1265 BLOCKING-1): it rejects
 * every call to that tool rather than being skipped and silently admitting unvalidated input. See
 * {@link compilePattern}.
 */
export async function validateToolInput(
  schema: JsonSchema | undefined,
  input: unknown,
  options: { readonly external: boolean }
): Promise<ToolInput> {
  if (typeof input !== "object" || input === null || Array.isArray(input)) {
    throw new ToolInputValidationError("Tool input must be an object");
  }
  const value = input as ToolInput;
  if (!schema) {
    return value;
  }

  await validateObject(schema as SchemaNode, value, "", options.external);

  return value;
}
