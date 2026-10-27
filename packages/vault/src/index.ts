export { VaultPathError, resolveVaultPath } from "./vault-path.js";
export {
  VaultContextError,
  assertVaultContext,
  VaultContextRunner,
  vaultContextBrand
} from "./vault-context.js";
export type { VaultContext } from "./vault-context.js";
export { getVaultBaseDir } from "./vault-config.js";
export { grantVaultNativeReadAccess } from "./native-read-access.js";
export {
  createVaultFile,
  createVaultFileBytes,
  deleteUserVaultDir,
  deleteVaultDir,
  deleteVaultFile,
  listVaultFiles,
  listVaultDirectories,
  listVaultFilesRecursive,
  listVaultOwnerIds,
  getVaultAvailableBytes,
  makeVaultDir,
  readVaultFile,
  readVaultFileBytes,
  readVaultFileRange,
  VAULT_READ_RANGE_LIMIT,
  vaultFileExists,
  writeVaultFile,
  writeVaultFileBytes
} from "./vault-ops.js";
export type { VaultDirectoryEntry } from "./vault-ops.js";
export { reserveVaultFileBytes, publishReservedVaultFileBytes } from "./vault-reserved-files.js";
export { appendVaultFileBytes } from "./vault-append.js";
