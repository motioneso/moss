import { createHash } from "node:crypto";

import type { AccessContext } from "@moss/db";
import type { VaultIngestRootProvider } from "@moss/module-sdk";
import { createVaultFile, readVaultFile, type VaultContextRunner } from "@moss/vault";

const PRIVATE_EXPORT_ROOT = "notes/generated/";
const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

function isUuid(value: string): boolean {
  return value.length === 36 && UUID.test(value);
}

/** Host adapters validate references before placing them in metadata-only queue payloads. */
export function isPrivateNoteExportReference(value: string): boolean {
  const match = /^notes\/generated\/([0-9a-f-]+)\/v([1-9][0-9]*)\.md$/.exec(value);
  if (!match || match[0] !== value) return false;
  const sourceId = match[1]!;
  const version = Number(match[2]);
  return isUuid(sourceId) && Number.isSafeInteger(version) && version <= 2_147_483_647;
}

export interface PrivateNoteExportIdentity {
  readonly sourceId: string;
  readonly version: number;
}

export type PrivateNoteIndexResult =
  | { readonly status: "queued"; readonly jobId: string }
  | { readonly status: "delayed" }
  | { readonly status: "conflict" };

/** The host binds this to the acknowledged Memory enqueue API. Never implies Indexed. */
export interface PrivateNoteIndexPort {
  enqueue(
    access: AccessContext,
    noteReference: string
  ): Promise<Exclude<PrivateNoteIndexResult, { status: "conflict" }>>;
}

export interface PrivateNoteExportObservation {
  readonly destination: "private-vault";
  readonly audience: "owner";
  readonly noteReference: string;
  readonly contentHash: string;
  readonly status: "missing" | "unchanged" | "conflict";
}

export type PrivateNoteExportWriteResult = Omit<PrivateNoteExportObservation, "status"> & {
  readonly status: "written" | "unchanged" | "conflict";
};

export interface PrivateNoteExportPort {
  inspect(
    access: AccessContext,
    identity: PrivateNoteExportIdentity,
    content: string
  ): Promise<PrivateNoteExportObservation>;
  createOrInspect(
    access: AccessContext,
    identity: PrivateNoteExportIdentity,
    content: string
  ): Promise<PrivateNoteExportWriteResult>;
  queueIndex(
    access: AccessContext,
    identity: PrivateNoteExportIdentity,
    content: string
  ): Promise<PrivateNoteIndexResult>;
}

function target(access: AccessContext, identity: PrivateNoteExportIdentity, content: string) {
  if (
    !isUuid(access.actorUserId) ||
    !isUuid(identity.sourceId) ||
    !Number.isSafeInteger(identity.version) ||
    identity.version < 1 ||
    identity.version > 2_147_483_647
  ) {
    throw new Error("Invalid private note export identity");
  }
  return {
    destination: "private-vault" as const,
    audience: "owner" as const,
    noteReference: `${PRIVATE_EXPORT_ROOT}${identity.sourceId.toLowerCase()}/v${identity.version}.md`,
    contentHash: createHash("sha256").update(content, "utf8").digest("hex")
  };
}

/**
 * Explicit versioned copies only. A retry compares complete bytes, never appends or overwrites.
 * The caller owns explicit export authorization and durable receipt persistence. Resolving the
 * actor's private root here avoids treating an arbitrary linked-folder VaultContext as private.
 * Changed content needs an explicitly selected new version; in-place update CAS is unsupported.
 */
export class PrivateNoteExportService implements PrivateNoteExportPort {
  constructor(
    private readonly vaultRunner: VaultContextRunner,
    private readonly index: PrivateNoteIndexPort
  ) {}

  async inspect(
    access: AccessContext,
    identity: PrivateNoteExportIdentity,
    content: string
  ): Promise<PrivateNoteExportObservation> {
    const destination = target(access, identity, content);
    return this.vaultRunner.withVaultContext(access, async (ctx) => {
      try {
        const observed = await readVaultFile(ctx, destination.noteReference);
        return { ...destination, status: observed === content ? "unchanged" : "conflict" };
      } catch (error) {
        if (error instanceof Error && "code" in error && error.code === "ENOENT") {
          return { ...destination, status: "missing" };
        }
        throw error;
      }
    });
  }

  async createOrInspect(
    access: AccessContext,
    identity: PrivateNoteExportIdentity,
    content: string
  ): Promise<PrivateNoteExportWriteResult> {
    const destination = target(access, identity, content);
    return this.vaultRunner.withVaultContext(access, async (ctx) => {
      const created = await createVaultFile(ctx, destination.noteReference, content);
      // Confirm the final bytes even after creation: an external editor may have changed them.
      const observed = await readVaultFile(ctx, destination.noteReference);
      return {
        ...destination,
        status: observed !== content ? "conflict" : created === "created" ? "written" : "unchanged"
      };
    });
  }

  async queueIndex(
    access: AccessContext,
    identity: PrivateNoteExportIdentity,
    content: string
  ): Promise<PrivateNoteIndexResult> {
    const observed = await this.inspect(access, identity, content);
    if (observed.status !== "unchanged") return { status: "conflict" };
    try {
      return await this.index.enqueue(access, observed.noteReference);
    } catch {
      return { status: "delayed" };
    }
  }
}

/** Private-vault worker resolves these relative roots separately for each authenticated owner. */
export const notesPrivateExportIngestProvider: VaultIngestRootProvider = {
  moduleId: "notes",
  async resolveRoots() {
    return [PRIVATE_EXPORT_ROOT];
  }
};
