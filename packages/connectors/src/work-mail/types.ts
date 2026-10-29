import type { AccessContext, DataContextDb, DataContextRunner } from "@moss/db";

export const WORK_MAIL_BODY_MAX_CHARS = 24_000;
export const WORK_MAIL_MAX_PER_RUN = 25;
export const WORK_MAIL_SEEN_MAX = 500;

export interface CapturedMailMessage {
  readonly sender: string;
  readonly subject: string;
  readonly receivedAt: string;
  readonly threadHint: string | null;
  readonly body: string;
  readonly bodyTruncated: boolean;
}

export interface WorkMailMarker {
  readonly receivedAt: string;
  readonly key: string;
}

export interface WorkMailCursor {
  readonly marker: WorkMailMarker | null;
  readonly seen: readonly string[];
  readonly salt: string;
}

export interface WorkMailNoteCandidate {
  readonly index: number;
  readonly path: string;
  readonly title: string;
  readonly excerpt: string;
}

export interface WorkMailJudgement {
  readonly decision: "nothing" | "note";
  readonly target?:
    | { readonly kind: "candidate"; readonly index: number }
    | { readonly kind: "default" };
  readonly entry?: string;
  readonly reason: string;
}

export interface WorkMailJudgeInput {
  readonly message: CapturedMailMessage;
  readonly preferences: readonly string[];
  readonly senderContext: string | null;
  readonly candidates: readonly WorkMailNoteCandidate[];
}

export type WorkMailAppendResult = "written" | "private" | "unavailable" | "changed";

export interface WorkMailPorts {
  readonly preferences: {
    list(db: DataContextDb, ownerUserId: string): Promise<readonly string[]>;
  };
  readonly people: {
    senderContext(db: DataContextDb, ownerUserId: string, sender: string): Promise<string | null>;
  };
  readonly notes: {
    candidates(
      db: DataContextDb,
      access: AccessContext,
      query: string,
      limit: number
    ): Promise<readonly WorkMailNoteCandidate[]>;
    append(
      db: DataContextDb,
      access: AccessContext,
      path: string,
      entry: string
    ): Promise<WorkMailAppendResult>;
  };
  readonly judge: (
    db: DataContextDb,
    input: WorkMailJudgeInput,
    signal?: AbortSignal
  ) => Promise<WorkMailJudgement>;
  readonly now: () => Date;
}

export type WorkMailOutcome =
  | { readonly kind: "nothing" }
  | { readonly kind: "noted" }
  | { readonly kind: "duplicate" }
  | {
      readonly kind: "failed";
      readonly reason: "ai-unavailable" | "ai-invalid" | "vault-unavailable";
    };

export type WorkMailIngest = (
  dataContext: DataContextRunner,
  access: AccessContext,
  messages: readonly CapturedMailMessage[],
  ports: WorkMailPorts,
  signal?: AbortSignal
) => Promise<{
  readonly processed: number;
  readonly stoppedAt: number | null;
  readonly cursor: WorkMailCursor;
}>;
