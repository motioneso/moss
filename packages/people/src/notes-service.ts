import { createHash, randomUUID } from "node:crypto";
import { isAbsolute, resolve, sep } from "node:path";

import type { PgBoss } from "pg-boss";

import type { DataContextDb } from "@moss/db";
import { scheduleVaultIngestNudge } from "@moss/memory";
import { NOTES_SOURCE_PREFERENCE_KEY } from "@moss/settings";
import { PreferencesRepository } from "@moss/structured-state";
import {
  listVaultFilesRecursive,
  readVaultFile,
  VaultPathError,
  vaultFileExists,
  writeVaultFile,
  type VaultContext
} from "@moss/vault";

import { normalizeIdentity } from "./matching.js";
import { formatPeopleNote, parsePeopleNote, replaceMossManagedSection } from "./notes-format.js";
import { PeopleRepository } from "./repository.js";
import type {
  PeopleNotesRefreshResult,
  PeopleNotesSettings,
  Person,
  PersonStatus
} from "./types.js";

export const PEOPLE_NOTES_FOLDER_PREFERENCE_KEY = "people-notes-folder";

export class CanonicalNoteNotFoundError extends Error {
  constructor(personId: string) {
    super(`Canonical People note not found for person ${personId}`);
    this.name = "CanonicalNoteNotFoundError";
  }
}

export class PeopleNotesFolderUnavailableError extends Error {
  constructor() {
    super("People notes folder is unavailable");
    this.name = "PeopleNotesFolderUnavailableError";
  }
}

function translateVaultOperationError(error: unknown): never {
  const fsError = error as NodeJS.ErrnoException;
  if (
    error instanceof VaultPathError ||
    (typeof fsError?.code === "string" &&
      (typeof fsError.path === "string" || typeof fsError.syscall === "string"))
  ) {
    throw new PeopleNotesFolderUnavailableError();
  }
  throw error;
}

export interface PeopleNotesServiceDeps {
  readonly preferencesRepository?: PreferencesRepository;
  readonly peopleRepository?: PeopleRepository;
  readonly boss?: PgBoss;
}

export interface CreatePersonNoteInput {
  readonly displayName: string;
  readonly aliases?: readonly string[];
  readonly emails?: readonly string[];
  readonly phones?: readonly string[];
}

export interface UpdatePersonNoteInput {
  readonly displayName?: string;
  readonly aliases?: readonly string[];
  readonly emails?: readonly string[];
  readonly phones?: readonly string[];
  readonly status?: Exclude<PersonStatus, "merged">;
  readonly relationshipSummary?: string | null;
  readonly contextSummary?: string | null;
}

export interface PeopleNoteWriteResult {
  readonly person: Person;
  readonly notePath: string;
}

interface LoadedPeopleNote {
  readonly path: string;
  readonly content: string;
  readonly parsed: NonNullable<ReturnType<typeof parsePeopleNote>>;
}

function hash(value: string): string {
  return createHash("sha256").update(value).digest("hex").slice(0, 32);
}

/**
 * #2268 — the People folder is now chosen with the same picker as the notes source, so a saved
 * value is an absolute path inside an allowed notes root. Values written before #2268 were
 * relative to the private per-user vault; those are still readable (see resolveFolder) but can
 * no longer be saved, so a re-save always moves the user onto the new shape.
 */
function normalizeFolder(folder: string | null): string | null {
  // Store exactly what the caller validated, the way the notes source save does (#449): the
  // route has already opened this path through the guarded folder access, so trimming or
  // rewriting it here would persist a different folder from the one that was checked.
  if (folder === null) return null;
  if (!isAbsolute(folder) || folder.split(/[\\/]/).includes("..")) {
    throw new PeopleNotesFolderUnavailableError();
  }
  return folder;
}

/** Inside a context rooted at the People folder, every note path is relative to that folder. */
const PEOPLE_ROOT = ".";

function slugName(displayName: string): string {
  const slug = displayName
    .trim()
    .replace(/[^A-Za-z0-9]+/g, "-")
    .replace(/^-+|-+$/g, "");
  return slug || "Person";
}

function managedSummary(input: {
  readonly displayName: string;
  readonly emails: readonly string[];
  readonly phones: readonly string[];
}): string {
  const lines = [`Display name: ${input.displayName}`];
  if (input.emails.length > 0) lines.push(`Emails: ${input.emails.join(", ")}`);
  if (input.phones.length > 0) lines.push(`Phones: ${input.phones.join(", ")}`);
  return lines.join("\n");
}

export class PeopleNotesService {
  private readonly preferencesRepository: PreferencesRepository;
  private readonly peopleRepository: PeopleRepository;
  private readonly boss?: PgBoss;

  constructor(deps: PeopleNotesServiceDeps = {}) {
    this.preferencesRepository = deps.preferencesRepository ?? new PreferencesRepository();
    this.peopleRepository = deps.peopleRepository ?? new PeopleRepository();
    this.boss = deps.boss;
  }

  async getSettings(scopedDb: DataContextDb, _ownerUserId: string): Promise<PeopleNotesSettings> {
    const stored = await this.preferencesRepository.get(
      scopedDb,
      PEOPLE_NOTES_FOLDER_PREFERENCE_KEY
    );
    return { folder: typeof stored === "string" && stored.length > 0 ? stored : null };
  }

  /**
   * #2268 — turns the stored preference into the absolute folder the caller should root a vault
   * context at, or null when there is nothing usable to open.
   *
   * An absolute value is used as-is; the containment check belongs to withVaultContextAt, which
   * re-validates against the allowed notes roots on every open, so this never grants reach.
   * A value written before #2268 is relative to the private per-user vault. Rather than guess, it
   * is resolved against the current notes source, and refused if it climbs out of it. This does
   * only path arithmetic and never touches the disk: whether the folder actually exists is
   * decided by withVaultContextAt, so the allowed-root guard always runs before any file access.
   * When that open fails, the People pane shows its existing "choose another folder" state.
   */
  async resolveFolder(scopedDb: DataContextDb): Promise<string | null> {
    const stored = await this.preferencesRepository.get(
      scopedDb,
      PEOPLE_NOTES_FOLDER_PREFERENCE_KEY
    );
    if (typeof stored !== "string" || stored.length === 0) return null;
    if (isAbsolute(stored)) return stored;
    if (stored.split(/[\\/]/).includes("..")) return null;

    const notesSource = await this.preferencesRepository.get(scopedDb, NOTES_SOURCE_PREFERENCE_KEY);
    if (typeof notesSource !== "string" || !isAbsolute(notesSource)) return null;

    const candidate = resolve(notesSource, stored);
    if (candidate !== notesSource && !candidate.startsWith(notesSource + sep)) return null;
    return candidate;
  }

  async putSettings(
    scopedDb: DataContextDb,
    _ownerUserId: string,
    settings: PeopleNotesSettings
  ): Promise<PeopleNotesSettings> {
    const folder = normalizeFolder(settings.folder);
    await this.preferencesRepository.upsert(scopedDb, PEOPLE_NOTES_FOLDER_PREFERENCE_KEY, folder);
    return { folder };
  }

  async refreshFromFolder(
    scopedDb: DataContextDb,
    vaultCtx: VaultContext,
    ownerUserId: string
  ): Promise<PeopleNotesRefreshResult> {
    const loaded = await this.loadPeopleNotes(vaultCtx);
    const notes = loaded.notes;
    const byPersonId = new Map<string, LoadedPeopleNote[]>();
    let candidates = 0;
    for (const note of notes) {
      const personId = note.parsed.frontmatter.jarvisPersonId;
      if (!personId) {
        await this.createReviewCandidate(
          scopedDb,
          ownerUserId,
          "People note missing jarvisPersonId",
          [note.path]
        );
        candidates += 1;
        continue;
      }
      byPersonId.set(personId, [...(byPersonId.get(personId) ?? []), note]);
    }

    let projected = 0;
    for (const [personId, matches] of byPersonId) {
      if (matches.length !== 1) {
        await this.createReviewCandidate(
          scopedDb,
          ownerUserId,
          "Duplicate canonical People notes",
          [personId, ...matches.map((match) => match.path)]
        );
        candidates += 1;
        continue;
      }
      await this.projectNote(scopedDb, ownerUserId, matches[0]!);
      projected += 1;
    }

    candidates += await this.createMissingCanonicalNoteCandidates(
      scopedDb,
      ownerUserId,
      new Set(byPersonId.keys())
    );

    return { discovered: loaded.discovered, projected, ignored: loaded.ignored, candidates };
  }

  async createPersonNote(
    scopedDb: DataContextDb,
    vaultCtx: VaultContext,
    ownerUserId: string,
    input: CreatePersonNoteInput
  ): Promise<PeopleNoteWriteResult> {
    const personId = randomUUID();
    const notePath = await this.nextNotePath(vaultCtx, input.displayName, personId);
    const body = replaceMossManagedSection(
      `# ${input.displayName}\n`,
      managedSummary({
        displayName: input.displayName,
        emails: input.emails ?? [],
        phones: input.phones ?? []
      })
    );

    const content = formatPeopleNote({
      frontmatter: {
        jarvisPersonId: personId,
        displayName: input.displayName,
        aliases: input.aliases ?? [],
        emails: input.emails ?? [],
        phones: input.phones ?? [],
        status: "active"
      },
      body
    });
    await writeVaultFile(vaultCtx, notePath, content);
    if (this.boss) {
      await scheduleVaultIngestNudge(this.boss, {
        actorUserId: ownerUserId,
        sourcePath: notePath,
        op: "upsert"
      });
    }
    const person = await this.projectNote(scopedDb, ownerUserId, {
      path: notePath,
      content,
      parsed: parsePeopleNote(content)!
    });
    return { person, notePath };
  }

  async updatePersonNote(
    scopedDb: DataContextDb,
    vaultCtx: VaultContext,
    ownerUserId: string,
    personId: string,
    patch: UpdatePersonNoteInput
  ): Promise<PeopleNoteWriteResult> {
    const note = await this.findCanonicalNote(vaultCtx, personId);
    const frontmatter = {
      ...note.parsed.frontmatter,
      jarvisPersonId: personId,
      displayName: patch.displayName ?? note.parsed.frontmatter.displayName,
      aliases: patch.aliases ?? note.parsed.frontmatter.aliases,
      emails: patch.emails ?? note.parsed.frontmatter.emails,
      phones: patch.phones ?? note.parsed.frontmatter.phones,
      status: patch.status ?? note.parsed.frontmatter.status
    };
    const body = replaceMossManagedSection(
      note.parsed.body,
      managedSummary({
        displayName: frontmatter.displayName,
        emails: frontmatter.emails,
        phones: frontmatter.phones
      })
    );
    const content = formatPeopleNote({ frontmatter, body });

    await writeVaultFile(vaultCtx, note.path, content);
    if (this.boss) {
      await scheduleVaultIngestNudge(this.boss, {
        actorUserId: ownerUserId,
        sourcePath: note.path,
        op: "upsert"
      });
    }
    const person = await this.projectNote(scopedDb, ownerUserId, {
      path: note.path,
      content,
      parsed: parsePeopleNote(content)!
    });
    return { person, notePath: note.path };
  }

  async archivePersonNote(
    scopedDb: DataContextDb,
    vaultCtx: VaultContext,
    ownerUserId: string,
    personId: string
  ): Promise<PeopleNoteWriteResult> {
    return this.updatePersonNote(scopedDb, vaultCtx, ownerUserId, personId, { status: "archived" });
  }

  private async loadPeopleNotes(
    vaultCtx: VaultContext
  ): Promise<{ notes: LoadedPeopleNote[]; discovered: number; ignored: number }> {
    let allPaths: string[];
    try {
      allPaths = await listVaultFilesRecursive(vaultCtx, PEOPLE_ROOT);
    } catch (error) {
      translateVaultOperationError(error);
    }
    const paths = allPaths.filter((path) => path.endsWith(".md"));
    const notes: LoadedPeopleNote[] = [];
    let ignored = 0;
    for (const path of paths) {
      let content: string;
      try {
        content = await readVaultFile(vaultCtx, path);
      } catch (error) {
        translateVaultOperationError(error);
      }
      const parsed = parsePeopleNote(content);
      if (parsed) notes.push({ path, content, parsed });
      else ignored += 1;
    }
    return { notes, discovered: paths.length, ignored };
  }

  private async findCanonicalNote(
    vaultCtx: VaultContext,
    personId: string
  ): Promise<LoadedPeopleNote> {
    const matches = (await this.loadPeopleNotes(vaultCtx)).notes.filter(
      (note) => note.parsed.frontmatter.jarvisPersonId === personId
    );
    if (matches.length !== 1) throw new CanonicalNoteNotFoundError(personId);
    return matches[0]!;
  }

  private async projectNote(
    scopedDb: DataContextDb,
    ownerUserId: string,
    note: LoadedPeopleNote
  ): Promise<Person> {
    const personId = note.parsed.frontmatter.jarvisPersonId;
    if (!personId) throw new Error("People note missing jarvisPersonId");

    const person = await this.peopleRepository.upsertPersonProjection(scopedDb, {
      ownerUserId,
      personId,
      displayName: note.parsed.frontmatter.displayName,
      status: note.parsed.frontmatter.status,
      confidence: 1
    });
    await this.peopleRepository.deleteNoteIdentities(scopedDb, ownerUserId, person.id);

    for (const alias of note.parsed.frontmatter.aliases) {
      await this.peopleRepository.upsertIdentity(scopedDb, {
        ownerUserId,
        personId: person.id,
        identityKind: "alias",
        sourceKind: "note",
        normalizedValue: normalizeIdentity("alias", alias),
        displayValue: alias,
        sourceRef: note.path,
        sourceRefHash: hash(`${note.path}:alias:${alias}`),
        status: "active",
        confidence: 1,
        provenance: "user_confirmed"
      });
    }

    for (const email of note.parsed.frontmatter.emails) {
      await this.peopleRepository.upsertIdentity(scopedDb, {
        ownerUserId,
        personId: person.id,
        identityKind: "email_address",
        sourceKind: "note",
        normalizedValue: normalizeIdentity("email_address", email),
        displayValue: email,
        sourceRef: note.path,
        sourceRefHash: hash(`${note.path}:email:${email}`),
        status: "active",
        confidence: 1,
        provenance: "user_confirmed"
      });
    }

    return person;
  }

  private async createReviewCandidate(
    scopedDb: DataContextDb,
    ownerUserId: string,
    reasonSummary: string,
    ids: readonly string[]
  ): Promise<void> {
    await this.peopleRepository.upsertMatchCandidate(scopedDb, {
      ownerUserId,
      candidateKind: "create_person",
      reasonSummary,
      confidence: 0.5,
      ids: [...ids]
    });
  }

  private async createMissingCanonicalNoteCandidates(
    scopedDb: DataContextDb,
    ownerUserId: string,
    canonicalPersonIds: ReadonlySet<string>
  ): Promise<number> {
    const people = await this.peopleRepository.listPeople(scopedDb, ownerUserId, {});
    let candidates = 0;
    for (const person of people) {
      if (person.status === "merged" || canonicalPersonIds.has(person.id)) continue;
      await this.createReviewCandidate(
        scopedDb,
        ownerUserId,
        "Existing People record missing canonical note",
        [person.id]
      );
      candidates += 1;
    }
    return candidates;
  }

  private async nextNotePath(
    vaultCtx: VaultContext,
    displayName: string,
    personId: string
  ): Promise<string> {
    const base = slugName(displayName);
    const first = `${base}.md`;
    if (!(await vaultFileExists(vaultCtx, first))) return first;
    return `${base}-${personId.slice(0, 8)}.md`;
  }
}
