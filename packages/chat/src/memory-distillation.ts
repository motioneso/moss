import type { MemoryEntityKind, MemoryFactPredicate } from "@moss/memory";

const ENTITY_KINDS = new Set<MemoryEntityKind>([
  "person",
  "project",
  "preference",
  "goal",
  "constraint",
  "decision",
  "topic",
  "place",
  "organization",
  "self"
]);

const FACT_PREDICATES = new Set<MemoryFactPredicate>([
  "prefers",
  "works_on",
  "has_goal",
  "has_constraint",
  "decided",
  "related_to",
  "owes",
  "waiting_on",
  "mentioned_in",
  "alias_of"
]);

const SOCIAL_CHATTER = /^(hi|hello|hey|thanks|thank you|ok|okay|cool|sounds good)[\s!.]*$/i;
const EXPLICIT_TRIGGER =
  /\b(remember|don't forget|note that|save this|i prefer|i like|i hate|i want you to|we decided|decision|let's go with|approved|my goal|priority|focus|deadline|actually|that's wrong|i will|i need to|remind me|follow up)\b|(^|\W)no,\s/i;
const CONCRETE_MARKER =
  /\b(approved|decided|deadline|today|tomorrow|yesterday|\d{4}-\d{2}-\d{2}|january|february|march|april|may|june|july|august|september|october|november|december|need to|will|shipped|blocked)\b/i;
const NAMED_SUBJECT = /\b(project|person|client|team|ben|jarvis|rfa-\d+|#[0-9]+)\b/i;
const SENSITIVE_MEMORY_TEXT =
  /\b(api[-_\s]?key|access[-_\s]?token|refresh[-_\s]?token|id[-_\s]?token|auth(?:orization)?[-_\s]?token|bearer\s+[a-z0-9._~+/=-]+|oauth|password|passwd|pwd|passphrase|client[-_\s]?secret|secret[-_\s]?key|secret|private[-_\s]?key|credit[-_\s]?card|bank[-_\s]?account|database[-_\s]?url)\b|(?:^|[\s;,"'`])(?:[A-Z0-9_]*(?:TOKEN|SECRET|PASSWORD|PASSWD|PWD|API_KEY|PRIVATE_KEY|DATABASE_URL))\s*[:=]|[a-z][a-z0-9+.-]*:\/\/[^/\s:@]+:[^/\s@]+@|-----BEGIN [A-Z ]*PRIVATE KEY-----|(?:sk|pk|rk)_(?:live|test)_[A-Za-z0-9]{8,}|(?:sk|ghp|github_pat|xox[baprs]|AKIA)[-_A-Za-z0-9]{8,}/i;

export type MemoryCandidateKind = "entity" | "fact" | "alias" | "supersession" | "conflict";
export type MemoryCandidateAction = "create" | "update" | "link" | "supersede" | "reject";
export type MemoryCandidateProvenance = "volunteered" | "inferred";

export interface MemoryCandidate {
  readonly kind: MemoryCandidateKind;
  readonly action: MemoryCandidateAction;
  readonly entity?: {
    readonly kind: MemoryEntityKind;
    readonly name: string;
    readonly summary?: string;
  };
  readonly fact?: {
    readonly subject: string;
    readonly predicate: MemoryFactPredicate;
    readonly objectText?: string;
    readonly objectName?: string;
  };
  readonly alias?: {
    readonly alias: string;
    readonly targetName: string;
  };
  readonly provenance: MemoryCandidateProvenance;
  readonly confidence: number;
  readonly importance: number;
  readonly sourceExcerpt: string;
  readonly rationale: string;
  readonly isSensitive: boolean;
  readonly supersedesIds?: readonly string[];
}

export interface BuildDistillationPromptInput {
  readonly userText: string;
  readonly assistantText: string;
  readonly threadTitle: string;
  readonly activeMemory: readonly { readonly id: string; readonly text: string }[];
}

export interface PromotionDecisionInput {
  readonly candidate: MemoryCandidate;
  readonly explicitMemoryCommand: boolean;
  readonly explicitCorrection?: boolean;
  readonly conflicts: boolean;
  readonly groundedSupersedes: boolean;
}

export type PromotionDecision =
  | { readonly status: "promote"; readonly reason: string }
  | { readonly status: "pending"; readonly reason: string };

export function shouldDistillTurn(userText: string, assistantText: string): boolean {
  const text = `${userText}\n${assistantText}`.trim();
  const user = userText.trim();
  if (!text || SOCIAL_CHATTER.test(user)) return false;
  if (EXPLICIT_TRIGGER.test(user)) return true;
  if (NAMED_SUBJECT.test(user) && CONCRETE_MARKER.test(user)) return true;
  return user.length >= 240 && CONCRETE_MARKER.test(user);
}

export function buildDistillationPrompt(input: BuildDistillationPromptInput): string {
  const active = input.activeMemory
    .slice(0, 30)
    .map((item) => `${item.id}: ${item.text.slice(0, 180)}`)
    .join("\n");

  return [
    "Extract durable memory candidates from one chat turn.",
    "Return ONLY JSON matching MemoryCandidate[]. No markdown, prose, or code fences.",
    "Discard credentials, tokens, passwords, OAuth data, financial account numbers, and secrets.",
    "Do not create commitments, reminders, tasks, or follow-up jobs.",
    "Use volunteered only for direct user statements; otherwise inferred.",
    "supersedesIds may reference only ids from ACTIVE MEMORY.",
    'Fact subject is "self" when the fact is about the user, otherwise the name of the person or thing it describes.',
    "",
    `THREAD: ${input.threadTitle}`,
    `ACTIVE MEMORY:\n${active || "(none)"}`,
    "",
    `USER:\n${input.userText}`,
    "",
    `ASSISTANT:\n${input.assistantText}`
  ].join("\n");
}

export function parseMemoryCandidates(text: string): MemoryCandidate[] {
  let parsed: unknown;
  try {
    parsed = JSON.parse(text.trim());
  } catch {
    return [];
  }
  if (!Array.isArray(parsed)) return [];
  return parsed.flatMap((item) => {
    const candidate = parseCandidate(item);
    return candidate ? [candidate] : [];
  });
}

export function containsSensitiveMemoryText(value: string): boolean {
  return SENSITIVE_MEMORY_TEXT.test(value);
}

export function rawTurnContainsSensitiveText(userText: string, assistantText: string): boolean {
  return containsSensitiveMemoryText(userText) || containsSensitiveMemoryText(assistantText);
}

export function memoryCandidateContainsSensitiveText(candidate: MemoryCandidate): boolean {
  return [
    candidate.entity?.name,
    candidate.entity?.summary,
    candidate.fact?.subject,
    candidate.fact?.objectText,
    candidate.fact?.objectName,
    candidate.alias?.alias,
    candidate.alias?.targetName,
    candidate.sourceExcerpt,
    candidate.rationale
  ].some((value) => typeof value === "string" && containsSensitiveMemoryText(value));
}

export function decideCandidatePromotion(input: PromotionDecisionInput): PromotionDecision {
  const { candidate } = input;
  if (candidate.provenance === "inferred") return { status: "pending", reason: "inferred" };
  if (candidate.isSensitive) return { status: "pending", reason: "sensitive" };
  if (isCommitment(candidate)) return { status: "pending", reason: "commitment_pending_537" };
  if (input.conflicts && !input.groundedSupersedes)
    return { status: "pending", reason: "conflict" };

  if (candidate.kind === "supersession") {
    return input.groundedSupersedes &&
      input.explicitCorrection === true &&
      candidate.confidence >= 0.85
      ? { status: "promote", reason: "grounded_correction" }
      : { status: "pending", reason: "ungrounded_correction" };
  }
  if (candidate.kind === "alias") {
    return candidate.confidence >= 0.9
      ? { status: "promote", reason: "existing_entity_alias" }
      : { status: "pending", reason: "low_confidence" };
  }
  if (input.explicitMemoryCommand && candidate.confidence >= 0.7) {
    return { status: "promote", reason: "explicit_memory_command" };
  }
  if (isExplicitProfile(candidate) && candidate.confidence >= 0.8) {
    return { status: "promote", reason: "explicit_profile" };
  }
  return { status: "pending", reason: "low_confidence" };
}

function parseCandidate(value: unknown): MemoryCandidate | undefined {
  if (!value || typeof value !== "object" || Array.isArray(value)) return undefined;
  const raw = value as Record<string, unknown>;
  if (!isKind(raw.kind) || !isAction(raw.action)) return undefined;
  const entity = parseEntity(raw.entity);
  const fact = parseFact(raw.fact);
  const alias = parseAlias(raw.alias);
  if (!entity && !fact && !alias) return undefined;
  const provenance = raw.provenance === "volunteered" ? "volunteered" : "inferred";
  const sourceExcerpt = typeof raw.sourceExcerpt === "string" ? raw.sourceExcerpt.trim() : "";
  const rationale = typeof raw.rationale === "string" ? raw.rationale.trim() : "";
  if (!sourceExcerpt || !rationale) return undefined;

  const candidate = {
    kind: raw.kind,
    action: raw.action,
    ...(entity ? { entity } : {}),
    ...(fact ? { fact } : {}),
    ...(alias ? { alias } : {}),
    provenance,
    confidence: clamp01(typeof raw.confidence === "number" ? raw.confidence : 0),
    importance: clamp01(typeof raw.importance === "number" ? raw.importance : 0.5),
    sourceExcerpt: sourceExcerpt.slice(0, 1200),
    rationale: rationale.slice(0, 500),
    isSensitive: raw.isSensitive === true,
    supersedesIds: Array.isArray(raw.supersedesIds)
      ? raw.supersedesIds.filter((id): id is string => typeof id === "string")
      : undefined
  } satisfies MemoryCandidate;
  return {
    ...candidate,
    isSensitive: candidate.isSensitive || memoryCandidateContainsSensitiveText(candidate)
  };
}

function parseEntity(value: unknown): MemoryCandidate["entity"] | undefined {
  if (!value || typeof value !== "object" || Array.isArray(value)) return undefined;
  const raw = value as Record<string, unknown>;
  if (typeof raw.kind !== "string" || !ENTITY_KINDS.has(raw.kind as MemoryEntityKind)) {
    return undefined;
  }
  if (typeof raw.name !== "string" || !raw.name.trim()) return undefined;
  return {
    kind: raw.kind as MemoryEntityKind,
    name: raw.name.trim(),
    summary: typeof raw.summary === "string" ? raw.summary.trim() : undefined
  };
}

function parseFact(value: unknown): MemoryCandidate["fact"] | undefined {
  if (!value || typeof value !== "object" || Array.isArray(value)) return undefined;
  const raw = value as Record<string, unknown>;
  if (typeof raw.subject !== "string" || !raw.subject.trim()) return undefined;
  if (
    typeof raw.predicate !== "string" ||
    !FACT_PREDICATES.has(raw.predicate as MemoryFactPredicate)
  ) {
    return undefined;
  }
  const objectText = typeof raw.objectText === "string" ? raw.objectText.trim() : "";
  const objectName = typeof raw.objectName === "string" ? raw.objectName.trim() : "";
  if (Boolean(objectText) === Boolean(objectName)) return undefined;
  return {
    subject: raw.subject.trim(),
    predicate: raw.predicate as MemoryFactPredicate,
    ...(objectText ? { objectText } : { objectName })
  };
}

function parseAlias(value: unknown): MemoryCandidate["alias"] | undefined {
  if (!value || typeof value !== "object" || Array.isArray(value)) return undefined;
  const raw = value as Record<string, unknown>;
  if (typeof raw.alias !== "string" || !raw.alias.trim()) return undefined;
  if (typeof raw.targetName !== "string" || !raw.targetName.trim()) return undefined;
  return { alias: raw.alias.trim(), targetName: raw.targetName.trim() };
}

function isKind(value: unknown): value is MemoryCandidateKind {
  return (
    value === "entity" ||
    value === "fact" ||
    value === "alias" ||
    value === "supersession" ||
    value === "conflict"
  );
}

function isAction(value: unknown): value is MemoryCandidateAction {
  return (
    value === "create" ||
    value === "update" ||
    value === "link" ||
    value === "supersede" ||
    value === "reject"
  );
}

function clamp01(value: number): number {
  return Math.min(1, Math.max(0, value));
}

function isExplicitProfile(candidate: MemoryCandidate): boolean {
  return (
    candidate.kind === "entity" ||
    candidate.fact?.predicate === "prefers" ||
    candidate.fact?.predicate === "has_goal" ||
    candidate.fact?.predicate === "has_constraint" ||
    candidate.fact?.predicate === "decided"
  );
}

function isCommitment(candidate: MemoryCandidate): boolean {
  return candidate.fact?.predicate === "owes" || candidate.fact?.predicate === "waiting_on";
}
