# Moss Extensions Phase 0: The Decision Model Turns On Directly — Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** An admin can switch the classifier chat gate straight to On, from Off or from Shadow, with no shadow review recorded, and the gate then runs as On.

**Architecture:** Two checks enforce the review step today. The settings write route refuses `on` with a 409 when no review row exists, and the chat side reads a stored `on` as `shadow` until the current classifier has a review. Both are removed, along with the port and wiring that connect them and the resolver rule that turns an environment `on` into `off`. The Settings row drops its review-dependent lock on the On button. The shadow log and the review table stay as records. The chat side's gate-mode reader moves into its own small file so a unit test can prove it reads only the stored setting.

**Tech Stack:** TypeScript, Fastify, Kysely, React with TanStack Query, Vitest, Playwright UAT harness.

**Spec:** `docs/superpowers/specs/2026-10-11-moss-extensions-design.md`, section "Phase 0: the decision model turns on directly".

**Plain English rule (from Ben, pass it on):** name things by what they do, and keep exact names only where someone must act on them (a command, a file path, an error string). No colon-hinged sentences, no verbless fragments, no invented shorthand. Code, commit messages and test names stay precise and technical. The PR body, the PR comment and every status line follow the rule.

## Global Constraints

- One pull request for the whole plan, built in its own worktree on a branch from `origin/main`.
- Both review checks are removed, not relaxed (spec). No new check replaces them.
- Keep the shadow log (`app.chat_classifier_shadow_records`) and its records. Moss reads them to tune the decision model.
- Keep the review table `app.chat_classifier_shadow_reviews` and its row-security tests. No migration in this PR. Never edit `packages/chat/sql/0271_chat_classifier_shadow_reviews.sql`.
- The Settings row keeps its guard for "no decision model chosen" and its guard for "a change is already saving".
- Only an instance admin may write the gate. After this PR that is the only guard on turning it On, so it gets a hostile test and a control (Task 1).
- The settings package must not import chat internals. Removing the injected port keeps that true.
- Update the app map in the same PR: `packages/shared/src/app-map-core.ts` (Classifier row) and `packages/ai/src/manifest.ts` (the `ai.classifier_gate_setting` feature).
- Fill in the PR template's "Release note" section. Category `Changed`.
- Database tests run only through `scripts/run-gate.sh`, never an unscoped `pnpm test:integration` or `pnpm verify:foundation`. Never pipe a gate command.
- Live proof follows `docs/DEVELOPMENT_STANDARDS.md` → Live-Path Gate. No screenshots, no intercepted or rewritten network responses. Disclose the test stand-ins on the PR.
- The repository is public. No hostnames, LAN addresses, passwords or tokens in the PR body or comment.
- Shared checkout rules apply. Never `git add -A` or `git add .`, never `git stash`/`reset`/`checkout` in `~/Jarv1s`. Stage files by path.

## Review Focus

1. A saved On stays On after the admin changes or clears the classifier. The gate must never quietly drop back to Shadow. Test: the gate-mode reader reads only the stored setting and fails if it touches any other table (Task 2, "never reads the review table or the classifier binding").
2. A saved Off beats an environment value of On. An admin who chose Off must not be overridden by a server setting. Test: resolver precedence test (Task 1) and reader test (Task 2).
3. On is not one-way. An admin can go from On back to Off and the route stores it. Test: route unit test and integration test walk Shadow, On, Off (Task 1).
4. Two quick clicks while a change is saving must not race. Every gate button stays locked until the save finishes. Test: "locks every gate choice while a change is saving" (Task 3).
5. A saved On with the classifier cleared shows On as the saved state but locks the whole gate, and chat falls back to the main model. Test: "shows a saved On as pressed but locked once the classifier is cleared" (Task 3), plus the existing no-classifier decline test run in Task 2.

## File Map

| File                                                       | Change                                                                       |
| ---------------------------------------------------------- | ---------------------------------------------------------------------------- |
| `packages/settings/src/runtime-config-routes.ts`           | Drop the 409, the `classifierActivation` port, two unused imports            |
| `packages/module-registry/src/index.ts`                    | Drop the port wiring and the `isCurrentClassifierReviewed` import            |
| `packages/settings/src/runtime-config-resolver.ts`         | Drop the environment On-to-Off rule and two unused imports                   |
| `packages/settings/src/runtime-config-keys.ts`             | Rewrite the gate key's comment and description                               |
| `packages/ai/src/manifest.ts`                              | Rewrite the `ai.classifier_gate_setting` feature, drop its remediation/error |
| `packages/chat/src/live/classifier-gate-mode.ts`           | Create. `createGateModeReader`                                               |
| `packages/chat/src/routes.ts`                              | Use `createGateModeReader`, drop the review downgrade                        |
| `packages/chat/src/classifier-shadow-review-repository.ts` | Delete the review checks, keep the table reader                              |
| `packages/chat/src/live/classifier-gate-runner.ts`         | Fix one comment                                                              |
| `apps/web/src/settings/settings-ai-sorting-row.tsx`        | Drop `canChooseOn`, the On tooltip and the review note                       |
| `packages/shared/src/app-map-core.ts`                      | Rewrite the Classifier row's gate sentences                                  |
| `tests/unit/runtime-config-routes.test.ts`                 | Replace the review tests, add the hostile admin test                         |
| `tests/unit/runtime-config-resolver.test.ts`               | Replace the env fail-closed test, add precedence                             |
| `tests/unit/runtime-config-registry.test.ts`               | Assert the description has no review                                         |
| `tests/integration/classifier-gate-setting-routes.test.ts` | On with no review, On to Off, non-admin On                                   |
| `tests/unit/chat-classifier-effective-gate-mode.test.ts`   | Delete                                                                       |
| `tests/unit/chat-classifier-gate-mode-reader.test.ts`      | Create                                                                       |
| `tests/integration/chat-classifier-shadow-review.test.ts`  | Drop the removed check's import and assertion                                |
| `tests/integration/foundation-schema-catalog.test.ts`      | Fix one comment                                                              |
| `tests/unit/settings-ai-sorting-row.test.tsx`              | Update gate tests, add click, saving-lock and cleared-classifier tests       |
| `tests/uat/specs/classifier-settings.uat.spec.ts`          | Shadow to On through the row instead of the 409                              |
| `tests/uat/specs/shadow-report.uat.spec.ts`                | Drop the review-note assertion                                               |
| `tests/uat/specs/classifier-gate-on.uat.spec.ts`           | Create. The live proof                                                       |

---

### Task 1: The server accepts On with no review

**Files:**

- Modify: `packages/settings/src/runtime-config-routes.ts:3,14,29-37,143-157`
- Modify: `packages/module-registry/src/index.ts:173,1863-1873`
- Modify: `packages/settings/src/runtime-config-resolver.ts:1-11,100-110`
- Modify: `packages/settings/src/runtime-config-keys.ts:87-100`
- Modify: `packages/ai/src/manifest.ts:277-301`
- Test: `tests/unit/runtime-config-routes.test.ts`
- Test: `tests/unit/runtime-config-resolver.test.ts`
- Test: `tests/unit/runtime-config-registry.test.ts`
- Test: `tests/integration/classifier-gate-setting-routes.test.ts`

**Interfaces:**

- Consumes: nothing from other tasks.
- Produces: `RuntimeConfigRoutesDependencies` loses its optional `classifierActivation` member. `packages/module-registry/src/index.ts` no longer imports `isCurrentClassifierReviewed`, so Task 2 can delete it. `RuntimeConfigResolver` returns an environment `on` for `chat.classifier_gate_mode` as `{ value: "on", source: "env" }`.

- [ ] **Step 0: Create the worktree (first task only)**

```bash
git -C ~/Jarv1s fetch -q origin
git -C ~/Jarv1s worktree add ~/Jarv1s-phase0 -b feat/classifier-gate-on-directly origin/main
cd ~/Jarv1s-phase0 && pnpm install --frozen-lockfile
```

All later commands in this plan run from `~/Jarv1s-phase0`.

- [ ] **Step 1: Write the failing route unit tests**

In `tests/unit/runtime-config-routes.test.ts`, replace the `makeServer` options type and drop the port spread so the function reads:

```ts
function makeServer(options?: {
  readonly initialSettings?: readonly [string, Record<string, unknown>][];
  readonly env?: NodeJS.ProcessEnv;
  readonly isAdmin?: boolean;
}): {
  readonly server: FastifyInstance;
  readonly upserts: unknown[];
} {
```

and the end of the `registerRuntimeConfigRoutes(server, { ... })` call reads:

```ts
    } satisfies Pick<
      SettingsRepository,
      "getUserById" | "upsertInstanceSetting" | "deleteInstanceSetting"
    > as unknown as SettingsRepository,
    env: options?.env ?? {}
  });
```

Then delete the five tests from `it("rejects a forged admin PUT of on without a shadow review for the current classifier (#2984)"` through the end of `it("fails closed when the shadow review database read throws (#2881)"` (the last test in the file), and put these in their place, before the closing `});` of the `describe`:

```ts
it("accepts the classifier gate on with no shadow review recorded", async () => {
  const made = makeServer();
  server = made.server;

  const res = await server.inject({
    method: "PUT",
    url: `/api/admin/runtime-config/${CHAT_CLASSIFIER_GATE_MODE_CONFIG_KEY}`,
    payload: { value: "on" }
  });

  expect(res.statusCode).toBe(200);
  expect(res.json()).toEqual({ config: { value: "on", source: "instance" } });
  expect(made.upserts).toHaveLength(1);
});

it("moves the classifier gate from shadow to on and back to off", async () => {
  const made = makeServer();
  server = made.server;
  const put = (value: string) =>
    made.server.inject({
      method: "PUT",
      url: `/api/admin/runtime-config/${CHAT_CLASSIFIER_GATE_MODE_CONFIG_KEY}`,
      payload: { value }
    });

  expect((await put("shadow")).statusCode).toBe(200);

  const on = await put("on");
  expect(on.statusCode).toBe(200);
  expect(on.json()).toEqual({ config: { value: "on", source: "instance" } });

  const off = await put("off");
  expect(off.statusCode).toBe(200);
  expect(off.json()).toEqual({ config: { value: "off", source: "instance" } });
  expect(made.upserts).toHaveLength(3);
});

// Admin-only writes are the one guard left on turning the gate on.
it("rejects a non-admin turning the classifier gate on", async () => {
  const made = makeServer({ isAdmin: false });
  server = made.server;

  const res = await server.inject({
    method: "PUT",
    url: `/api/admin/runtime-config/${CHAT_CLASSIFIER_GATE_MODE_CONFIG_KEY}`,
    payload: { value: "on" }
  });

  expect(res.statusCode).toBe(403);
  expect(made.upserts).toEqual([]);
});
```

- [ ] **Step 2: Write the failing resolver and registry tests**

In `tests/unit/runtime-config-resolver.test.ts`, delete the comment and the test `it("fails the classifier gate closed to off when the environment says on (#2881)"` and put these in its place:

```ts
it("lets the environment turn the classifier gate on when nothing is saved", async () => {
  const resolver = new RuntimeConfigResolver(scopedDbWithSetting(undefined), {
    MOSS_CHAT_CLASSIFIER_GATE_MODE: "on"
  });

  await expect(resolver.resolveEnum(CHAT_CLASSIFIER_GATE_MODE_CONFIG_KEY)).resolves.toBe("on");
  await expect(resolver.getStatus(CHAT_CLASSIFIER_GATE_MODE_CONFIG_KEY)).resolves.toEqual({
    value: "on",
    source: "env"
  });
});

it("keeps a saved off ahead of an environment on for the classifier gate", async () => {
  const resolver = new RuntimeConfigResolver(scopedDbWithSetting({ value: "off" }), {
    MOSS_CHAT_CLASSIFIER_GATE_MODE: "on"
  });

  await expect(resolver.resolveEnum(CHAT_CLASSIFIER_GATE_MODE_CONFIG_KEY)).resolves.toBe("off");
  await expect(resolver.getStatus(CHAT_CLASSIFIER_GATE_MODE_CONFIG_KEY)).resolves.toEqual({
    value: "off",
    source: "instance"
  });
});
```

In `tests/unit/runtime-config-registry.test.ts`, inside `it("registers the admin-wide classifier gate switch, defaulting off (#2881)"`, after the `toMatchObject` block add:

```ts
// The gate turns on with no review step, so its description must not promise one.
expect(entry?.description).not.toMatch(/review/i);
expect(entry?.description).toContain("On lets the gate act");
```

- [ ] **Step 3: Run the unit tests to verify they fail**

Run: `pnpm test:unit tests/unit/runtime-config-routes.test.ts tests/unit/runtime-config-resolver.test.ts tests/unit/runtime-config-registry.test.ts`

Expected: FAIL. The route tests get 409 instead of 200 (no port is wired, so the old check fails closed). The resolver test gets `"off"` instead of `"on"`. The registry test finds "review" in the description.

- [ ] **Step 4: Remove the 409 and the port from the route**

In `packages/settings/src/runtime-config-routes.ts`:

Line 3 becomes:

```ts
import type { AccessContext, DataContextRunner } from "@moss/db";
```

The `./runtime-config-keys.js` import becomes:

```ts
import {
  getRuntimeConfigEntry,
  type RuntimeConfigKeyEntry,
  type RuntimeConfigType
} from "./runtime-config-keys.js";
```

The dependencies interface becomes:

```ts
export interface RuntimeConfigRoutesDependencies {
  readonly dataContext: DataContextRunner;
  readonly resolveAccessContext: (request: FastifyRequest) => Promise<AccessContext>;
  readonly repository: SettingsRepository;
  readonly env?: NodeJS.ProcessEnv;
  readonly onConfigChanged?: (key: string) => void;
}
```

In the PUT handler, delete the comment and the `if (key === CHAT_CLASSIFIER_GATE_MODE_CONFIG_KEY && value === "on") { ... }` block, so the start of the data-context callback reads:

```ts
        const config = await dataContext.withDataContext(accessContext, async (scopedDb) => {
          await assertAdminUser(repository, scopedDb, accessContext.actorUserId);
          if (value.length === 0) {
```

`HttpError` stays imported because other guards in the file use it.

- [ ] **Step 5: Remove the port wiring from the composition root**

In `packages/module-registry/src/index.ts`, delete the line `  isCurrentClassifierReviewed,` from the `@moss/chat` import list (line 173). Then the `registerRuntimeConfigRoutes` call becomes:

```ts
registerRuntimeConfigRoutes(server, {
  dataContext: deps.dataContext,
  resolveAccessContext: deps.resolveAccessContext,
  repository: new SettingsRepository()
});
```

`AiRepository` stays imported because other code in the file uses it.

- [ ] **Step 6: Remove the environment On-to-Off rule**

In `packages/settings/src/runtime-config-resolver.ts`, the imports at the top become:

```ts
import { resolveMossEnv, type DataContextDb } from "@moss/db";

import {
  EMBED_PROVIDER_CONFIG_KEY,
  getRuntimeConfigEntry,
  type RuntimeConfigKeyEntry,
  type RuntimeConfigType
} from "./runtime-config-keys.js";
```

(Keep any other names that import list already carries. Only `CHAT_CLASSIFIER_GATE_MODE_CONFIG_KEY` and the `@moss/shared` import of `CLASSIFIER_GATE_MODE_DEFAULT` go.)

The environment branch in `resolve` becomes:

```ts
const envValue = resolveMossEnv(this.env, entry.envVar);
if (envValue && envValue.length > 0) {
  return { entry, value: envValue, source: "env" };
}
```

- [ ] **Step 7: Rewrite the gate key's comment and description**

In `packages/settings/src/runtime-config-keys.ts`, the comment above the gate entry and its description become:

```ts
  // Classifier gate (#2881, Ben's ruling 1, 2026-10-01). One admin-wide switch for the whole
  // instance, beside the Classifier (sorting) binding under Settings > AI providers. "off" is the
  // default. An admin may store any of the three values; this registry validates the enum.
  // Scope is intentionally instance-wide, not per user.
  {
    key: CHAT_CLASSIFIER_GATE_MODE_CONFIG_KEY,
    label: "Classifier gate",
    type: "enum",
    description:
      "Whether Moss may route eligible chat messages to the classifier model instead of the main " +
      "model. Off sends nothing to the classifier. Shadow records what the gate would do without " +
      "acting. On lets the gate act, and every user's eligible messages then reach the classifier " +
      "provider.",
```

- [ ] **Step 8: Update the app map feature**

In `packages/ai/src/manifest.ts`, replace the whole `ai.classifier_gate_setting` feature object (its `remediations` and `errors` included) with:

```ts
    {
      id: "ai.classifier_gate_setting",
      description:
        "Classifier gate: the Chat gate choice (Off, Shadow, On) in the Classifier row on Settings > " +
        "AI providers, an instance-wide setting. Any of the three can be picked as soon as a " +
        "classifier is chosen. On needs no Shadow run or review first."
    },
```

Leave `classifier_gate_not_released` in `packages/calendar/src/manifest.ts` alone. It describes the gate being Off or Shadow, which is still true.

- [ ] **Step 9: Run the unit tests to verify they pass**

Run: `pnpm test:unit tests/unit/runtime-config-routes.test.ts tests/unit/runtime-config-resolver.test.ts tests/unit/runtime-config-registry.test.ts`

Expected: PASS.

- [ ] **Step 10: Control for the admin-only guard**

Admin-only writes are now the only thing between a user and turning the gate on for everyone, so prove the hostile test catches its removal. In the PUT handler of `packages/settings/src/runtime-config-routes.ts`, comment out only this line:

```ts
await assertAdminUser(repository, scopedDb, accessContext.actorUserId);
```

Run: `pnpm test:unit tests/unit/runtime-config-routes.test.ts -t "rejects a non-admin turning the classifier gate on"`

Expected: FAIL (status 200, one upsert recorded). Restore the line exactly, rerun the same command, and expect PASS. Record both results for the PR comment.

- [ ] **Step 11: Update the integration test**

In `tests/integration/classifier-gate-setting-routes.test.ts`, replace the header comment with:

```ts
// #2881: the classifier gate setting has ONE write door, its typed runtime-config route, which
// enforces the off/shadow/on enum and admin-only writes. These tests run the real API server
// against a real database. They prove the generic settings route refuses the key, that an admin
// can turn the gate on with no shadow review recorded, and that a non-admin cannot.
```

Replace the test `it("defaults to off, and refuses on until the current classifier has a shadow review"` with:

```ts
it("defaults to off, and turns on with no shadow review recorded", async () => {
  // Missing value resolves to the off default.
  const initial = await server.inject({
    method: "GET",
    url: `/api/admin/runtime-config/${GATE_KEY}`,
    headers: { authorization: `Bearer ${ids.sessionA}` }
  });
  expect(initial.json()).toEqual({ config: { value: "off", source: "default" } });

  // Off to On, with no classifier chosen and no review.
  const onFromOff = await putGate("on");
  expect(onFromOff.statusCode).toBe(200);
  expect(onFromOff.json()).toEqual({ config: { value: "on", source: "instance" } });

  // Shadow to On after a classifier is chosen, still with no review.
  expect((await putGate("shadow")).statusCode).toBe(200);
  await selectClassifier();
  const onFromShadow = await putGate("on");
  expect(onFromShadow.statusCode).toBe(200);
  expect(onFromShadow.json()).toEqual({ config: { value: "on", source: "instance" } });

  // On is not one-way.
  const off = await putGate("off");
  expect(off.statusCode).toBe(200);
  expect(off.json()).toEqual({ config: { value: "off", source: "instance" } });

  expect(
    await bootstrapCount("SELECT count(*)::int AS n FROM app.chat_classifier_shadow_reviews")
  ).toBe(0);
});
```

Replace the non-admin test with:

```ts
it("refuses a non-admin turning the gate on on its typed route", async () => {
  const res = await server.inject({
    method: "PUT",
    url: `/api/admin/runtime-config/${GATE_KEY}`,
    headers: { authorization: `Bearer ${ids.sessionB}` },
    payload: { value: "on" }
  });
  expect(res.statusCode).toBe(403);

  const stored = await server.inject({
    method: "GET",
    url: `/api/admin/runtime-config/${GATE_KEY}`,
    headers: { authorization: `Bearer ${ids.sessionA}` }
  });
  expect(stored.json().config.value).toBe("off");
});
```

Delete the `insertReview` and `bootstrapQuery` helpers (nothing uses them now) and add:

```ts
async function bootstrapCount(text: string): Promise<number> {
  const client = new Client({ connectionString: connectionStrings.bootstrap });
  await client.connect();
  try {
    const result = await client.query<{ n: number }>(text);
    return result.rows[0]?.n ?? -1;
  } finally {
    await client.end();
  }
}
```

`selectClassifier` keeps its body. Its return value is now unused at the call site, which is fine.

- [ ] **Step 12: Static checks**

Run: `pnpm typecheck` then `pnpm lint`

Expected: both exit 0. Then confirm no live code still names the removed pieces:

Run: `git grep -n -e classifierActivation -e hasShadowReviewForCurrentClassifier -e "no shadow review is recorded" -e not_released -- packages apps tests`

Expected: one hit only, `packages/calendar/src/manifest.ts` (`classifier_gate_not_released`).

- [ ] **Step 13: Commit**

```bash
git add packages/settings/src/runtime-config-routes.ts packages/module-registry/src/index.ts \
  packages/settings/src/runtime-config-resolver.ts packages/settings/src/runtime-config-keys.ts \
  packages/ai/src/manifest.ts tests/unit/runtime-config-routes.test.ts \
  tests/unit/runtime-config-resolver.test.ts tests/unit/runtime-config-registry.test.ts \
  tests/integration/classifier-gate-setting-routes.test.ts
git commit -m "feat(settings): accept classifier gate on without a shadow review"
```

The integration test runs in the full gate in Task 4.

---

### Task 2: Chat runs a stored On as On

**Files:**

- Create: `packages/chat/src/live/classifier-gate-mode.ts`
- Modify: `packages/chat/src/routes.ts:112-113,119-120,390-411`
- Modify: `packages/chat/src/classifier-shadow-review-repository.ts` (whole file)
- Modify: `packages/chat/src/live/classifier-gate-runner.ts:79-82`
- Delete: `tests/unit/chat-classifier-effective-gate-mode.test.ts`
- Create: `tests/unit/chat-classifier-gate-mode-reader.test.ts`
- Modify: `tests/integration/chat-classifier-shadow-review.test.ts:1-12,68-79`
- Modify: `tests/integration/foundation-schema-catalog.test.ts:580`

**Interfaces:**

- Consumes: Task 1 removed the only outside caller of `isCurrentClassifierReviewed` (`packages/module-registry/src/index.ts`). Run Task 1 first or typecheck fails.
- Produces:
  - `createGateModeReader(dataContext: Pick<DataContextRunner, "withDataContext">, env?: NodeJS.ProcessEnv): (actorUserId: string) => Promise<GateMode>` in `packages/chat/src/live/classifier-gate-mode.ts`.
  - `@moss/chat` no longer exports `resolveEffectiveGateMode`, `isCurrentClassifierReviewed` or `ClassifierShadowReviewDeps`. It still exports `ClassifierSelection`, `HasReviewForSelection` and `hasReviewForSelection`.

- [ ] **Step 1: Write the failing reader test**

Create `tests/unit/chat-classifier-gate-mode-reader.test.ts`:

```ts
import { describe, expect, it } from "vitest";

import {
  dataContextBrand,
  type AccessContext,
  type DataContextDb,
  type DataContextRunner
} from "../../packages/db/src/index.js";
import { createGateModeReader } from "../../packages/chat/src/live/classifier-gate-mode.js";

const ACTOR_ID = "00000000-0000-4000-8000-000000000001";

/**
 * A data context whose scoped database holds one saved gate value and refuses every other table,
 * so a read of the review table or the classifier binding fails the test.
 */
function fakeDataContext(storedValue: string | undefined) {
  const tablesRead: string[] = [];
  const actors: string[] = [];
  const scopedDb = {
    [dataContextBrand]: true,
    db: {
      selectFrom: (table: string) => {
        tablesRead.push(table);
        if (table !== "app.instance_settings") {
          throw new Error(`gate mode reader read ${table}`);
        }
        return {
          select: () => ({
            where: () => ({
              executeTakeFirst: async () =>
                storedValue === undefined ? undefined : { value: { value: storedValue } }
            })
          })
        };
      }
    }
  } as unknown as DataContextDb;
  const dataContext = {
    withDataContext: async <T>(
      context: AccessContext,
      work: (db: DataContextDb) => Promise<T>
    ): Promise<T> => {
      actors.push(context.actorUserId);
      return work(scopedDb);
    }
  } as unknown as Pick<DataContextRunner, "withDataContext">;
  return { dataContext, tablesRead, actors };
}

describe("createGateModeReader", () => {
  it("runs a saved on as on and never reads the review table or the classifier binding", async () => {
    const { dataContext, tablesRead, actors } = fakeDataContext("on");
    const read = createGateModeReader(dataContext, {});

    await expect(read(ACTOR_ID)).resolves.toBe("on");
    expect(tablesRead).toEqual(["app.instance_settings"]);
    expect(actors).toEqual([ACTOR_ID]);
  });

  it("runs an environment on as on when nothing is saved", async () => {
    const { dataContext } = fakeDataContext(undefined);
    const read = createGateModeReader(dataContext, { MOSS_CHAT_CLASSIFIER_GATE_MODE: "on" });

    await expect(read(ACTOR_ID)).resolves.toBe("on");
  });

  it("keeps a saved off ahead of an environment on", async () => {
    const { dataContext } = fakeDataContext("off");
    const read = createGateModeReader(dataContext, { MOSS_CHAT_CLASSIFIER_GATE_MODE: "on" });

    await expect(read(ACTOR_ID)).resolves.toBe("off");
  });

  it("returns a saved shadow unchanged, and off when nothing is set", async () => {
    await expect(
      createGateModeReader(fakeDataContext("shadow").dataContext, {})(ACTOR_ID)
    ).resolves.toBe("shadow");
    await expect(
      createGateModeReader(fakeDataContext(undefined).dataContext, {})(ACTOR_ID)
    ).resolves.toBe("off");
  });
});
```

- [ ] **Step 2: Run it to verify it fails**

Run: `pnpm test:unit tests/unit/chat-classifier-gate-mode-reader.test.ts`

Expected: FAIL, cannot resolve `../../packages/chat/src/live/classifier-gate-mode.js`.

- [ ] **Step 3: Create the reader**

Create `packages/chat/src/live/classifier-gate-mode.ts`:

```ts
import type { DataContextRunner } from "@moss/db";
import { CHAT_CLASSIFIER_GATE_MODE_CONFIG_KEY, RuntimeConfigResolver } from "@moss/settings";

import type { GateMode } from "./classifier-gate.js";

/**
 * Reads the admin gate mode as the gate runs it. The stored value is used as is, so a saved or
 * environment `on` runs as `on` with no review or classifier check.
 */
export function createGateModeReader(
  dataContext: Pick<DataContextRunner, "withDataContext">,
  env: NodeJS.ProcessEnv = process.env
): (actorUserId: string) => Promise<GateMode> {
  return (actorUserId) =>
    dataContext.withDataContext({ actorUserId }, (scopedDb) =>
      new RuntimeConfigResolver(scopedDb, env).resolveEnum<GateMode>(
        CHAT_CLASSIFIER_GATE_MODE_CONFIG_KEY
      )
    );
}
```

- [ ] **Step 4: Use the reader in the chat routes**

In `packages/chat/src/routes.ts`:

Delete these two import lines (nothing else in the file uses them):

```ts
import { RuntimeConfigResolver } from "@moss/settings";
import { CHAT_CLASSIFIER_GATE_MODE_CONFIG_KEY } from "@moss/settings";
```

Replace these two import lines:

```ts
import { THRESHOLD_VERSION, type GateMode } from "./live/classifier-gate.js";
import { resolveEffectiveGateMode } from "./classifier-shadow-review-repository.js";
```

with:

```ts
import { THRESHOLD_VERSION } from "./live/classifier-gate.js";
import { createGateModeReader } from "./live/classifier-gate-mode.js";
```

Replace the `readGateMode` block and the comment of the block after it with:

```ts
/** The admin gate mode, read fresh for each turn. Shared by both runners. */
const readGateMode = wiring ? createGateModeReader(dependencies.dataContext) : undefined;

/**
 * Task 4.1 (#2901) — the classifier gate seam, wired with the real access token and admin setting.
 * `buildClassifierGateRunner` owns the session-id shape, the token lifetime and the admin mode
 * read.
 */
```

- [ ] **Step 5: Delete the review checks**

Replace the whole of `packages/chat/src/classifier-shadow-review-repository.ts` with:

```ts
import { assertDataContextDb, type DataContextDb } from "@moss/db";

/**
 * Shadow reviews of the classifier gate (#2984 R2.4, migration 0271).
 *
 * One admin row per classifier selection. The rows are a record only. They gate nothing, and the
 * gate runs in whatever mode the admin stores. Every authed actor may read them and only admins
 * may write them. This module only reads.
 */

/** The configured model the classifier binding resolves to. */
export interface ClassifierSelection {
  readonly modelId: string;
  readonly providerModelId: string;
}

export type HasReviewForSelection = (
  scopedDb: DataContextDb,
  selection: ClassifierSelection
) => Promise<boolean>;

/** True when a shadow review row matches this exact selection. */
export const hasReviewForSelection: HasReviewForSelection = async (scopedDb, selection) => {
  assertDataContextDb(scopedDb);
  const row = await scopedDb.db
    .selectFrom("app.chat_classifier_shadow_reviews")
    .select("id")
    .where("classifier_model_id", "=", selection.modelId)
    .where("classifier_provider_model_id", "=", selection.providerModelId)
    .limit(1)
    .executeTakeFirst();
  return row !== undefined;
};
```

Delete the old unit test:

```bash
git rm tests/unit/chat-classifier-effective-gate-mode.test.ts
```

- [ ] **Step 6: Fix the runner comment**

In `packages/chat/src/live/classifier-gate-runner.ts`, the comment above `createPorts` becomes:

```ts
/**
 * #2907 (plan 3.5) — the production attempt ports: the actor's tool menu, the classifier calls,
 * candidate hooks and the gateway call (already bound to `token`). Absent ⇒ every attempt declines
 * without ports.
 */
```

- [ ] **Step 7: Update the review-table integration test and catalog comment**

In `tests/integration/chat-classifier-shadow-review.test.ts`, the imports and header comment become:

```ts
import { sql, type Kysely } from "kysely";
import { afterAll, beforeAll, describe, expect, it } from "vitest";

import { hasReviewForSelection } from "@moss/chat";
import { DataContextRunner, createDatabase, type MossDatabase } from "@moss/db";

import { connectionStrings, ids, resetFoundationDatabase } from "./test-database.js";

// #2984 R2.4: one shadow review per classifier selection, kept as a record only. The gate runs in
// whatever mode the admin stores, so these rows gate nothing. The table is empty by default.
// Instance-global admin data under RLS: every authed actor may read it, only an admin may write it.
```

and the test `it("is empty by default, and no classifier selected reads as not reviewed"` becomes:

```ts
it("is empty by default", async () => {
  const count = await sql<{ n: string }>`
      SELECT count(*)::text AS n FROM app.chat_classifier_shadow_reviews
    `.execute(appDb);
  expect(count.rows[0]?.n).toBe("0");
});
```

In `tests/integration/foundation-schema-catalog.test.ts` line 580, the comment becomes:

```ts
// #2984 R2.4 — one admin shadow review per classifier selection, kept as a record only.
```

- [ ] **Step 8: Run the chat unit tests to verify they pass**

Run: `pnpm test:unit tests/unit/chat-classifier-gate-mode-reader.test.ts tests/unit/chat-classifier-gate.test.ts tests/unit/chat-classifier-shadow-runner.test.ts`

Expected: PASS. The last two files already prove that with no classifier chosen the gate declines with `no_classifier` and the main model answers (Review Focus 5).

- [ ] **Step 9: Static checks**

Run: `pnpm typecheck` then `pnpm lint`

Expected: both exit 0. Then:

Run: `git grep -n -e resolveEffectiveGateMode -e isCurrentClassifierReviewed -e ClassifierShadowReviewDeps -- packages apps tests`

Expected: no output.

- [ ] **Step 10: Commit**

```bash
git add packages/chat/src/live/classifier-gate-mode.ts packages/chat/src/routes.ts \
  packages/chat/src/classifier-shadow-review-repository.ts \
  packages/chat/src/live/classifier-gate-runner.ts \
  tests/unit/chat-classifier-gate-mode-reader.test.ts \
  tests/integration/chat-classifier-shadow-review.test.ts \
  tests/integration/foundation-schema-catalog.test.ts
git commit -m "feat(chat): run a stored classifier gate on as on without a shadow review"
```

(The `git rm` in Step 5 already staged the deletion.)

---

### Task 3: The Settings row lets On be picked

**Files:**

- Modify: `apps/web/src/settings/settings-ai-sorting-row.tsx:137-141,255-277`
- Modify: `packages/shared/src/app-map-core.ts:316-322`
- Test: `tests/unit/settings-ai-sorting-row.test.tsx`
- Modify: `tests/uat/specs/classifier-settings.uat.spec.ts:4-8,63-65,112-135`
- Modify: `tests/uat/specs/shadow-report.uat.spec.ts:201`

**Interfaces:**

- Consumes: Task 1's route accepts `PUT /api/admin/runtime-config/chat.classifier_gate_mode` with `{ "value": "on" }` from an admin and answers `{ config: { value: "on", source: "instance" } }`.
- Produces: the Gate state buttons Off, Shadow and On are enabled whenever a classifier is chosen and no save is running. The On button has no `title`. The text "On opens after shadow review." and "Available after shadow results are reviewed" no longer exist. The Shadow badge link (`aria-label="See shadow results"`, `href="/settings?section=shadowreport"`) stays.

- [ ] **Step 1: Update and add the row unit tests**

In `tests/unit/settings-ai-sorting-row.test.tsx`, replace the tests `it("reads the saved gate record and keeps the gate unusable until a classifier is chosen"`, `it("enables the gate once a classifier is chosen but keeps On blocked"` and `it("enables On when the saved record already reads on"` with:

```tsx
it("reads the saved gate record and keeps the gate unusable until a classifier is chosen", async () => {
  const renderer = await render();
  expect(getAdminRuntimeConfig).toHaveBeenCalledWith("chat.classifier_gate_mode");
  expect(gateButton(renderer, "Off").props["aria-pressed"]).toBe(true);
  // The mockup keeps the whole gate disabled while no classifier is chosen.
  expect(gateButton(renderer, "Off").props.disabled).toBe(true);
  expect(gateButton(renderer, "Shadow").props.disabled).toBe(true);
  expect(gateButton(renderer, "On").props.disabled).toBe(true);
  expect(gateButton(renderer, "On").props.title).toBeUndefined();
});

it("enables all three gate choices once a classifier is chosen, with no review step", async () => {
  const renderer = await render({ kind: "model", modelId: "small-json" });
  for (const label of ["Off", "Shadow", "On"]) {
    expect(gateButton(renderer, label).props.disabled).toBe(false);
  }
  expect(gateButton(renderer, "On").props.title).toBeUndefined();
  expect(text(renderer)).not.toContain("On opens after shadow review.");
  expect(text(renderer)).not.toContain("Available after shadow results are reviewed");
});

it("enables On when the saved record already reads on", async () => {
  getAdminRuntimeConfig.mockResolvedValue({
    config: { value: "on", source: "instance" }
  } as never);
  const renderer = await render({ kind: "model", modelId: "small-json" });
  expect(gateButton(renderer, "On").props.disabled).toBe(false);
  expect(gateButton(renderer, "On").props["aria-pressed"]).toBe(true);
});

it("turns the gate on from off in one click", async () => {
  const renderer = await render({ kind: "model", modelId: "small-json" });
  await act(async () => {
    gateButton(renderer, "On").props.onClick();
  });
  expect(putAdminRuntimeConfig).toHaveBeenCalledWith("chat.classifier_gate_mode", "on");
});

it("turns the gate on from shadow in one click", async () => {
  getAdminRuntimeConfig.mockResolvedValue({
    config: { value: "shadow", source: "instance" }
  } as never);
  const renderer = await render({ kind: "model", modelId: "small-json" });
  await act(async () => {
    gateButton(renderer, "On").props.onClick();
  });
  expect(putAdminRuntimeConfig).toHaveBeenCalledWith("chat.classifier_gate_mode", "on");
});

it("locks every gate choice while a change is saving", async () => {
  putAdminRuntimeConfig.mockImplementationOnce(() => new Promise<never>(() => undefined));
  const renderer = await render({ kind: "model", modelId: "small-json" });
  await act(async () => {
    gateButton(renderer, "On").props.onClick();
  });
  for (const label of ["Off", "Shadow", "On"]) {
    expect(gateButton(renderer, label).props.disabled).toBe(true);
  }
});

it("shows a saved On as pressed but locked once the classifier is cleared", async () => {
  getAdminRuntimeConfig.mockResolvedValue({
    config: { value: "on", source: "instance" }
  } as never);
  const renderer = await render();
  expect(gateButton(renderer, "On").props["aria-pressed"]).toBe(true);
  for (const label of ["Off", "Shadow", "On"]) {
    expect(gateButton(renderer, label).props.disabled).toBe(true);
  }
});
```

Replace the test `it("links the Shadow badge and note to the shadow report while the gate is shadow"` with:

```tsx
it("links the Shadow badge to the shadow report while the gate is shadow", async () => {
  getAdminRuntimeConfig.mockResolvedValue({
    config: { value: "shadow", source: "instance" }
  } as never);
  const renderer = await render({ kind: "model", modelId: "small-json" });
  const hrefs = renderer.root.findAllByType("a").map((anchor) => anchor.props.href);
  expect(hrefs.filter((href) => href === "/settings?section=shadowreport")).toHaveLength(1);
  expect(text(renderer)).toContain("See shadow results");
});
```

- [ ] **Step 2: Run them to verify they fail**

Run: `pnpm test:unit tests/unit/settings-ai-sorting-row.test.tsx`

Expected: FAIL. On is still disabled with a classifier chosen, the On button still has its title, and the shadow link count is 2.

- [ ] **Step 3: Remove the review lock from the row**

In `apps/web/src/settings/settings-ai-sorting-row.tsx`, delete the comment and the `canChooseOn` line so this part reads:

```tsx
  const savedGateMode = readGateMode(gateQuery.data?.config.value);
  const gateMutation = useMutation({
```

Then the Segmented options and the end of the component become:

```tsx
          <Segmented
            value={savedGateMode}
            ariaLabel="Gate state"
            onChange={(mode) => gateMutation.mutate(mode)}
            options={CLASSIFIER_GATE_MODES.map((mode) => ({
              value: mode,
              label: GATE_LABELS[mode],
              disabled: gateMutation.isPending || gateDisabled
            }))}
          />
        </Field>
      </div>
    </div>
  );
}
```

`gateDisabled` (no classifier chosen) and `gateMutation.isPending` (a change is saving) are the two guards the spec keeps. `shadowReportHref` stays because the Shadow badge still uses it.

- [ ] **Step 4: Update the app map Classifier row**

In `packages/shared/src/app-map-core.ts`, replace these lines of the AI providers setting description:

```ts
      "configuration boundary. On needs a shadow review recorded for the current classifier, " +
      "and changing the classifier drops On back to Shadow until the new one is reviewed. No " +
      "review can be recorded yet, so On stays unavailable in the row meanwhile and every " +
      "message still goes to the main model. Once a model is chosen, a line " +
```

with:

```ts
      "configuration boundary. Any of Off, Shadow or On can be picked as soon as a classifier " +
      "is chosen, with no Shadow run or review first. With On, the classifier answers the chat " +
      "requests it is sure about and every other message goes to the main model. Once a model " +
      "is chosen, a line " +
```

- [ ] **Step 5: Update the two existing UAT specs**

In `tests/uat/specs/classifier-settings.uat.spec.ts`, the header comment's first sentence becomes:

```ts
// Classifier gate plan 1.3 (#2892), updated for Moss extensions phase 0. Proves the shipped
// Classifier settings row on the real Settings > AI providers screen: pick and clear a classifier,
// move the gate to Shadow and then straight to On with no review step, and that the row reads in
// light, dark and one park theme. The "default chat is unchanged" half needs a real chat turn; the
// UAT harness has no chat-capable AI provider at any seed level (#1121), so it is test.fixme'd with
// that citation.
```

The test title becomes:

```ts
test("the Classifier settings row picks and clears a classifier and turns `on` straight away (#2892)", async ({
```

Replace everything from the comment `// Re-pick, then the allowed gate state: Shadow.` through `expect((stored.body.config as { value: string }).value).toBe("shadow");` with:

```ts
// Re-pick, then Shadow. On is open straight away, with no review step.
await selectClassifier(page);
await gateButton(page, "Shadow").click();
await expect(gateButton(page, "Shadow")).toHaveAttribute("aria-pressed", "true");
await expect(gateButton(page, "On")).toBeEnabled();
await expect(page.getByText("On opens after shadow review.")).toHaveCount(0);
// Ruling 1: the row states the admin-wide reach of the gate.
await expect(page.getByText(/every user's eligible messages/)).toBeVisible();
await page.reload();
await openAssistantAndAiSettings(page);
await expect(gateButton(page, "Shadow")).toHaveAttribute("aria-pressed", "true");

// Shadow to On through the row. The save lands and survives a reload.
const onSaved = page.waitForResponse(
  (response) =>
    new URL(response.url()).pathname.endsWith(
      "/api/admin/runtime-config/chat.classifier_gate_mode"
    ) && response.request().method() === "PUT",
  { timeout: 30_000 }
);
await gateButton(page, "On").click();
expect((await onSaved).status()).toBe(200);
await expect(gateButton(page, "On")).toHaveAttribute("aria-pressed", "true");
const stored = await json(page, "/api/admin/runtime-config/chat.classifier_gate_mode");
expect(stored.status).toBe(200);
expect((stored.body.config as { value: string }).value).toBe("on");
await page.reload();
await openAssistantAndAiSettings(page);
await expect(gateButton(page, "On")).toHaveAttribute("aria-pressed", "true");
```

In `tests/uat/specs/shadow-report.uat.spec.ts`, delete this line (the note no longer exists; the badge link assertion above it stays):

```ts
await expect(page.getByText("On opens after shadow review.")).toBeVisible();
```

- [ ] **Step 6: Run the row tests to verify they pass**

Run: `pnpm test:unit tests/unit/settings-ai-sorting-row.test.tsx`

Expected: PASS.

- [ ] **Step 7: Static checks**

Run: `pnpm typecheck`, `pnpm lint`, then `pnpm build:app-map`

Expected: all exit 0. Then:

Run: `git grep -n -e canChooseOn -e "On opens after shadow review" -e "Available after shadow results" -e "drops On back" -- apps packages tests/unit`

Expected: no output.

- [ ] **Step 8: Commit**

```bash
git add apps/web/src/settings/settings-ai-sorting-row.tsx packages/shared/src/app-map-core.ts \
  tests/unit/settings-ai-sorting-row.test.tsx tests/uat/specs/classifier-settings.uat.spec.ts \
  tests/uat/specs/shadow-report.uat.spec.ts
git commit -m "feat(web): let the classifier gate switch to on without a review step"
```

---

### Task 4: Live proof, full gate and pull request

**Files:**

- Create: `tests/uat/specs/classifier-gate-on.uat.spec.ts`

**Interfaces:**

- Consumes: Tasks 1 to 3. The route accepts `on` from an admin, the chat gate runs a stored `on` as `on`, and the Settings row's On button is enabled once a classifier is chosen.
- Consumes from the UAT harness (unchanged): `execUatSql(project: string, sql: string): string` from `tests/uat/specs/job-search-board-sql.ts`; seed level `admin+data` with `chatScript: "classifier-shadow"` and `withClassifierFixture: true`, which seeds the model "UAT Classifier Fixture Model" (it prefers `calendar`, then `calendar.listVisibleEvents`) and a scripted main chat model whose reply to a "uatfix" message is "You have events on your calendar today."
- Produces: the PR and its live-proof comment.

The proof runs on the UAT harness's throwaway instance, not on the shared dev instance. The gate setting covers a whole instance, so flipping it on the shared dev instance would change chat for everyone using it. The harness still installs a fresh Moss, signs up the owner and drives the real Settings screen and chat drawer, which is what the live-path gate asks for.

The failing state for this task was proven by the unit tests in Tasks 1 to 3 (On refused, On locked). This spec proves the assembled path, so it is run once, after those tasks.

- [ ] **Step 1: Write the live proof spec**

Create `tests/uat/specs/classifier-gate-on.uat.spec.ts`:

```ts
import { expect, test, type Locator, type Page } from "@playwright/test";
import { UAT_ADMIN_EMAIL, UAT_ADMIN_PASSWORD } from "../seed/admin.js";
import { execUatSql } from "./job-search-board-sql.js";

// Moss extensions phase 0 live-path proof. The classifier gate turns On straight from Off and from
// Shadow through the real Settings row with no shadow review recorded, and a chat request is then
// answered through the gate.
//
// Disclosed stand-ins, both seeded by the UAT provisioner:
// - "UAT Classifier Fixture Model" answers the gate's choice questions
//   (tests/uat/fixtures/classifier-fixture-server.ts) and prefers the calendar listing tool.
// - The main chat model is the scripted backend (chat script "classifier-shadow"). When the gate
//   answers, the scripted reply never appears.
export const uatLevel = {
  level: "admin+data",
  without: [],
  withoutNewsJsonBinding: true,
  chatScript: "classifier-shadow",
  withClassifierFixture: true
} as const;

function requireBaseURL(): string {
  const baseURL = process.env.JARVIS_UAT_BASE_URL;
  if (!baseURL) throw new Error("JARVIS_UAT_BASE_URL must be set by run-uat.ts");
  return baseURL;
}

function requireProject(): string {
  const project = process.env.JARVIS_UAT_PROJECT_NAME;
  if (!project) throw new Error("JARVIS_UAT_PROJECT_NAME must be set by run-uat.ts");
  return project;
}

async function signIn(page: Page): Promise<void> {
  await page.goto(requireBaseURL());
  await page.getByLabel("Email").fill(UAT_ADMIN_EMAIL);
  await page.getByLabel("Password").fill(UAT_ADMIN_PASSWORD);
  await page.locator("form.auth-form").getByRole("button", { name: "Sign in" }).click();
  const skipSetup = page.getByRole("button", { name: "Skip setup" });
  const userMenu = page.getByRole("button", { name: /^Account menu(?:,|$)/ });
  await expect(skipSetup.or(userMenu).first()).toBeVisible({ timeout: 30_000 });
  if (await skipSetup.isVisible()) {
    await skipSetup.click();
    try {
      await page.getByRole("button", { name: "Skip anyway" }).click({ timeout: 5_000 });
    } catch {
      // No confirmation dialog on this instance.
    }
  }
  await expect(userMenu).toBeVisible({ timeout: 30_000 });
}

async function openAssistantAndAiSettings(page: Page): Promise<void> {
  await page.getByRole("button", { name: /^Account menu(?:,|$)/ }).click();
  await page.getByRole("menuitem", { name: "Settings", exact: true }).click();
  await page.getByRole("button", { name: "Admin / Setup" }).click();
  await page.getByRole("button", { name: "AI providers" }).click();
}

const classifierSelect = (page: Page) => page.getByLabel("Classifier model", { exact: true });
const gateButton = (page: Page, name: string) =>
  page.getByRole("group", { name: "Gate state" }).getByRole("button", { name });

async function chooseClassifier(page: Page, label: string): Promise<void> {
  const saved = page.waitForResponse(
    (response) =>
      new URL(response.url()).pathname.endsWith("/api/ai/services/sorting/binding") &&
      response.request().method() === "PUT",
    { timeout: 30_000 }
  );
  await classifierSelect(page).selectOption({ label });
  expect((await saved).status()).toBe(200);
  await expect(classifierSelect(page)).toHaveValue(/^model:/);
}

async function setGate(page: Page, name: string): Promise<void> {
  const saved = page.waitForResponse(
    (response) =>
      new URL(response.url()).pathname.endsWith(
        "/api/admin/runtime-config/chat.classifier_gate_mode"
      ) && response.request().method() === "PUT",
    { timeout: 30_000 }
  );
  await gateButton(page, name).click();
  expect((await saved).status()).toBe(200);
  await expect(gateButton(page, name)).toHaveAttribute("aria-pressed", "true");
}

async function openChat(page: Page): Promise<Locator> {
  await page.locator(".topbar-actions button").click();
  const drawer = page.locator("aside.chatd");
  await expect(drawer).toBeVisible();
  return drawer;
}

async function sendMessage(page: Page, drawer: Locator, message: string): Promise<number> {
  const turnResponse = page.waitForResponse(
    (response) =>
      new URL(response.url()).pathname.endsWith("/api/chat/turn") &&
      response.request().method() === "POST",
    { timeout: 180_000 }
  );
  const composer = drawer.getByLabel("Message Moss");
  await composer.fill(message);
  await composer.press("Enter");
  const response = await turnResponse;
  return response.status();
}

function reviewCount(project: string): number {
  return Number(
    execUatSql(project, "select count(*)::int::text from app.chat_classifier_shadow_reviews").trim()
  );
}

/** The newest assistant message's gate stamp as kind|module|outcome. */
function newestAssistantOrigin(project: string): string {
  return execUatSql(
    project,
    "select coalesce(model_metadata->'origin'->>'kind','') || '|' || " +
      "coalesce(model_metadata->'origin'->>'moduleId','') || '|' || " +
      "coalesce(model_metadata->'origin'->>'outcome','') " +
      "from app.chat_messages where role = 'assistant' order by created_at desc, id desc limit 1"
  ).trim();
}

function newestGateReply(project: string): string {
  return execUatSql(
    project,
    "select body from app.chat_messages where role = 'assistant' and " +
      "model_metadata->'origin'->>'kind' = 'classifier_gate' order by created_at desc, id desc limit 1"
  ).trim();
}

const FIXTURE_MESSAGE = "uatfix what is on my calendar today?";
const SCRIPTED_REPLY = "You have events on your calendar today.";

test("the classifier gate turns On with no shadow review and answers a chat request (phase 0)", async ({
  page
}) => {
  test.setTimeout(300_000);
  const project = requireProject();
  await signIn(page);
  await openAssistantAndAiSettings(page);
  await chooseClassifier(page, "UAT Classifier Fixture Model");

  // Off to On, then Shadow, then On again. No review row exists at any point.
  await expect(gateButton(page, "Off")).toHaveAttribute("aria-pressed", "true");
  expect(reviewCount(project)).toBe(0);
  await setGate(page, "On");
  await setGate(page, "Shadow");
  await setGate(page, "On");
  await expect(page.getByText("On opens after shadow review.")).toHaveCount(0);

  // The saved On survives a reload.
  await page.reload();
  await openAssistantAndAiSettings(page);
  await expect(gateButton(page, "On")).toHaveAttribute("aria-pressed", "true");
  expect(reviewCount(project)).toBe(0);

  // A chat request is answered through the gate, not by the scripted main model.
  await page.goto(requireBaseURL());
  const drawer = await openChat(page);
  expect(await sendMessage(page, drawer, FIXTURE_MESSAGE)).toBe(200);
  await expect
    .poll(() => newestAssistantOrigin(project), { timeout: 30_000 })
    .toBe("classifier_gate|calendar|executed-success");
  const reply = newestGateReply(project);
  expect(reply.length).toBeGreaterThan(0);
  const firstWords = reply
    .split("\n")[0]!
    .replace(/[*_`#>]/g, "")
    .trim()
    .slice(0, 24);
  await expect(drawer).toContainText(firstWords);
  await expect(drawer.getByText(SCRIPTED_REPLY)).toHaveCount(0);
  expect(reviewCount(project)).toBe(0);
});
```

- [ ] **Step 2: Run the three UAT specs**

The harness provisions its own throwaway Compose instance and never touches the dev database. Run it in the background and wait on its exit, without piping:

```bash
pnpm test:uat classifier-gate-on.uat.spec.ts classifier-settings.uat.spec.ts shadow-report.uat.spec.ts > /tmp/phase0-uat.log 2>&1; echo "UAT_EXIT=$?" >> /tmp/phase0-uat.log
```

Then read only the end: `tail -n 60 /tmp/phase0-uat.log`

Expected: `UAT_EXIT=0`, three specs passed.

If the gate declines instead of answering, the poll shows a different stamp (usually an empty kind, because the scripted main model answered). Do not weaken the assertion and do not insert data by hand. Find the decline reason in the API log inside the UAT output (`grep -n -i -e "classifier" -e "gate" /tmp/phase0-uat.log | tail -n 40`), report it to the coordinator, and leave the PR as code-complete, unverified.

- [ ] **Step 3: Run the full gate**

Use the `verify-gate` skill. Start the gate on its own throwaway database, then wait on it in the background:

```bash
scripts/run-gate.sh start
scripts/run-gate.sh wait --follow
```

Run the second command as a single background call. Exit 0 is pass, 1 fail, 2 dead. On a failure, read only the failing file and line from the log the start command printed (`grep -n -e FAIL -e "✗" <log> | tail -n 40`). Known local-only reds that are not this branch: the `module-sdk-worker` unit tests (green in CI), and the gateway worker pattern timeout under load (#1673). Rerun a suspected flake once by file, never bisect over it. Expected: exit 0, including `tests/integration/classifier-gate-setting-routes.test.ts` and `tests/integration/chat-classifier-shadow-review.test.ts`.

- [ ] **Step 4: Commit and push**

```bash
git add tests/uat/specs/classifier-gate-on.uat.spec.ts
git commit -m "test(uat): prove the classifier gate turns on without a review and answers chat"
git push -u origin feat/classifier-gate-on-directly
```

- [ ] **Step 5: Open the pull request**

Write the body to `/tmp/phase0-pr-body.md`, using the repo's template headings:

```markdown
## Summary

Moss extensions phase 0. An admin can switch the Classifier's chat gate straight to On, from Off or
from Shadow, with no Shadow trial or review first.

- The settings save no longer refuses On when no review is recorded.
- Chat no longer treats a saved On as Shadow until a review exists.
- An On set through the server's environment settings is no longer forced to Off.
- The Settings row no longer locks the On button or shows the review note. It still locks the gate
  while no classifier is chosen and while a change is saving.
- The shadow log and the review table stay as records. No database change.
- The app map's Classifier row and gate feature no longer mention a review step.
- Only an instance admin can change the gate. A test proves a non-admin is refused, and it was seen
  failing with the admin check removed.

Spec: `docs/superpowers/specs/2026-10-11-moss-extensions-design.md`, "Phase 0".
Closes #<the phase 0 task issue number the coordinator gives in the build brief>.

## Release note

Category: Changed
Title: The Classifier's chat gate turns on straight away
Description: You can now switch the Classifier's chat gate to On in Settings straight away, with no Shadow trial or review first.
```

Then:

```bash
gh pr create --base main --head feat/classifier-gate-on-directly \
  --title "feat: classifier gate turns on without a shadow review (extensions phase 0)" \
  --body-file /tmp/phase0-pr-body.md
```

If the body later needs a change, `gh pr edit --body-file` fails in this repo. Update it with `gh api -X PATCH repos/{owner}/{repo}/pulls/<number> -F body=@/tmp/phase0-pr-body.md`.

- [ ] **Step 6: Record the live proof on the PR**

Write `/tmp/phase0-proof.md` from the real run, then post it with `gh pr comment <number> --body-file /tmp/phase0-proof.md`. It carries:

- The command from Step 2 and `UAT_EXIT=<code>`, plus the Playwright pass lines for the three specs (copied from `tail` of the log, no hostnames or ports).
- The assertions the new spec proved, each in plain English. The admin moved the gate Off to On and Shadow to On through the Settings row. On was still selected after a reload. The review table held 0 rows throughout. A chat request was answered through the gate (stamp `classifier_gate|calendar|executed-success`), its reply showed in the chat drawer, and the scripted main-model reply never appeared.
- The admin-only control from Task 1 Step 10. The non-admin test failed with the admin check commented out and passed once it was restored.
- The full gate's exit code from Step 3 and the tested commit from its log.
- Disclosed stand-ins. The classifier is the UAT fixture model and the main chat model is the scripted backend, both test-only and seeded by the harness. Nothing was intercepted or rewritten, and no data was inserted by hand.
- Why the proof ran on a throwaway instance. The gate setting covers a whole instance, so the shared dev instance was left alone.

No screenshots. Hand the PR number back to the coordinator, which runs the whole-branch review and merges.

- [ ] **Step 7: Clean up**

Delete `/tmp/phase0-uat.log`, `/tmp/phase0-pr-body.md` and `/tmp/phase0-proof.md`. Leave the worktree clean (`git status --short` prints nothing) so the sweeper can remove it after merge.

---

## Self-Review

- Spec coverage
  - Route 409 removed: Task 1 Step 4.
  - Stored On no longer downgraded: Task 2 Steps 3-5.
  - Environment On-to-Off rule removed: Task 1 Step 6.
  - Both checks removed, not relaxed: Task 1 Steps 4-5 and Task 2 Step 5 delete them, and the grep steps prove nothing is left.
  - Key description: Task 1 Step 7, pinned by the registry test.
  - Settings row lock and copy removed, both guards kept: Task 3 Step 3, pinned by the saving-lock and no-classifier tests.
  - Shadow log kept: no task touches it. The review table is kept as a record.
  - App map: Task 1 Step 8 (gate feature) and Task 3 Step 4 (Classifier row).
  - Release note: Task 4 Step 5.
  - Spec test "Off to On and Shadow to On through Settings with no review": Task 4 spec, plus the row unit tests and the updated settings UAT spec.
  - Spec test "no saved value, no review, environment on gives On": resolver test (Task 1) and reader test (Task 2).
  - Spec test "gate On with no review answers a chat request through the gate": Task 4 spec.
  - Live proof: Task 4 Steps 2 and 6.
- Every test that asserted the old review requirement is updated or deleted: route unit, resolver unit, the effective-mode unit test, the gate route integration test, the review-table integration test, the row unit test, the settings UAT spec and the shadow-report UAT spec. `tests/live/classifier-2984-r26-chat-uat.spec.ts` inserts a review row but asserts nothing about the requirement, so it stays.
- Security property: admin-only writes have a hostile unit test, an integration test and a control (Task 1 Step 10).
- Names are consistent: `createGateModeReader` and `classifier-gate-mode.ts` match across Task 2's Interfaces, test, implementation and Task 4's Consumes.
