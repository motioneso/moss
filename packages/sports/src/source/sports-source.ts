import type { Headline, StandingsRow, TeamRef } from "@moss/shared";

// DTO shapes shared by the ESPN dataset adapter (source/espn-source.ts) and the sports service.
// The swappable-source contract itself (LOADER-SEAM(sports), D3) now lives in the dataset
// connector SDK (`ExternalSourceAdapter` in @moss/module-sdk) + the manifest-declared
// `externalSources` entry in ./manifest.ts; these DTOs are the only thing that stayed here.

export interface SourceTeamRef extends TeamRef {
  /** Provider-side team id — joins news team tags to catalog teams. Never serialized. */
  readonly sourceTeamId: string | null;
}
/**
 * The wire type always carries a photo size, but a source that never finds one should not have to
 * spell out two nulls, so these two are optional on the way in. `toPublicHeadline` fills them.
 */
type SourceHeadlineBase = Omit<Headline, "imageWidth" | "imageHeight"> & {
  readonly imageWidth?: number | null;
  readonly imageHeight?: number | null;
};

export type EspnSourceHeadline = SourceHeadlineBase & {
  readonly origin: "espn";
  /** Provider-side team ids tagged on the article; the service resolves these to teamKeys. */
  readonly sourceTeamIds: readonly string[];
};

export type CustomSourceHeadline = SourceHeadlineBase & {
  readonly origin: "custom";
  readonly sourceId: string;
};

export type SourceHeadline = EspnSourceHeadline | CustomSourceHeadline;

export interface StandingsTable {
  readonly sections: readonly {
    readonly label: string | null;
    // Parent conference label (e.g. "American Football Conference"); absent/null for flat tables
    // and soccer groups (#839 follow-up). Optional so older cached tables + fixtures omit it.
    readonly conference?: string | null;
    readonly rows: readonly StandingsRow[];
  }[];
}
