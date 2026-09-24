import type { BriefingPlanBlockV1, BriefingPlanContextV1, LocaleSettingsDto } from "@moss/shared";

import { formatTime } from "../locale/locale-format.js";

/** One plan block whose effective time moved between the report's saved
    context and the plan as it stands now. */
export interface ChangedBriefingBlock {
  readonly title: string;
  readonly oldStartsAt: string | null;
  readonly newStartsAt: string | null;
  readonly proposed: boolean;
}

export interface BriefingCalloutCopy {
  readonly headline: string;
  readonly sentence: string;
  readonly disclosureLabel: string;
  readonly disclosureLines: readonly string[];
}

function blockTime(block: BriefingPlanBlockV1): string | null {
  return block.pendingChange
    ? (block.pendingStartsAt ?? null)
    : (block.actualPlacement?.startsAt ?? null);
}

function blockLabel(block: BriefingPlanBlockV1): string {
  return block.title ?? block.kind;
}

/** Blocks that carry the same id in both contexts but moved to a different
    effective time. Pure comparison, no formatting. */
export function findChangedBlocks(
  before: BriefingPlanContextV1 | null,
  after: BriefingPlanContextV1 | null
): readonly ChangedBriefingBlock[] {
  if (!before || !after) return [];
  const beforeById = new Map(before.blocks.map((block) => [block.id, block]));
  const changed: ChangedBriefingBlock[] = [];
  for (const afterBlock of after.blocks) {
    const beforeBlock = beforeById.get(afterBlock.id);
    if (!beforeBlock) continue;
    const oldStartsAt = blockTime(beforeBlock);
    const newStartsAt = blockTime(afterBlock);
    if (oldStartsAt !== newStartsAt)
      changed.push({
        title: blockLabel(afterBlock),
        oldStartsAt,
        newStartsAt,
        proposed: afterBlock.pendingChange !== null
      });
  }
  return changed;
}

function timeLabel(startsAt: string | null, locale: LocaleSettingsDto): string {
  return startsAt ? formatTime(startsAt, locale) : "no time";
}

/** Copy for the "changed overnight" callout, or null when nothing named by id
    in both contexts moved (the caller still shows the plain "plan has
    changed" line for a status of "changed"/"unavailable" with no comparable
    blocks). */
export function calloutCopy(
  changed: readonly ChangedBriefingBlock[],
  locale: LocaleSettingsDto
): BriefingCalloutCopy | null {
  if (changed.length === 0) return null;
  const block = changed[0];
  if (changed.length === 1 && block) {
    const time = timeLabel(block.newStartsAt, locale);
    return {
      headline: `${block.title} is now at ${time}.`,
      sentence: block.proposed
        ? `${block.title} is proposed for ${time}.`
        : `${block.title} is set for ${time}.`,
      disclosureLabel: "See the calendar change",
      disclosureLines: [`${block.title}: ${timeLabel(block.oldStartsAt, locale)} to ${time}`]
    };
  }
  return {
    headline: `${changed.length} blocks changed since this report.`,
    sentence: "Some blocks moved since this report was prepared.",
    disclosureLabel: "See the calendar change",
    disclosureLines: changed.map(
      (block) =>
        `${block.title}: ${timeLabel(block.oldStartsAt, locale)} to ${timeLabel(block.newStartsAt, locale)}`
    )
  };
}
