import { readScopedActorUserId, type DataContextDb } from "@moss/db";
import { HttpError } from "@moss/module-sdk";
import { resolveNotesRoots } from "@moss/settings";
import {
  getVaultBaseDir,
  VaultContextRunner,
  VaultMutationConflictError,
  VaultPathError,
  type VaultContext
} from "@moss/vault";

/** The source has already passed resolveSource; mint a real scoped linked-root capability. */
export async function withNotesVault<T>(
  db: DataContextDb,
  root: string,
  work: (ctx: VaultContext) => Promise<T>
): Promise<T> {
  const actorUserId = await readScopedActorUserId(db);
  if (!actorUserId) throw new Error("Notes file access requires a scoped actor");
  try {
    return await new VaultContextRunner(getVaultBaseDir()).withVaultContextAt(
      { actorUserId },
      root,
      resolveNotesRoots(),
      work
    );
  } catch (error) {
    if (error instanceof VaultPathError) {
      throw new HttpError(400, "path is not within the linked notes source");
    }
    if (error instanceof VaultMutationConflictError) {
      throw new HttpError(409, error.message);
    }
    throw error;
  }
}
