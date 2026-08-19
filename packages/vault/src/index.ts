export { VaultPathError, resolveVaultPath } from "./vault-path.js";
export {
  VaultContextError,
  assertVaultContext,
  VaultContextRunner,
  vaultContextBrand
} from "./vault-context.js";
export type { VaultContext } from "./vault-context.js";
export { getVaultBaseDir } from "./vault-config.js";
export {
  deleteUserVaultDir,
  deleteVaultDir,
  deleteVaultFile,
  listVaultFiles,
  listVaultDirectories,
  listVaultFilesRecursive,
  listVaultOwnerIds,
  makeVaultDir,
  readVaultFile,
  readVaultFileBytes,
  vaultFileExists,
  writeVaultFile,
  writeVaultFileBytes
} from "./vault-ops.js";
export type { VaultDirectoryEntry } from "./vault-ops.js";
