import { createHash } from "node:crypto";
import { join } from "node:path";
import type { AccessContext, DataContextDb } from "@moss/db";
import { ApprovalPrerequisiteError } from "@moss/module-sdk";
import type { RecordingNoteSource } from "@moss/shared";
import {
  readBoundedVaultInventory,
  canonicalizeAsFarAsExists,
  mutateVaultFiles,
  resolveVaultPath,
  type VaultContext,
  type VaultContextRunner,
  type VaultMutationSnapshot
} from "@moss/vault";
import type {
  RecordingNoteCandidate,
  RecordingNoteDestinationChoice,
  RecordingNoteInventory
} from "@moss/shared";
import {
  NoteContributionConflictError,
  NoteContributionUnavailableError,
  type StoredNoteDestination
} from "./contribution-state.js";
import type { RecordingContributionRepository } from "./contribution-repository.js";
import { recordingFallbackReference } from "./recording-note-identity.js";
import { withNotesVault } from "./notes-vault-context.js";
import { resolveSource } from "./write-tools.js";

function digest(value: string): string {
  return createHash("sha256").update(value).digest("hex");
}
export function noteDestinationId(canonicalPath: string): string {
  return digest(`moss:managed-note-destination:v1\0${canonicalPath}`);
}
interface InventoryResolution {
  readonly public: RecordingNoteInventory;
  readonly root: string | null;
}
interface ResolvedDestination {
  readonly destination: StoredNoteDestination;
  readonly ctx: VaultContext;
  readonly canonicalPath: string;
}
export interface ContributionDestinationSnapshot {
  readonly destination: StoredNoteDestination;
  readonly file: VaultMutationSnapshot;
}

export class ContributionDestinations {
  constructor(
    private readonly privateVault: VaultContextRunner,
    private readonly repository: RecordingContributionRepository
  ) {}

  async inventory(db: DataContextDb, access: AccessContext): Promise<InventoryResolution> {
    let root: string;
    try {
      root = await resolveSource(db);
    } catch (error) {
      if (!(error instanceof ApprovalPrerequisiteError)) throw error;
      return { public: { status: "unavailable", candidates: [] }, root: null };
    }
    return withNotesVault(db, root, async (ctx) => {
      const inventory = await readBoundedVaultInventory(ctx, {
        canReadMarkdown: (canonicalPath) =>
          this.repository.available(db, noteDestinationId(canonicalPath))
      });
      const candidates: RecordingNoteCandidate[] = [];
      let status = inventory.status;
      let limit: RecordingNoteInventory["limit"] =
        inventory.status === "overflow" ? inventory.limit : undefined;
      for (const entry of inventory.entries) {
        const canonicalPath = await canonicalizeAsFarAsExists(
          resolveVaultPath(ctx.vaultRoot, entry.path)
        );
        const destinationId = noteDestinationId(canonicalPath);
        // Recheck before serialization. No foreign binding, path or preview enters the response.
        if (entry.kind === "markdown" && !(await this.repository.available(db, destinationId)))
          continue;
        const binding =
          entry.kind === "markdown" ? await this.repository.binding(db, destinationId) : null;
        const id = digest(
          JSON.stringify([
            "moss:note-candidate:v1",
            access.actorUserId.toLowerCase(),
            root,
            entry.path,
            entry.kind
          ])
        );
        const candidate: RecordingNoteCandidate = {
          id,
          revision: digest(
            JSON.stringify([id, entry.excerpt, binding?.revision ?? 0, binding?.side ?? null])
          ),
          displayPath: entry.path,
          kind: entry.kind,
          excerpt: entry.excerpt,
          binding: binding?.side ?? "unbound"
        };
        // IDs and binding metadata also count against the public response limit.
        if (
          Buffer.byteLength(
            JSON.stringify({
              status: "overflow",
              limit: "serialized_bytes",
              candidates: [...candidates, candidate]
            }),
            "utf8"
          ) >
          256 * 1024
        ) {
          status = "overflow";
          limit = "serialized_bytes";
          break;
        }
        candidates.push(candidate);
      }
      return { public: { candidates, status, ...(limit ? { limit } : {}) }, root };
    });
  }

  async choose(
    db: DataContextDb,
    access: AccessContext,
    source: RecordingNoteSource,
    side: "personal" | "work",
    choice: RecordingNoteDestinationChoice
  ): Promise<StoredNoteDestination> {
    if (choice.kind === "fallback") {
      const path = recordingFallbackReference(source, side);
      return this.privateVault.withVaultContext(access, async (ctx) => ({
        kind: "private",
        root: null,
        path,
        id: noteDestinationId(
          await canonicalizeAsFarAsExists(resolveVaultPath(ctx.vaultRoot, path))
        )
      }));
    }
    if (
      choice.kind !== "candidate" ||
      !/^[a-f0-9]{64}$/.test(choice.candidateId) ||
      !/^[a-f0-9]{64}$/.test(choice.candidateRevision)
    ) {
      throw new NoteContributionUnavailableError();
    }
    const resolved = await this.inventory(db, access);
    const candidate = resolved.public.candidates.find(({ id }) => id === choice.candidateId);
    if (!candidate || !resolved.root) throw new NoteContributionUnavailableError();
    if (candidate.revision !== choice.candidateRevision) throw new NoteContributionConflictError();
    const path =
      candidate.kind === "markdown"
        ? candidate.displayPath
        : join(
            candidate.displayPath,
            `${source.sourceId.toLowerCase()}-v${source.sourceVersion}.md`
          );
    if (Buffer.byteLength(path, "utf8") > 512) throw new NoteContributionUnavailableError();
    return withNotesVault(db, resolved.root, async (ctx) => ({
      kind: "linked",
      root: resolved.root,
      path,
      id: noteDestinationId(await canonicalizeAsFarAsExists(resolveVaultPath(ctx.vaultRoot, path)))
    }));
  }

  async assertCurrentTarget(db: DataContextDb, destination: StoredNoteDestination): Promise<void> {
    if (destination.kind === "linked" && (await resolveSource(db)) !== destination.root)
      throw new NoteContributionConflictError();
  }

  async withDestination<T>(
    db: DataContextDb,
    access: AccessContext,
    destination: StoredNoteDestination,
    work: (ctx: VaultContext) => Promise<T>
  ): Promise<T> {
    const checked = async (ctx: VaultContext) => {
      const canonical = await canonicalizeAsFarAsExists(
        resolveVaultPath(ctx.vaultRoot, destination.path)
      );
      if (noteDestinationId(canonical) !== destination.id)
        throw new NoteContributionConflictError();
      return work(ctx);
    };
    if (destination.kind === "private" && destination.root === null) {
      return this.privateVault.withVaultContext(access, checked);
    }
    if (destination.kind === "linked" && destination.root !== null) {
      return withNotesVault(db, destination.root, checked);
    }
    throw new NoteContributionUnavailableError();
  }

  /** Acquires all canonical pathname locks in Vault's order; never uses hash order across roots. */
  async withSnapshots<T>(
    db: DataContextDb,
    access: AccessContext,
    destinations: readonly StoredNoteDestination[],
    work: (snapshots: readonly ContributionDestinationSnapshot[]) => Promise<T>
  ): Promise<T> {
    const unique = [...new Map(destinations.map((entry) => [entry.id, entry])).values()];
    const scoped: ResolvedDestination[] = [];
    const open = async (index: number): Promise<T> => {
      const destination = unique[index];
      if (!destination) {
        scoped.sort((a, b) =>
          a.canonicalPath < b.canonicalPath ? -1 : a.canonicalPath > b.canonicalPath ? 1 : 0
        );
        const snapshots: ContributionDestinationSnapshot[] = [];
        const lock = async (offset: number): Promise<T> => {
          const entry = scoped[offset];
          if (!entry) return work(snapshots);
          return mutateVaultFiles(db, entry.ctx, [entry.destination.path], async ([file]) => {
            if (!file || noteDestinationId(file.canonicalPath) !== entry.destination.id)
              throw new NoteContributionConflictError();
            snapshots.push({ destination: entry.destination, file });
            return { changes: [], result: await lock(offset + 1) };
          });
        };
        return lock(0);
      }
      return this.withDestination(db, access, destination, async (ctx) => {
        scoped.push({
          destination,
          ctx,
          canonicalPath: await canonicalizeAsFarAsExists(
            resolveVaultPath(ctx.vaultRoot, destination.path)
          )
        });
        return open(index + 1);
      });
    };
    return open(0);
  }
}
