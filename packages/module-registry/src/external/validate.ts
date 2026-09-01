// Pure, browser-safe validation of an external module's jarvis.module.json (#917).
// Slice 1 accepts METADATA ONLY: identity + compatibility, plus a small allow-listed set
// of surfaces (auth/storage/web/database/navigation) each validated positively below.
// Any OTHER executable or surface-contributing field is rejected so an external module
// can never inject routes/tools/SQL before the slices that safely host those land. No
// node:* imports here — this is re-exported from @moss/module-registry's browser entry.
import type {
  JsonMossModuleManifest,
  ExternalModuleAssistantToolDeclaration,
  ExternalModuleBriefingDeclaration,
  ExternalModuleDatabaseDeclaration,
  ExternalModuleWorkerDeclaration,
  MossActionPermissionTier,
  ModuleAssistantActionFamilyManifest,
  ModuleAssistantOnboardingManifest,
  ModuleAuthDeclaration,
  ModuleLifecycle,
  ModuleStorageDeclaration,
  ModuleWebDeclaration
} from "@moss/module-sdk";
import { validateModuleNavigation, validateModulePreferences } from "./validate-declarations.js";
import { assertValidFetchHosts } from "@moss/host-fetch/policy";
import {
  isValidModuleParamsSchema,
  matchesModuleParamsSchema,
  MAX_INVOCATION_MS
} from "@moss/module-sdk";
import { satisfiesCoreVersion } from "@moss/module-sdk/core-version";
import { lintAssistantToolInputSchema } from "./input-schema-lint.js";

export type ExternalModuleValidation =
  | { readonly ok: true; readonly manifest: JsonMossModuleManifest }
  | { readonly ok: false; readonly errors: readonly string[] };

/** Module ids are lowercase kebab slugs; the id also names the package directory. */
export const MODULE_ID_RE = /^[a-z0-9](?:[a-z0-9-]*[a-z0-9])?$/;

// #964: owned-table names. Qualified app-schema, lowercase snake, and HARD-PREFIXED by
// the module's own slug (id with hyphens→underscores) so no downloadable module can
// declare — and later purge — another module's (or core's) tables. Name part capped at
// Postgres's 63-char identifier limit.
export const MODULE_OWNED_TABLE_RE = /^app\.[a-z][a-z0-9_]{0,62}$/;
export const ASSISTANT_ONBOARDING_GUIDANCE_MAX_BYTES = 8 * 1024;

/** The briefings an external module may contribute to (#1282). */
const BRIEFING_SECTIONS: readonly string[] = ["morning", "evening"];

const LIFECYCLES: readonly ModuleLifecycle[] = [
  "required",
  "optional",
  "user-toggleable",
  "workspace-toggleable"
];

// Every field of the compiled MossModuleManifest that carries executable behavior
// or a UI/data surface. Presence of ANY of these in an external manifest is a
// rejection. `auth`/`storage`/`web` are first-class as of #918 Slice 2, `database` as
// of #964, `navigation` as of #1019, `preferences` as of #1725 (`settings` itself stays
// forbidden — it carries a component, `preferences` is data), and `assistantActionFamilies` as of #1246
// (each validated positively below) and are deliberately absent from this list.
const FORBIDDEN_FIELDS: readonly string[] = [
  "availability",
  "settings",
  "permissions",
  "featureFlags",
  "notifications",
  "routes",
  "jobs",
  "shareableResources",
  "sourceBehaviors",
  "focusSignal",
  "proactiveMonitor",
  // #2031: a diagnostics provider is a function; a worker-hosted module cannot supply one.
  "diagnosticsProvider",
  "personContextProvider",
  "dataLifecycle",
  "externalSources"
];

function isNonEmptyString(value: unknown): value is string {
  return typeof value === "string" && value.trim().length > 0;
}

const ACTION_FAMILY_ID_RE = /^[a-z][a-z0-9_-]*$/;
const ACTION_PERMISSION_TIERS: readonly MossActionPermissionTier[] = [
  "ask_each_time",
  "trusted_auto",
  "always_confirm"
];

function validateActionFamilies(
  raw: unknown,
  errors: string[]
): readonly ModuleAssistantActionFamilyManifest[] | undefined {
  if (raw === undefined) return undefined;
  if (!Array.isArray(raw) || raw.length === 0) {
    errors.push("assistantActionFamilies must be a non-empty array");
    return undefined;
  }

  const families: ModuleAssistantActionFamilyManifest[] = [];
  const seen = new Set<string>();
  for (const entry of raw) {
    if (!entry || typeof entry !== "object" || Array.isArray(entry)) {
      errors.push("assistantActionFamilies entries must be objects");
      continue;
    }
    const family = entry as Record<string, unknown>;
    if (!isNonEmptyString(family.id) || !ACTION_FAMILY_ID_RE.test(family.id)) {
      errors.push("action family id must be a lowercase identifier");
      continue;
    }
    if (seen.has(family.id)) {
      errors.push(`duplicate action family id: ${family.id}`);
      continue;
    }
    seen.add(family.id);
    if (!isNonEmptyString(family.label) || !isNonEmptyString(family.description)) {
      errors.push(`action family ${family.id} needs a label and description`);
      continue;
    }
    if (
      !Array.isArray(family.allowedTiers) ||
      family.allowedTiers.length === 0 ||
      !family.allowedTiers.every((tier) =>
        ACTION_PERMISSION_TIERS.includes(tier as MossActionPermissionTier)
      ) ||
      new Set(family.allowedTiers).size !== family.allowedTiers.length
    ) {
      errors.push(`action family ${family.id} has invalid allowedTiers`);
      continue;
    }
    if (family.defaultTier !== "ask_each_time" && family.defaultTier !== "always_confirm") {
      errors.push(`action family ${family.id} has an invalid defaultTier`);
      continue;
    }
    if (!family.allowedTiers.includes(family.defaultTier)) {
      errors.push(`action family ${family.id} defaultTier must appear in allowedTiers`);
      continue;
    }
    families.push({
      id: family.id,
      label: family.label,
      description: family.description,
      defaultTier: family.defaultTier,
      allowedTiers: family.allowedTiers as readonly MossActionPermissionTier[]
    });
  }
  return families.length > 0 ? families : undefined;
}

function validateAssistantToolPolicy(
  tool: Record<string, unknown>,
  families: readonly ModuleAssistantActionFamilyManifest[] | undefined,
  errors: string[]
): void {
  const family =
    typeof tool.actionFamilyId === "string"
      ? families?.find((candidate) => candidate.id === tool.actionFamilyId)
      : undefined;

  if (tool.actionFamilyId !== undefined) {
    if (!isNonEmptyString(tool.actionFamilyId)) {
      errors.push("assistant tool actionFamilyId must be a non-empty string");
    } else if (!family) {
      errors.push(`assistant tool references undeclared action family: ${tool.actionFamilyId}`);
    }
  }
  if (
    tool.executionPolicy !== undefined &&
    tool.executionPolicy !== "auto" &&
    tool.executionPolicy !== "confirm"
  ) {
    errors.push('assistant tool executionPolicy must be "auto" or "confirm"');
  }
  if (tool.executionPolicy === "auto") {
    if (!family) {
      errors.push('assistant tool executionPolicy "auto" requires an actionFamilyId');
    } else if (!family.allowedTiers.includes("trusted_auto")) {
      errors.push(
        `assistant tool executionPolicy "auto" requires family ${family.id} to allow trusted_auto`
      );
    }
  }

  if (
    tool.selfOperationGrant !== undefined &&
    tool.selfOperationGrant !== "granted_at_install" &&
    tool.selfOperationGrant !== "confirm_always" &&
    tool.selfOperationGrant !== "user_promotable"
  ) {
    errors.push("assistant tool selfOperationGrant is invalid");
  }
  if (
    tool.selfOperationGrant === "granted_at_install" ||
    tool.selfOperationGrant === "user_promotable"
  ) {
    if (tool.risk !== "write" || tool.executionPolicy !== "auto" || !family) {
      errors.push(
        `assistant tool ${tool.selfOperationGrant} requires risk "write", executionPolicy "auto", and an actionFamilyId`
      );
    } else if (!family.allowedTiers.includes("always_confirm")) {
      errors.push(
        `assistant tool ${tool.selfOperationGrant} requires family ${family.id} to allow always_confirm`
      );
    }
  }
  if (tool.selfOperationGrant === "confirm_always" && tool.executionPolicy === "auto") {
    errors.push('assistant tool confirm_always cannot use executionPolicy "auto"');
  }

  if (
    tool.confirmWhenKeys !== undefined &&
    (!Array.isArray(tool.confirmWhenKeys) ||
      !tool.confirmWhenKeys.every((key) => isNonEmptyString(key)))
  ) {
    errors.push("assistant tool confirmWhenKeys must be an array of non-empty strings");
  }
  if (tool.confirmWhen !== undefined) {
    if (!Array.isArray(tool.confirmWhen)) {
      errors.push("assistant tool confirmWhen must be an array");
    } else {
      for (const clause of tool.confirmWhen) {
        if (!clause || typeof clause !== "object" || Array.isArray(clause)) {
          errors.push("assistant tool confirmWhen entries must be objects");
          continue;
        }
        const { key, equals } = clause as Record<string, unknown>;
        if (!isNonEmptyString(key) || !["string", "number", "boolean"].includes(typeof equals)) {
          errors.push(
            "assistant tool confirmWhen entries need key:string and equals:string|number|boolean"
          );
        }
      }
    }
  }
}

function hasDeadLetterCycle(queues: readonly Record<string, unknown>[]): boolean {
  const edges = new Map(
    queues
      .filter(
        (queue) => typeof queue.name === "string" && typeof queue.deadLetterQueue === "string"
      )
      .map((queue) => [queue.name as string, queue.deadLetterQueue as string])
  );
  for (const start of edges.keys()) {
    const seen = new Set<string>();
    for (let current: string | undefined = start; current; current = edges.get(current)) {
      if (seen.has(current)) return true;
      seen.add(current);
    }
  }
  return false;
}

function validateWorker(
  raw: unknown,
  moduleId: string,
  errors: string[],
  reservedQueueNames: ReadonlySet<string>
): ExternalModuleWorkerDeclaration | undefined {
  if (!raw || typeof raw !== "object" || Array.isArray(raw)) {
    errors.push("worker must be an object");
    return undefined;
  }
  const worker = raw as Record<string, unknown>;
  if (worker.queues !== undefined && !Array.isArray(worker.queues)) {
    errors.push("worker.queues must be an array");
  }
  if (worker.schedules !== undefined && !Array.isArray(worker.schedules)) {
    errors.push("worker.schedules must be an array");
  }
  const queues = Array.isArray(worker.queues) ? worker.queues : [];
  if (queues.length > 16) errors.push("worker declares more than 16 queues");
  const queueNames = new Set<string>();
  const normalizedQueues: Record<string, unknown>[] = [];
  for (const entry of queues) {
    if (!entry || typeof entry !== "object" || Array.isArray(entry)) {
      errors.push("worker queue entries must be objects");
      continue;
    }
    const queue = entry as Record<string, unknown>;
    if (typeof queue.name !== "string" || !queue.name.startsWith(`${moduleId}.`)) {
      errors.push(`worker queue names must be prefixed with "${moduleId}."`);
    } else if (reservedQueueNames.has(queue.name)) {
      errors.push(`worker queue "${queue.name}" collides with an existing queue`);
    } else if (queueNames.has(queue.name)) {
      errors.push("worker queue names must be unique");
    } else queueNames.add(queue.name);
    if (!isNonEmptyString(queue.handler)) errors.push("worker queue handler is required");
    if (queue.paramsSchema !== undefined && !isValidModuleParamsSchema(queue.paramsSchema)) {
      errors.push("worker queue paramsSchema is invalid");
    }
    if (
      queue.retryLimit !== undefined &&
      (!Number.isInteger(queue.retryLimit) || (queue.retryLimit as number) < 0)
    ) {
      errors.push("worker queue retryLimit must be a non-negative integer");
    }
    // #1286 Task 2e: timeoutMs is the per-queue override of the worker's hard
    // invocation ceiling. Reject anything that isn't a positive integer (0, negative,
    // fractional, NaN, a string, or null all fail Number.isInteger or the <= 0 check)
    // rather than silently coercing — a bad ceiling is a security-relevant
    // misconfiguration, not a typo to paper over.
    if (
      queue.timeoutMs !== undefined &&
      (!Number.isInteger(queue.timeoutMs) || (queue.timeoutMs as number) <= 0)
    ) {
      errors.push("worker queue timeoutMs must be a positive integer");
    }
    normalizedQueues.push({
      ...queue,
      ...(typeof queue.retryLimit === "number"
        ? { retryLimit: Math.min(queue.retryLimit, 10) }
        : {}),
      // Clamp rather than reject above the ceiling: MAX_INVOCATION_MS protects the
      // host (worker-runtime.ts's resolveHardTimeout re-clamps defensively too), but a
      // module declaring an oversized timeout is not itself a validation failure.
      ...(typeof queue.timeoutMs === "number"
        ? { timeoutMs: Math.min(queue.timeoutMs, MAX_INVOCATION_MS) }
        : {})
    });
  }
  for (const queue of queues as Record<string, unknown>[]) {
    if (typeof queue.deadLetterQueue === "string" && !queueNames.has(queue.deadLetterQueue)) {
      errors.push("worker queue deadLetterQueue must reference a declared queue");
    }
  }
  if (hasDeadLetterCycle(queues as Record<string, unknown>[])) {
    errors.push("worker dead-letter graph contains a cycle");
  }
  const schedules = Array.isArray(worker.schedules) ? worker.schedules : [];
  if (schedules.length > 32) errors.push("worker declares more than 32 schedules");
  const scheduleIds = new Set<string>();
  for (const entry of schedules) {
    if (!entry || typeof entry !== "object" || Array.isArray(entry)) {
      errors.push("worker schedule entries must be objects");
      continue;
    }
    const schedule = entry as Record<string, unknown>;
    if (typeof schedule.id !== "string" || !/^[a-z][a-z0-9_.-]{0,63}$/.test(schedule.id)) {
      errors.push("worker schedule id must be a bounded identifier");
    } else if (scheduleIds.has(schedule.id)) {
      errors.push("worker schedule ids must be unique");
    } else scheduleIds.add(schedule.id);
    if (
      typeof schedule.cron !== "string" ||
      schedule.cron.trim().split(/\s+/).length !== 5 ||
      !/^[\d*/?,\-\s]+$/.test(schedule.cron)
    ) {
      errors.push("worker schedule cron must be a standard 5-field expression");
    }
    if (schedule.scope !== "user") errors.push('worker schedule scope must be "user"');
    if (
      typeof schedule.jobKind !== "string" ||
      !/^[a-z][a-z0-9_.-]{0,63}$/.test(schedule.jobKind)
    ) {
      errors.push("worker schedule jobKind must be a bounded identifier");
    }
    if (typeof schedule.queue !== "string" || !queueNames.has(schedule.queue)) {
      errors.push("worker schedule queue must reference a declared queue");
    }
    if (schedule.tz !== undefined) {
      try {
        new Intl.DateTimeFormat("en", { timeZone: String(schedule.tz) }).format();
      } catch {
        errors.push("worker schedule time zone is invalid");
      }
    }
    const queue = normalizedQueues.find((candidate) => candidate.name === schedule.queue);
    if (schedule.params !== undefined) {
      const encoded = JSON.stringify(schedule.params);
      if (
        !isValidModuleParamsSchema(queue?.paramsSchema) ||
        encoded.length > 2_048 ||
        !matchesModuleParamsSchema(queue.paramsSchema, schedule.params)
      ) {
        errors.push("worker schedule params do not match the queue paramsSchema");
      }
    }
  }
  // #1166 (F6-D4): reconcileJobs are a one-shot-per-active-user enqueue on every reconcile
  // (backfill/repair), distinct from the recurring cron `schedules` above. Mirrors the
  // schedules block's validation style: bounded count, bounded id, must reference a
  // declared queue, unknown keys rejected outright, duplicate ids rejected.
  if (worker.reconcileJobs !== undefined && !Array.isArray(worker.reconcileJobs)) {
    errors.push("worker.reconcileJobs must be an array");
  }
  const reconcileJobs = Array.isArray(worker.reconcileJobs) ? worker.reconcileJobs : [];
  if (reconcileJobs.length > 8) errors.push("worker declares more than 8 reconcileJobs");
  const reconcileJobIds = new Set<string>();
  for (const entry of reconcileJobs) {
    if (!entry || typeof entry !== "object" || Array.isArray(entry)) {
      errors.push("worker reconcileJob entries must be objects");
      continue;
    }
    const job = entry as Record<string, unknown>;
    const unknownKeys = Object.keys(job).filter((key) => !["id", "queue", "jobKind"].includes(key));
    if (unknownKeys.length > 0) {
      errors.push(`worker reconcileJob contains unknown fields: ${unknownKeys.join(", ")}`);
    }
    if (typeof job.id !== "string" || !/^[a-z0-9][a-z0-9-]{0,63}$/.test(job.id)) {
      errors.push("worker reconcileJob id must be a bounded lowercase kebab identifier");
    } else if (reconcileJobIds.has(job.id)) {
      errors.push("worker reconcileJob ids must be unique");
    } else reconcileJobIds.add(job.id);
    if (typeof job.queue !== "string" || !queueNames.has(job.queue)) {
      errors.push("worker reconcileJob queue must reference a declared queue");
    }
    if (
      typeof job.jobKind !== "string" ||
      job.jobKind.trim().length === 0 ||
      job.jobKind.length > 128
    ) {
      errors.push("worker reconcileJob jobKind must be a non-empty string (max 128 chars)");
    }
  }
  return {
    ...(worker.queues !== undefined
      ? { queues: normalizedQueues as unknown as ExternalModuleWorkerDeclaration["queues"] }
      : {}),
    ...(worker.schedules !== undefined
      ? { schedules: schedules as ExternalModuleWorkerDeclaration["schedules"] }
      : {}),
    ...(worker.reconcileJobs !== undefined
      ? {
          reconcileJobs: reconcileJobs as ExternalModuleWorkerDeclaration["reconcileJobs"]
        }
      : {})
  };
}

export function validateExternalModuleManifest(
  raw: unknown,
  expectedId: string,
  coreVersion?: string,
  reservedQueueNames: ReadonlySet<string> = new Set()
): ExternalModuleValidation {
  const errors: string[] = [];

  if (typeof raw !== "object" || raw === null || Array.isArray(raw)) {
    return { ok: false, errors: ["manifest must be a JSON object"] };
  }
  const obj = raw as Record<string, unknown>;

  // On-disk envelope contract version (#917, spec revision 2026-07-10 for PR #924). Slice 1
  // requires exactly the number 1; a missing, non-numeric, or future value fails closed. This is
  // the single "contract version" a metadata-only module carries — worker/web contract versions
  // are deferred to Slices 2-3 (see the JsonMossModuleManifest.schemaVersion doc + spec revision).
  if (obj.schemaVersion !== 1) {
    errors.push("schemaVersion must be the number 1");
  }

  // Identity.
  if (!isNonEmptyString(obj.id)) {
    errors.push("id is required and must be a non-empty string");
  } else if (!MODULE_ID_RE.test(obj.id)) {
    errors.push(`id "${obj.id}" is not a valid lowercase kebab-case slug`);
  } else if (obj.id !== expectedId) {
    errors.push(`id "${obj.id}" must equal the module directory name "${expectedId}"`);
  }

  if (!isNonEmptyString(obj.name)) errors.push("name is required");
  if (!isNonEmptyString(obj.version)) errors.push("version is required");
  if (!isNonEmptyString(obj.publisher)) errors.push("publisher is required");
  if (obj.description !== undefined && typeof obj.description !== "string") {
    errors.push("description must be a string when present");
  }

  if (!isNonEmptyString(obj.lifecycle) || !LIFECYCLES.includes(obj.lifecycle as ModuleLifecycle)) {
    errors.push(`lifecycle must be one of: ${LIFECYCLES.join(", ")}`);
  }

  // Compatibility — fail closed on an unparseable or out-of-range core version.
  const compatibility = obj.compatibility as Record<string, unknown> | undefined;
  if (
    typeof compatibility !== "object" ||
    compatibility === null ||
    !isNonEmptyString(compatibility.jarv1s)
  ) {
    errors.push("compatibility.jarv1s is required and must be a non-empty string");
  } else if (!satisfiesCoreVersion(compatibility.jarv1s, coreVersion)) {
    errors.push(
      `module is not compatible with this core (compatibility.jarv1s="${compatibility.jarv1s}")`
    );
  }

  // Metadata-only gate: reject any executable/surface field (#917).
  for (const field of FORBIDDEN_FIELDS) {
    if (obj[field] !== undefined) {
      errors.push(`field "${field}" is not permitted for external modules in this slice`);
    }
  }

  // #918 Slice 2: auth/storage/web are now first-class. Everything else
  // (routes, tools, jobs, database, dataLifecycle, ...) stays forbidden via FORBIDDEN_FIELDS.
  if (obj.auth !== undefined) {
    if (!Array.isArray(obj.auth)) {
      errors.push("auth must be an array");
    } else {
      const ids: string[] = [];
      for (const entry of obj.auth) {
        if (typeof entry !== "object" || entry === null) {
          errors.push("auth entries must be objects");
          continue;
        }
        const { id, displayName, kind, scope } = entry as Record<string, unknown>;
        if (
          typeof id !== "string" ||
          !id.startsWith(`${expectedId}.`) ||
          id.length <= expectedId.length + 1
        ) {
          errors.push(`auth id must be prefixed with "${expectedId}."`);
        } else {
          ids.push(id);
        }
        if (
          typeof displayName !== "string" ||
          displayName.length === 0 ||
          displayName.length > 200
        ) {
          errors.push("auth displayName must be a non-empty string (max 200)");
        }
        if (kind !== "api-key") errors.push('auth kind must be "api-key"');
        if (scope !== "instance" && scope !== "user") {
          errors.push('auth scope must be "instance" or "user"');
        }
      }
      if (new Set(ids).size !== ids.length) errors.push("auth ids must be unique");
    }
  }
  if (obj.storage !== undefined) {
    if (!Array.isArray(obj.storage)) {
      errors.push("storage must be an array");
    } else {
      for (const entry of obj.storage) {
        if (typeof entry !== "object" || entry === null) {
          errors.push("storage entries must be objects");
          continue;
        }
        const { namespace, scopes } = entry as Record<string, unknown>;
        if (
          typeof namespace !== "string" ||
          (namespace !== expectedId && !namespace.startsWith(`${expectedId}.`))
        ) {
          errors.push(`storage namespace must be "${expectedId}" or "${expectedId}.<slug>"`);
        }
        if (
          !Array.isArray(scopes) ||
          scopes.length === 0 ||
          scopes.some((s) => s !== "instance" && s !== "user")
        ) {
          errors.push('storage scopes must be a non-empty array of "instance" | "user"');
        }
        // FIN-00 #1145: instance-write opt-in is only meaningful (and only
        // approved by the admin) for namespaces that actually have instance scope.
        const { instanceWritePolicy } = entry as Record<string, unknown>;
        if (instanceWritePolicy !== undefined) {
          if (instanceWritePolicy !== "admin" && instanceWritePolicy !== "module") {
            errors.push('storage instanceWritePolicy must be "admin" or "module"');
          } else if (!Array.isArray(scopes) || !scopes.includes("instance")) {
            errors.push('storage instanceWritePolicy requires "instance" in scopes');
          }
        }
      }
    }
  }
  // #1309 (Task 24): fetchHostGrantsNamespace must point at one of the module's own declared
  // storage namespaces, and that namespace must include the "user" scope — a module cannot grant
  // runtime fetch hosts through a namespace it never declared, or through an instance-only one.
  if (obj.fetchHostGrantsNamespace !== undefined) {
    if (typeof obj.fetchHostGrantsNamespace !== "string") {
      errors.push("fetchHostGrantsNamespace must be a string");
    } else {
      const declared = Array.isArray(obj.storage)
        ? (obj.storage as Record<string, unknown>[]).find(
            (entry) =>
              entry !== null &&
              typeof entry === "object" &&
              entry.namespace === obj.fetchHostGrantsNamespace
          )
        : undefined;
      if (!declared) {
        errors.push("fetchHostGrantsNamespace does not match a declared storage namespace");
      } else if (
        !Array.isArray(declared.scopes) ||
        !(declared.scopes as unknown[]).includes("user")
      ) {
        errors.push(
          'fetchHostGrantsNamespace\'s storage declaration must include the "user" scope'
        );
      }
    }
  }
  if (obj.web !== undefined) {
    if (typeof obj.web !== "object" || obj.web === null) {
      errors.push("web must be an object");
    } else {
      const { entrypoint, contractVersion } = obj.web as Record<string, unknown>;
      if (
        typeof entrypoint !== "string" ||
        entrypoint.length === 0 ||
        entrypoint.startsWith("/") ||
        entrypoint.includes("\\") ||
        entrypoint.split("/").some((seg) => seg === ".." || seg === "." || seg.length === 0)
      ) {
        errors.push("web.entrypoint must be a clean package-relative path");
      }
      if (
        typeof contractVersion !== "number" ||
        !Number.isInteger(contractVersion) ||
        contractVersion < 1
      ) {
        errors.push("web.contractVersion must be a positive integer");
      }
    }
  }

  if (obj.runtime !== undefined) {
    if (typeof obj.runtime !== "object" || obj.runtime === null) {
      errors.push("runtime must be an object");
    } else {
      const { workerEntrypoint, workerContractVersion } = obj.runtime as Record<string, unknown>;
      if (workerEntrypoint !== "dist/worker.js") {
        errors.push('runtime.workerEntrypoint must be "dist/worker.js"');
      }
      if (workerContractVersion !== 1) {
        errors.push("runtime.workerContractVersion must be the number 1");
      }
    }
  }
  const assistantActionFamilies = validateActionFamilies(obj.assistantActionFamilies, errors);
  if (obj.assistantTools !== undefined) {
    if (!Array.isArray(obj.assistantTools)) {
      errors.push("assistantTools must be an array");
    } else {
      if (obj.runtime === undefined) errors.push("runtime is required when assistantTools exist");
      const names: string[] = [];
      const permissions: string[] = [];
      const handlers: string[] = [];
      for (const entry of obj.assistantTools) {
        if (typeof entry !== "object" || entry === null || Array.isArray(entry)) {
          errors.push("assistantTools entries must be objects");
          continue;
        }
        const tool = entry as Record<string, unknown>;
        if (typeof tool.name !== "string" || !tool.name.startsWith(`${expectedId}.`)) {
          errors.push(`assistant tool names must be prefixed with "${expectedId}."`);
        } else names.push(tool.name);
        if (
          typeof tool.permissionId !== "string" ||
          !tool.permissionId.startsWith(`${expectedId}.`)
        ) {
          errors.push(`assistant tool permission ids must be prefixed with "${expectedId}."`);
        } else permissions.push(tool.permissionId);
        if (!isNonEmptyString(tool.description))
          errors.push("assistant tool description is required");
        if (
          tool.actionLabel !== undefined &&
          (!isNonEmptyString(tool.actionLabel) ||
            tool.actionLabel.length > 80 ||
            // eslint-disable-next-line no-control-regex -- approval labels must be plain text.
            /[\u0000-\u001F\u007F]/.test(tool.actionLabel))
        ) {
          errors.push(
            "assistant tool actionLabel must be non-empty plain text (max 80 UTF-16 code units) when present"
          );
        }
        if (
          tool.risk !== "read" &&
          tool.risk !== "write" &&
          tool.risk !== "outbound" &&
          tool.risk !== "destructive"
        ) {
          errors.push('assistant tool risk must be "read", "write", "outbound", or "destructive"');
        }
        validateAssistantToolPolicy(tool, assistantActionFamilies, errors);
        if (!isNonEmptyString(tool.handler)) errors.push("assistant tool handler is required");
        else handlers.push(tool.handler);
        if (tool.inputSchema !== undefined) lintAssistantToolInputSchema(tool, errors);
      }
      if (new Set(names).size !== names.length) errors.push("assistant tool names must be unique");
      if (new Set(permissions).size !== permissions.length) {
        errors.push("assistant tool permission ids must be unique");
      }
      if (new Set(handlers).size !== handlers.length)
        errors.push("assistant tool handlers must be unique");
    }
  }

  let assistantOnboarding: ModuleAssistantOnboardingManifest | undefined;
  if (obj.assistantOnboarding !== undefined) {
    if (
      typeof obj.assistantOnboarding !== "object" ||
      obj.assistantOnboarding === null ||
      Array.isArray(obj.assistantOnboarding)
    ) {
      errors.push("assistantOnboarding must be an object");
    } else {
      const onboarding = obj.assistantOnboarding as Record<string, unknown>;
      const unknownKeys = Object.keys(onboarding).filter((key) => key !== "guidance");
      if (unknownKeys.length > 0) {
        errors.push(`assistantOnboarding contains unknown fields: ${unknownKeys.join(", ")}`);
      }
      if (
        !isNonEmptyString(onboarding.guidance) ||
        new TextEncoder().encode(onboarding.guidance as string).byteLength >
          ASSISTANT_ONBOARDING_GUIDANCE_MAX_BYTES ||
        // eslint-disable-next-line no-control-regex -- manifest guidance must be plain text.
        /[\u0000-\u001F\u007F]/.test(onboarding.guidance as string)
      ) {
        errors.push(
          `assistantOnboarding.guidance must be non-empty plain text (${ASSISTANT_ONBOARDING_GUIDANCE_MAX_BYTES} bytes max)`
        );
      } else if (unknownKeys.length === 0) {
        assistantOnboarding = { guidance: onboarding.guidance as string };
      }
    }
  }

  if ((obj.worker !== undefined || obj.fetchHosts !== undefined) && obj.runtime === undefined) {
    errors.push("runtime is required when worker or fetchHosts exist");
  }
  const worker =
    obj.worker === undefined
      ? undefined
      : validateWorker(obj.worker, expectedId, errors, reservedQueueNames);
  if (obj.fetchHosts !== undefined) {
    if (
      !Array.isArray(obj.fetchHosts) ||
      !obj.fetchHosts.every((host) => typeof host === "string")
    ) {
      errors.push("fetchHosts must be an array of hostnames");
    } else {
      try {
        assertValidFetchHosts(expectedId, obj.fetchHosts as string[]);
      } catch (error) {
        errors.push(error instanceof Error ? error.message : "fetchHosts are invalid");
      }
    }
  }

  // #964: positive validation of the database declaration (previously forbidden).
  let database: ExternalModuleDatabaseDeclaration | undefined;
  if (obj.database !== undefined) {
    if (typeof obj.database !== "object" || obj.database === null || Array.isArray(obj.database)) {
      errors.push("database must be an object");
    } else {
      const databaseObj = obj.database as Record<string, unknown>;
      const unknownKeys = Object.keys(databaseObj).filter((key) => key !== "ownedTables");
      if (unknownKeys.length > 0) {
        errors.push(`database contains unknown fields: ${unknownKeys.join(", ")}`);
      }
      const ownedTables = databaseObj.ownedTables;
      const slugPrefix = `app.${expectedId.replace(/-/g, "_")}_`;
      if (!Array.isArray(ownedTables) || ownedTables.length > 32) {
        errors.push("database.ownedTables must be an array of at most 32 table names");
      } else {
        const seen = new Set<string>();
        const validated: string[] = [];
        for (const table of ownedTables) {
          if (typeof table !== "string" || !MODULE_OWNED_TABLE_RE.test(table)) {
            errors.push(`database.ownedTables entry is not a valid app-schema table name`);
          } else if (!table.startsWith(slugPrefix)) {
            errors.push(`database.ownedTables entry must be prefixed "${slugPrefix}": ${table}`);
          } else if (seen.has(table)) {
            errors.push(`database.ownedTables contains a duplicate: ${table}`);
          } else {
            seen.add(table);
            validated.push(table);
          }
        }
        if (errors.length === 0 && unknownKeys.length === 0) {
          database = { ownedTables: validated };
        }
      }
    }
  }

  // #1019: navigation entries an installed module may contribute. Validation lives in
  // validate-declarations.ts alongside the preferences check, to keep this file bounded.
  const navigation = validateModuleNavigation(obj, expectedId, errors);

  // #1725: on/off switches an installed module may declare. The validation lives in its own
  // file only to keep this one under the 1000-line check; see that file for the design.
  const preferences = validateModulePreferences(obj, errors);

  // #1282: positive validation of the briefing contribution declaration. Same shape as
  // every other allow-listed surface above: unknown keys rejected outright rather than
  // ignored, bounded strings, and a cross-check that the handler has a worker to run in.
  let briefing: ExternalModuleBriefingDeclaration | undefined;
  if (obj.briefing !== undefined) {
    if (typeof obj.briefing !== "object" || obj.briefing === null || Array.isArray(obj.briefing)) {
      errors.push("briefing must be an object");
    } else {
      const block = obj.briefing as Record<string, unknown>;
      const unknownKeys = Object.keys(block).filter(
        (key) => !["handler", "sections", "toolName"].includes(key)
      );
      if (unknownKeys.length > 0) {
        errors.push(`briefing contains unknown fields: ${unknownKeys.join(", ")}`);
      }
      // A briefing handler with no worker entrypoint is the real error case: the
      // manifest promises a section the host has no process to produce it from.
      if (obj.runtime === undefined) {
        errors.push("runtime is required when briefing is declared");
      }
      if (
        typeof block.handler !== "string" ||
        block.handler.length > 64 ||
        !/^[a-z][a-zA-Z0-9]*(?:\.[a-z][a-zA-Z0-9]*)*$/.test(block.handler)
      ) {
        errors.push("briefing.handler must be a dotted handler name (max 64 chars)");
      }
      if (
        !Array.isArray(block.sections) ||
        block.sections.length === 0 ||
        block.sections.length > BRIEFING_SECTIONS.length ||
        block.sections.some((section) => !BRIEFING_SECTIONS.includes(section as never)) ||
        new Set(block.sections).size !== block.sections.length
      ) {
        errors.push(
          `briefing.sections must be a non-empty unique subset of ${JSON.stringify(BRIEFING_SECTIONS)}`
        );
      }
      // The name the user selects in briefing settings, so it shares the namespaced
      // shape core briefing tools use — never a bare word that could collide.
      if (
        typeof block.toolName !== "string" ||
        block.toolName.length > 64 ||
        !/^[a-z][a-z0-9-]*\.[a-z][a-zA-Z0-9]*$/.test(block.toolName)
      ) {
        errors.push("briefing.toolName must look like <module-id>.<name>");
      }
      if (errors.length === 0) {
        briefing = {
          handler: block.handler as string,
          sections: block.sections as readonly ("morning" | "evening")[],
          toolName: block.toolName as string
        };
      }
    }
  }

  if (errors.length > 0) return { ok: false, errors };

  // Re-shape to exactly the allowed fields (drop unknown keys defensively). schemaVersion is
  // pinned to the literal 1 — validation above guarantees obj.schemaVersion === 1 to reach here.
  const manifest: JsonMossModuleManifest = {
    schemaVersion: 1,
    id: obj.id as string,
    name: obj.name as string,
    version: obj.version as string,
    publisher: obj.publisher as string,
    lifecycle: obj.lifecycle as ModuleLifecycle,
    compatibility: { jarv1s: (compatibility as { jarv1s: string }).jarv1s },
    ...(typeof obj.description === "string" ? { description: obj.description } : {}),
    ...(obj.auth !== undefined ? { auth: obj.auth as readonly ModuleAuthDeclaration[] } : {}),
    ...(obj.storage !== undefined
      ? { storage: obj.storage as readonly ModuleStorageDeclaration[] }
      : {}),
    ...(obj.web !== undefined ? { web: obj.web as ModuleWebDeclaration } : {}),
    ...(obj.runtime !== undefined
      ? { runtime: obj.runtime as JsonMossModuleManifest["runtime"] }
      : {}),
    ...(obj.assistantTools !== undefined
      ? { assistantTools: obj.assistantTools as readonly ExternalModuleAssistantToolDeclaration[] }
      : {}),
    ...(assistantActionFamilies !== undefined ? { assistantActionFamilies } : {}),
    ...(worker !== undefined ? { worker } : {}),
    ...(obj.fetchHosts !== undefined ? { fetchHosts: obj.fetchHosts as readonly string[] } : {}),
    ...(obj.fetchHostGrantsNamespace !== undefined
      ? { fetchHostGrantsNamespace: obj.fetchHostGrantsNamespace as string }
      : {}),
    ...(database !== undefined ? { database } : {}),
    ...(navigation !== undefined ? { navigation } : {}),
    ...(preferences !== undefined ? { preferences } : {}),
    // #1282: this literal is an allow-list — a validated field that is not re-emitted
    // here vanishes from the manifest with validation still returning ok. Omitting this
    // line is silent, and only tests/unit/external-module-briefing-manifest.test.ts
    // case 9 catches it.
    ...(briefing !== undefined ? { briefing } : {}),
    ...(assistantOnboarding !== undefined ? { assistantOnboarding } : {})
  };
  return { ok: true, manifest };
}
