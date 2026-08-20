import type { Kysely } from "kysely";

import type { AiAutoRegisterPort } from "@moss/ai";
import { AiRepository } from "@moss/ai";
import type { AccessContext, DataContextRunner, MossDatabase } from "@moss/db";

import type { DevInstanceConfig } from "./config.js";
import { resolveActiveAdminUserId } from "./doctor.js";
import type { OwnerSignUpInput } from "./signup.js";

export type ProvisionStepId = "admin-account" | "provider-rows" | "cli-runner" | "cli-token";

export interface ProvisionStepOutcome {
  readonly id: ProvisionStepId;
  readonly changed: boolean;
  readonly detail: string;
}

/**
 * Status of the dev cli-runner socket. Declared here (rather than in `cli-runner.ts`, which owns
 * `probeCliRunner`/`ensureCliRunnerRunning`) because `ProvisionDeps` needs the shape before that
 * file exists; `cli-runner.ts` imports it from here.
 */
export interface CliRunnerStatus {
  readonly reachable: boolean;
  readonly socketPath: string;
  readonly detail: string;
}

export interface ProvisionDeps {
  readonly migrationDb: Kysely<MossDatabase>;
  readonly runner: DataContextRunner;
  readonly autoRegister: AiAutoRegisterPort;
  readonly config: DevInstanceConfig;
  readonly signUpOwner: (input: OwnerSignUpInput) => Promise<{ userId: string }>;
  readonly readAdminPassword: () => Promise<string>;
  readonly ensureCliRunner: () => Promise<CliRunnerStatus>;
  readonly persistCliToken: () => Promise<boolean>;
  readonly log: (line: string) => void;
}

const repository = new AiRepository();

function provisionContext(adminUserId: string, step: ProvisionStepId): AccessContext {
  return { actorUserId: adminUserId, requestId: `dev-instance:provision:${step}` };
}

async function ensureAdminAccountStep(
  deps: ProvisionDeps
): Promise<{ outcome: ProvisionStepOutcome; adminUserId: string }> {
  const existing = await resolveActiveAdminUserId(deps.migrationDb);
  if (existing) {
    return {
      adminUserId: existing,
      outcome: {
        id: "admin-account",
        changed: false,
        detail: `active instance admin already exists (${existing})`
      }
    };
  }

  const password = await deps.readAdminPassword();
  const { userId } = await deps.signUpOwner({
    email: deps.config.adminEmail,
    password,
    name: deps.config.adminName
  });
  deps.log(`created bootstrap owner account for ${deps.config.adminEmail}`);

  return {
    adminUserId: userId,
    outcome: { id: "admin-account", changed: true, detail: `created bootstrap owner ${userId}` }
  };
}

async function readProviderRowsSnapshot(
  deps: ProvisionDeps,
  context: AccessContext
): Promise<{ readonly providerId: string | null; readonly hasChatModel: boolean }> {
  return deps.runner.withDataContext(context, async (scopedDb) => {
    const providerId = await repository.resolveDefaultProviderId(scopedDb);
    const model = await repository.selectChatModelForUser(scopedDb);
    return { providerId, hasChatModel: model !== null };
  });
}

async function ensureProviderRowsStep(
  deps: ProvisionDeps,
  adminUserId: string
): Promise<ProvisionStepOutcome> {
  const context = provisionContext(adminUserId, "provider-rows");
  const before = await readProviderRowsSnapshot(deps, context);

  await deps.runner.withDataContext(context, (scopedDb) =>
    deps.autoRegister.ensureDefaultChatModel(scopedDb, deps.config.providerKind)
  );

  const after = await readProviderRowsSnapshot(deps, context);
  const changed =
    before.providerId !== after.providerId || before.hasChatModel !== after.hasChatModel;

  deps.log(
    changed
      ? `registered default ${deps.config.providerKind} provider and chat model`
      : "default provider and chat model already present"
  );

  return {
    id: "provider-rows",
    changed,
    detail: changed
      ? `registered default ${deps.config.providerKind} provider/model`
      : "provider and model rows already present"
  };
}

async function ensureCliRunnerStep(deps: ProvisionDeps): Promise<ProvisionStepOutcome> {
  const status = await deps.ensureCliRunner();
  deps.log(`cli-runner: ${status.detail}`);
  return { id: "cli-runner", changed: false, detail: status.detail };
}

async function ensureCliTokenStep(deps: ProvisionDeps): Promise<ProvisionStepOutcome> {
  const changed = await deps.persistCliToken();
  const detail = changed ? "cli token persisted" : "cli token already up to date";
  deps.log(`cli-token: ${detail}`);
  return { id: "cli-token", changed, detail };
}

export async function runProvision(deps: ProvisionDeps): Promise<readonly ProvisionStepOutcome[]> {
  const { outcome: adminAccountOutcome, adminUserId } = await ensureAdminAccountStep(deps);
  const providerRowsOutcome = await ensureProviderRowsStep(deps, adminUserId);
  const cliRunnerOutcome = await ensureCliRunnerStep(deps);
  const cliTokenOutcome = await ensureCliTokenStep(deps);

  return [adminAccountOutcome, providerRowsOutcome, cliRunnerOutcome, cliTokenOutcome];
}
