/**
 * Composition-root glue for the email thread judgement worker (#2274, slice 1).
 *
 * The Commitments module never imports People, Notes, Tasks, Calendar or Email: it declares the
 * `CommitmentContextProviders` and `EmailThreadProvider` contracts in module-sdk, and this file
 * satisfies them from the other modules' public surfaces (their assistant tools and repositories).
 * Only titles, dates and one-line excerpts cross the boundary; nothing here logs an address.
 */
import { randomUUID } from "node:crypto";

import type {
  AiRepository,
  AiSecretCipher,
  GenerateStructuredDeps,
  GenerateStructuredInput,
  GenerateStructuredResult
} from "@moss/ai";
import { EMAIL_JUDGEMENT_SCHEMA, EMAIL_JUDGEMENT_SERVICE } from "@moss/commitments";
import type {
  CommitmentCalendarWindow,
  CommitmentContextProviders,
  CommitmentOpenTask,
  CommitmentPersonContext,
  MossModuleManifest,
  ToolContext,
  ToolExecute
} from "@moss/module-sdk";

type GenerateStructuredFn = (
  scopedDb: never,
  input: GenerateStructuredInput,
  deps: GenerateStructuredDeps
) => Promise<GenerateStructuredResult>;

export interface EmailJudgementGenerateDeps {
  readonly aiRepository: Pick<
    AiRepository,
    "resolveModelForService" | "selectProviderWithCredential"
  >;
  readonly cipher: Pick<AiSecretCipher, "decryptJson">;
  readonly generateStructured: GenerateStructuredFn;
  readonly createCliStructuredAdapter?: GenerateStructuredDeps["createCliStructuredAdapter"];
  readonly logger?: GenerateStructuredDeps["logger"];
}

/**
 * The worker's `generate` dependency: one structured call on the reasoning tier under the email
 * judgement service key. The router picks the user's configured model; no provider is named.
 */
export function buildEmailJudgementGenerate(deps: EmailJudgementGenerateDeps) {
  return async (scopedDb: unknown, _actorUserId: string, prompt: string): Promise<unknown> => {
    const result = await deps.generateStructured(
      scopedDb as never,
      {
        service: EMAIL_JUDGEMENT_SERVICE,
        schema: EMAIL_JUDGEMENT_SCHEMA,
        prompt,
        tierHint: "reasoning",
        requireExplicitBinding: false
      },
      {
        repository: deps.aiRepository,
        cipher: deps.cipher,
        createCliStructuredAdapter: deps.createCliStructuredAdapter,
        logger: deps.logger
      }
    );
    if (!result.ok) throw new Error(`email judgement model: ${result.error}`);
    return result.object;
  };
}

interface ResolvedPerson {
  readonly id: string;
  readonly displayName: string | null;
  readonly relationshipSummary: string | null;
}

export interface EmailContextProviderDeps {
  readonly manifests: readonly MossModuleManifest[];
  readonly people: {
    resolve(scopedDb: unknown, ownerUserId: string, query: string): Promise<ResolvedPerson | null>;
  };
  readonly timezoneFor: (scopedDb: unknown, actorUserId: string) => Promise<string>;
  readonly now?: () => Date;
}

/** Hard cap the calendar tool enforces for cross-tool use. */
const CALENDAR_EVENT_LIMIT = 20;
const DAY_MS = 24 * 60 * 60 * 1000;

function findExecute(
  manifests: readonly MossModuleManifest[],
  toolName: string
): ToolExecute | undefined {
  return manifests.flatMap((m) => m.assistantTools ?? []).find((t) => t.name === toolName)?.execute;
}

function ctxFor(actorUserId: string): ToolContext {
  return { actorUserId, requestId: `email-judgement:${randomUUID()}`, chatSessionId: "" };
}

function oneLine(text: string): string {
  return text.replace(/\s+/g, " ").trim();
}

function asRecords(value: unknown): Record<string, unknown>[] {
  return Array.isArray(value)
    ? value.filter((v): v is Record<string, unknown> => !!v && typeof v === "object")
    : [];
}

function str(value: unknown): string | null {
  return typeof value === "string" && value.length > 0 ? value : null;
}

/**
 * Builds the four context lookups the judgement prompt draws on, each running the owning
 * module's read tool as the thread's owner. A provider is left out when its module's tool is
 * not registered, and the worker then tells the model that context was unavailable.
 */
export function buildEmailContextProviders(
  deps: EmailContextProviderDeps
): CommitmentContextProviders {
  const now = deps.now ?? (() => new Date());
  const notesSearch = findExecute(deps.manifests, "notes.search");
  const tasksList = findExecute(deps.manifests, "tasks.list");
  const calendarList = findExecute(deps.manifests, "calendar.listVisibleEvents");

  const providers: CommitmentContextProviders = {
    people: {
      async resolveByEmail(
        scopedDb,
        actorUserId,
        address
      ): Promise<CommitmentPersonContext | null> {
        const person = await deps.people.resolve(scopedDb, actorUserId, address);
        if (!person) return null;
        return {
          personId: person.id,
          displayName: person.displayName ?? null,
          relationshipSummary: person.relationshipSummary ?? null,
          recentNoteLines: []
        };
      }
    }
  };

  if (notesSearch) {
    providers.notes = {
      async searchLines(scopedDb, actorUserId, query, limit): Promise<readonly string[]> {
        const result = await notesSearch(scopedDb as never, { query, limit }, ctxFor(actorUserId));
        return asRecords(result.data["chunks"])
          .map((chunk) => oneLine(str(chunk["text"]) ?? ""))
          .filter((line) => line.length > 0)
          .slice(0, limit);
      }
    };
  }

  if (tasksList) {
    providers.tasks = {
      async listOpen(scopedDb, actorUserId, limit): Promise<readonly CommitmentOpenTask[]> {
        const result = await tasksList(scopedDb as never, { status: "todo" }, ctxFor(actorUserId));
        return asRecords(result.data["items"])
          .flatMap((item) => {
            const id = str(item["id"]);
            const title = str(item["title"]);
            if (!id || !title) return [];
            const dueAt = str(item["dueAt"]);
            return [{ id, title, dueLocalDate: dueAt ? dueAt.slice(0, 10) : null }];
          })
          .slice(0, limit);
      }
    };
  }

  if (calendarList) {
    providers.calendar = {
      async windowFromNow(scopedDb, actorUserId, days): Promise<CommitmentCalendarWindow | null> {
        const start = now();
        const end = new Date(start.getTime() + days * DAY_MS);
        const result = await calendarList(
          scopedDb as never,
          {
            startsAfter: start.toISOString(),
            startsBefore: end.toISOString(),
            limit: CALENDAR_EVENT_LIMIT
          },
          ctxFor(actorUserId)
        );
        const busy = asRecords(result.data["events"]).flatMap((event) => {
          const startsAt = str(event["startsAt"]);
          const endsAt = str(event["endsAt"]);
          if (!startsAt || !endsAt) return [];
          return [{ start: startsAt, end: endsAt, title: str(event["title"]) ?? "" }];
        });
        return { busy, timezone: await deps.timezoneFor(scopedDb, actorUserId) };
      }
    };
  }

  return providers;
}

/** The bare, lower-cased address from a header value such as `Sarah Kim <Sarah@Kim.Example>`. */
function bareAddress(value: string): string {
  const m = value.match(/<([^>]+)>/);
  return (m ? m[1]! : value).trim().toLowerCase();
}

export type AddressSetFor = (
  scopedDb: unknown,
  actorUserId: string
) => Promise<ReadonlySet<string>>;

export interface UserAddressesDeps {
  readonly email: {
    listFrequentRecipientAddresses(scopedDb: never, ownerUserId: string): Promise<string[]>;
  };
}

/**
 * The user's own mailbox addresses. The connected-account record does not store the mailbox
 * address, so they are inferred from the email cache: the recipients that appear on most of the
 * owner's messages.
 */
export function buildUserAddressesFor(deps: UserAddressesDeps): AddressSetFor {
  return async (scopedDb, actorUserId) => {
    const raw = await deps.email.listFrequentRecipientAddresses(scopedDb as never, actorUserId);
    return new Set(raw.map(bareAddress).filter((a) => a.length > 0));
  };
}

export interface KnownSenderDeps {
  readonly people: {
    listEmailIdentityValues(scopedDb: unknown, ownerUserId: string): Promise<string[]>;
  };
  readonly email: {
    listRecipientAddressesOfSenders(
      scopedDb: never,
      ownerUserId: string,
      senders: ReadonlySet<string>
    ): Promise<string[]>;
  };
  readonly userAddressesFor: AddressSetFor;
}

/**
 * Addresses the user already knows: every email identity on a People record plus everyone the
 * user has written to. The gate leans `maybe_owed` for these; it never decides on them.
 */
export function buildKnownSenderAddresses(deps: KnownSenderDeps): AddressSetFor {
  return async (scopedDb, actorUserId) => {
    const mine = await deps.userAddressesFor(scopedDb, actorUserId);
    const [identities, writtenTo] = await Promise.all([
      deps.people.listEmailIdentityValues(scopedDb, actorUserId),
      deps.email.listRecipientAddressesOfSenders(scopedDb as never, actorUserId, mine)
    ]);
    const known = new Set<string>();
    for (const raw of [...identities, ...writtenTo]) {
      const address = bareAddress(raw);
      if (address && !mine.has(address)) known.add(address);
    }
    return known;
  };
}
