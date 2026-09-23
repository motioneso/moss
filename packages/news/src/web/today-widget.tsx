// Side-effect CSS import so .nw-twlist is styled on /today even when /news was never visited
// (sports' widget gets its CSS transitively by importing from sports-page; this one doesn't).
import "./styles/news-2.css";
import { useQuery } from "@tanstack/react-query";
import { useState, type ReactNode } from "react";

import { getNewsOverview } from "./news-client.js";
import { newsQueryKeys } from "./query-keys.js";
import { StoryFeedbackMenu } from "./story-feedback-menu.js";

// One lead + three brief lines keeps Today compact while sharing News' exact ranking.
const WIDGET_CAP = 4;

/**
 * A brief row's source tag: the publisher's favicon when one loaded, the publisher name as plain
 * text otherwise (Ben: show the icon, keep the name as the image's alt text and tooltip). Tracks
 * the URL that failed, not a bare flag, so a later story from a publisher whose icon loaded fine
 * doesn't stay stuck showing text because an earlier request for the same URL once failed.
 *
 * The icon sits on a small tile that stays light in both themes (#2290): most publisher icons
 * are dark marks on a transparent background and vanished on the dark theme when drawn straight
 * onto the page. One tile, no second fetch, and the approved-host rule for the icon itself is
 * untouched.
 */
function SourceTag(props: { faviconUrl: string | null; label: string }): ReactNode {
  const [failedUrl, setFailedUrl] = useState<string | null>(null);
  if (props.faviconUrl && props.faviconUrl !== failedUrl) {
    return (
      <span className="nw-twlist__favicon-tile">
        <img
          className="nw-twlist__favicon"
          src={props.faviconUrl}
          alt={props.label}
          title={props.label}
          width={14}
          height={14}
          loading="lazy"
          onError={() => setFailedUrl(props.faviconUrl)}
        />
      </span>
    );
  }
  return <>{props.label}</>;
}

/**
 * Today "News desk" widget. Reuses the same `getNewsOverview()` query as the `/news` page
 * (identical `newsQueryKeys.overview` key, so it shares the React Query cache). No polling —
 * headlines move on the server's 10-minute dataset TTL, unlike sports' live scores.
 * Renders nothing until stories exist, so a fresh install's /today stays clean.
 *
 * Newspaper layout (Ben 2026-07-09): the editorial lead (topStories[0]) gets the broadsheet
 * treatment — photo + display headline + one-line dek, the same voice as the /news mosaic hero —
 * while the remaining stories keep the tight headline-list treatment ("smaller stories can still
 * get the headline treatment"). Lead order is NOT reshuffled to chase a photo: the server's #1
 * story leads regardless, and when it happens to have no art it degrades to a headline-forward
 * lead (no fake image plate — same minimalist rule the sports cards follow).
 */
export function NewsTodayWidget(): ReactNode {
  const overviewQuery = useQuery({
    queryKey: newsQueryKeys.overview,
    queryFn: () => getNewsOverview()
  });
  // A lead photo that fails to load falls back to the text treatment: track the URL that
  // failed (not a bare flag) so a later lead with a good photo still renders it.
  const [failedLeadPhoto, setFailedLeadPhoto] = useState<string | null>(null);
  const data = overviewQuery.data;
  if (!data || data.topStories.length === 0) return null;

  const [lead, ...rest] = data.topStories.slice(0, WIDGET_CAP);
  // topStories is non-empty here (guarded above), but array-index access is typed as possibly
  // undefined under noUncheckedIndexedAccess — narrow it so the lead JSX below type-checks.
  if (!lead) return null;

  return (
    <section className="jds-brief jds-brief--news" aria-label="News desk">
      <div className="desk-head">
        <span className="desk-number">02</span>
        <h2 className="desk-title">The wider world</h2>
        <span className="desk-meta">News desk</span>
      </div>
      <div className="desk-cols">
        <div className="desk-leadcol">
          {/* Lead story — broadsheet treatment. Photo (when present), source tag, display headline,
              and a one-line dek clamped so a long summary can't push the brief list off the fold. */}
          <div className="nw-twlead-wrap nw-fbhost">
            <a className="nw-twlead" href={lead.url} target="_blank" rel="noreferrer">
              {lead.imageUrl && lead.imageUrl !== failedLeadPhoto ? (
                <img
                  className="nw-twlead__photo"
                  src={lead.imageUrl}
                  alt=""
                  loading="lazy"
                  onError={() => setFailedLeadPhoto(lead.imageUrl)}
                />
              ) : null}
              <span className="nw-twlead__tag">
                <span className="nw-twlead__tag-evening">{lead.sourceLabel}</span>
                <span className="nw-twlead__tag-morning">
                  {lead.topicLabel ?? lead.sourceLabel} / THE LEAD STORY
                </span>
              </span>
              <span className="nw-twlead__title">{lead.title}</span>
              {lead.summary ? <span className="nw-twlead__dek">{lead.summary}</span> : null}
              <span className="nw-twlead__link">Read the story ↗</span>
            </a>
            <StoryFeedbackMenu headline={lead} surface="today" />
          </div>
        </div>
        {rest.length > 0 ? (
          <div className="desk-listcol">
            <ul className="nw-twlist">
              {rest.map((headline) => (
                <li className="nw-twlist__item" key={headline.id}>
                  <div className="nw-twlist__row nw-fbhost">
                    <a
                      className="nw-twlist__link"
                      href={headline.url}
                      target="_blank"
                      rel="noreferrer"
                    >
                      {/* Kicker keeps the .nw-twlist__tag class: the topic label when the feed gave
                      one, otherwise the source tag with favicon. One-line dek when present. */}
                      <span className="nw-twlist__tag">
                        {headline.topicLabel ?? (
                          <SourceTag
                            faviconUrl={headline.faviconUrl}
                            label={headline.sourceLabel}
                          />
                        )}
                      </span>
                      <span className="nw-twlist__title">{headline.title}</span>
                      {headline.summary ? (
                        <span className="nw-twlist__dek">{headline.summary}</span>
                      ) : null}
                    </a>
                    <StoryFeedbackMenu headline={headline} surface="today" />
                  </div>
                </li>
              ))}
            </ul>
          </div>
        ) : null}
      </div>
    </section>
  );
}
