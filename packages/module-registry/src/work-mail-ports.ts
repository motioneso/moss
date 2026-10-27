import { basename, isAbsolute, relative, sep } from "node:path";

import { type GenerateStructuredDeps } from "@moss/ai";
import { createWorkMailJudge, isPrivateWorkMailNote, type WorkMailPorts } from "@moss/connectors";
import type { AccessContext, DataContextDb } from "@moss/db";
import { ChatMemoryFactsRepository, type MemoryRetriever } from "@moss/memory";
import { PeopleRepository, PersonContextService } from "@moss/people";
import { resolveNotesRoots } from "@moss/settings";
import { PreferencesRepository } from "@moss/structured-state";
import {
  appendVaultFileBytes,
  readVaultFileBytes,
  type VaultContext,
  type VaultContextRunner
} from "@moss/vault";

export interface WorkMailAdapterDependencies {
  readonly vault: VaultContextRunner;
  readonly retrieval: Pick<MemoryRetriever, "retrieve">;
  readonly ai: GenerateStructuredDeps;
  readonly allowedRoots?: readonly string[];
  readonly now?: () => Date;
}

function missing(error: unknown): boolean {
  return error instanceof Error && "code" in error && error.code === "ENOENT";
}

/** Composition only: no collector, worker or route is enabled by slice 1. */
export function createWorkMailPorts(deps: WorkMailAdapterDependencies): WorkMailPorts {
  const preferences = new PreferencesRepository();
  const facts = new ChatMemoryFactsRepository();
  const people = new PersonContextService(new PeopleRepository());
  async function withNotes<T>(
    db: DataContextDb,
    access: AccessContext,
    work: (ctx: VaultContext) => Promise<T>
  ): Promise<T> {
    const root = await preferences.get(db, "notes-source-path");
    if (root !== null && root !== undefined && root !== "") {
      if (typeof root !== "string") throw new Error("vault-unavailable");
      return deps.vault.withVaultContextAt(
        access,
        root,
        deps.allowedRoots ?? resolveNotesRoots(),
        work
      );
    }
    return deps.vault.withVaultContext(access, work);
  }
  return {
    preferences: {
      list: async (db, owner) =>
        (await facts.listActiveFacts(db, owner))
          .filter((fact) => fact.category === "preference")
          .slice(0, 12)
          .map((fact) => fact.content.slice(0, 500))
    },
    people: {
      senderContext: async (db, owner, sender) => {
        const person = await people.resolve(db, owner, sender);
        if (!person || person.status !== "active") return null;
        return [person.displayName, person.relationshipSummary, person.contextSummary]
          .filter(Boolean)
          .join("\n")
          .slice(0, 2_000);
      }
    },
    notes: {
      candidates: async (db, access, query, limit) => {
        try {
          const chunks = await deps.retrieval.retrieve(db, query, Math.min(limit, 5), "vault");
          return await withNotes(db, access, async (ctx) => {
            const candidates = [];
            const seen = new Set<string>();
            for (const chunk of chunks) {
              const path = isAbsolute(chunk.sourcePath)
                ? relative(ctx.vaultRoot, chunk.sourcePath)
                : chunk.sourcePath;
              if (
                !path ||
                path === ".." ||
                path.startsWith(`..${sep}`) ||
                isAbsolute(path) ||
                !path.endsWith(".md") ||
                seen.has(path)
              )
                continue;
              seen.add(path);
              // Inspect the current whole note, not an indexed excerpt that can be stale.
              const content = (await readVaultFileBytes(ctx, path)).toString("utf8");
              if (isPrivateWorkMailNote(content)) continue;
              candidates.push({
                index: candidates.length,
                path,
                title: basename(path, ".md"),
                excerpt: content.slice(0, 1_000)
              });
            }
            return candidates;
          });
        } catch {
          return [];
        }
      },
      append: async (db, access, destination, entry) => {
        try {
          return await withNotes(db, access, async (ctx) => {
            const path = destination === "default" ? "Work mail notes.md" : destination;
            if (!path.endsWith(".md") || isAbsolute(path)) return "unavailable";
            let original: Buffer | null;
            try {
              original = await readVaultFileBytes(ctx, path);
            } catch (error) {
              if (!missing(error) || destination !== "default") throw error;
              original = null;
            }
            const content = original?.toString("utf8") ?? "";
            if (isPrivateWorkMailNote(content)) return "private";
            const receipt = /<!-- work-mail:[a-f0-9]{64} -->/.exec(entry)?.[0];
            if (receipt && content.includes(receipt)) return "written";
            return appendVaultFileBytes(ctx, path, original, Buffer.from(entry));
          });
        } catch {
          return "unavailable";
        }
      }
    },
    judge: createWorkMailJudge(deps.ai),
    now: deps.now ?? (() => new Date())
  };
}
