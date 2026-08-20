/**
 * dev-instance CLI entry point (#1258, Phase 4, T19).
 *
 * Order is fixed and load-bearing: parse the command, then `assertDevEnvParity`, then resolve the
 * database URLs, then `assertTargetIsDevInstance`, then open any database handle, then dispatch.
 * Both guards run before any handle opens — a set `NODE_ENV` changes which keyring
 * `packages/db/src/keyring.ts` resolves, so a credential written under the wrong key fails later
 * with an opaque authentication-tag error, and a wrong connection target must never be touched at
 * all. `process.exit` is called only in the self-invoke guard at the bottom of this file — every
 * other path returns a plain exit code so it stays testable.
 */
import { dirname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";

import { AiAutoRegisterService, AiRepository, createAiSecretCipher } from "@moss/ai";
import { createDatabase, DataContextRunner, getMossDatabaseUrls } from "@moss/db";
import { getBuiltInSqlMigrationDirectories } from "@moss/module-registry";

import { assertDevEnvParity, assertTargetIsDevInstance } from "./dev-instance/guard.js";
import { readDevInstanceConfig } from "./dev-instance/config.js";
import { readSecretFile, withDecryptedSecret } from "./dev-instance/secrets.js";
import { formatDoctorReport, runDoctor, type DoctorDeps } from "./dev-instance/doctor.js";
import { runFix } from "./dev-instance/fix.js";
import { runProvision, type ProvisionDeps } from "./dev-instance/provision.js";
import { signUpBootstrapOwner } from "./dev-instance/signup.js";
import { ensureCliRunnerRunning } from "./dev-instance/cli-runner.js";
import { persistCliRunnerToken, tokenProviderFor } from "./dev-instance/cli-token.js";

export type DevInstanceCommand = "doctor" | "provision" | "fix" | "providers" | "reset";

const COMMANDS: readonly DevInstanceCommand[] = ["doctor", "provision", "fix", "providers", "reset"];

const root = resolve(dirname(fileURLToPath(import.meta.url)), "..");

function parseCommand(argv: readonly string[]): DevInstanceCommand | null {
  const candidate = argv[0];
  return (COMMANDS as readonly string[]).includes(candidate ?? "")
    ? (candidate as DevInstanceCommand)
    : null;
}

export async function runDevInstanceCli(
  argv: readonly string[],
  env: NodeJS.ProcessEnv
): Promise<number> {
  const command = parseCommand(argv);
  if (!command) {
    console.error(`usage: dev-instance <${COMMANDS.join("|")}>`);
    return 1;
  }

  try {
    assertDevEnvParity(env);
  } catch (error) {
    console.error((error as Error).message);
    return 1;
  }

  const urls = getMossDatabaseUrls(env);

  try {
    assertTargetIsDevInstance(urls.app);
  } catch (error) {
    console.error((error as Error).message);
    return 1;
  }

  const config = readDevInstanceConfig(env);
  const migrationDirectories = [
    join(root, "infra/postgres/migrations"),
    ...getBuiltInSqlMigrationDirectories()
  ];

  const migrationDb = createDatabase({ connectionString: urls.migration, maxConnections: 1 });
  const appDb = createDatabase({ connectionString: urls.app, maxConnections: 1 });
  const runner = new DataContextRunner(appDb);
  const cipher = createAiSecretCipher(env);
  const repository = new AiRepository();
  const autoRegister = new AiAutoRegisterService({ repository, cipher });

  try {
    const doctorDeps: DoctorDeps = {
      migrationDb,
      runner,
      cipher,
      config,
      migrationDirectories,
      env
    };

    switch (command) {
      case "doctor": {
        const report = await runDoctor(doctorDeps);
        console.log(formatDoctorReport(report));
        return report.ok ? 0 : 1;
      }

      case "provision": {
        const provisionDeps: ProvisionDeps = {
          migrationDb,
          runner,
          autoRegister,
          config,
          signUpOwner: signUpBootstrapOwner,
          readAdminPassword: () => readSecretFile(config.adminPasswordFilePath),
          ensureCliRunner: () => ensureCliRunnerRunning(config, env),
          persistCliToken: async () => {
            if (!tokenProviderFor(config.providerKind)) return false;
            return withDecryptedSecret(config.credentialFilePath, (secret) =>
              persistCliRunnerToken(config, secret)
            );
          },
          log: (line) => console.log(line)
        };
        const outcomes = await runProvision(provisionDeps);
        for (const outcome of outcomes) {
          console.log(`${outcome.id}: ${outcome.changed ? "changed" : "unchanged"} — ${outcome.detail}`);
        }
        return 0;
      }

      case "fix": {
        const report = await runDoctor(doctorDeps);
        const outcomes = await runFix(doctorDeps, report);
        for (const outcome of outcomes) {
          console.log(`${outcome.id}: ${outcome.changed ? "changed" : "unchanged"} — ${outcome.detail}`);
        }
        return 0;
      }

      case "providers":
      case "reset":
        console.error(`the "${command}" command is deferred to a later phase — not implemented yet`);
        return 1;
    }
  } finally {
    await Promise.allSettled([migrationDb.destroy(), appDb.destroy()]);
  }
}

const isMainModule = process.argv[1] === fileURLToPath(import.meta.url);
if (isMainModule) {
  runDevInstanceCli(process.argv.slice(2), process.env).then((exitCode) => {
    process.exit(exitCode);
  });
}
