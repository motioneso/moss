import type { AiProviderKind } from "@moss/db";

/**
 * Config contract for the dev-instance CLI (#1258). `readDevInstanceConfig`, which reads these
 * fields from the environment, is built in Phase 2 (task T9) — this type is declared here first
 * because `doctor.ts`'s `DoctorDeps` (Phase 1) already needs the shape to compile against.
 */
export interface DevInstanceConfig {
  readonly providerKind: AiProviderKind;
  readonly credentialFilePath: string;
  readonly adminEmail: string;
  readonly adminName: string;
  readonly adminPasswordFilePath: string;
  readonly cliHomeBase: string;
  readonly cliRunnerSocketPath: string;
}
