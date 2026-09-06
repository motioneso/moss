import type { SportsCustomSourceDto, SportsSourcePhotoStatus } from "@moss/shared";
import { Button } from "@moss/module-web-sdk";

/**
 * #2237 slice 2 - the line on a source's settings row that says whether its stories are getting
 * photos, and the control that stops using the ones Moss found.
 *
 * The wording is fixed by the design spec, one sentence per state, so a person can tell at a
 * glance whether anything needs doing without opening the source.
 */

export const SPORTS_SOURCE_PHOTO_STATUS_TEXT: Record<SportsSourcePhotoStatus, string> = {
  working: "Photos: working",
  none: "Photos: none found",
  previewing: "Photos: preview ready",
  stopped_working: "Photos: stopped working",
  pending: "Photos: checking"
};

export function SourcePhotoStatus(props: {
  readonly source: SportsCustomSourceDto;
  readonly busy: boolean;
  readonly stopping: boolean;
  readonly onStopUsing: (sourceId: string) => void;
}) {
  const { source } = props;
  return (
    <p className="sp-src__meta-line">
      {SPORTS_SOURCE_PHOTO_STATUS_TEXT[source.photoStatus]}
      {source.photosFoundByMoss ? (
        <>
          {" "}
          <Button
            variant="quiet"
            size="sm"
            aria-label={`Stop using Moss's photos for ${source.label}`}
            disabled={props.busy}
            onClick={() => props.onStopUsing(source.id)}
          >
            {props.stopping ? "Stopping…" : "Stop using Moss's photos"}
          </Button>
        </>
      ) : null}
    </p>
  );
}
