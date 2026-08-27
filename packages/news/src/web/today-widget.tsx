// Side-effect CSS import so .nw-twlist is styled on /today even when /news was never visited
// (sports' widget gets its CSS transitively by importing from sports-page; this one doesn't).
import "./styles/news-2.css";
import { useQuery } from "@tanstack/react-query";
import type { ReactNode } from "react";

import { getNewsOverview } from "./news-client.js";
import { newsQueryKeys } from "./query-keys.js";
import { StoryFeedbackMenu } from "./story-feedback-menu.js";

// One lead + three brief lines keeps Today compact while sharing News' exact ranking.
const WIDGET_CAP = 4;

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
  const data = overviewQuery.data;
  if (!data || data.topStories.length === 0) return null;

  const [lead, ...rest] = data.topStories.slice(0, WIDGET_CAP);
  // topStories is non-empty here (guarded above), but array-index access is typed as possibly
  // undefined under noUncheckedIndexedAccess — narrow it so the lead JSX below type-checks.
  if (!lead) return null;

  return (
    <section className="jds-brief" aria-label="News desk">
      <div className="jds-brief__head">
        <span className="jds-brief__kicker">News desk</span>
      </div>
      <div className="jds-brief__title">Top stories</div>
      {/* Lead story — broadsheet treatment. Photo (when present), source tag, display headline,
          and a one-line dek clamped so a long summary can't push the brief list off the fold. */}
      <div className="nw-twlead-wrap">
        <a className="nw-twlead" href={lead.url} target="_blank" rel="noreferrer">
          {lead.imageUrl ? (
            <img className="nw-twlead__photo" src={lead.imageUrl} alt="" loading="lazy" />
          ) : null}
          <span className="nw-twlead__tag">{lead.sourceLabel}</span>
          <span className="nw-twlead__title">{lead.title}</span>
          {lead.summary ? <span className="nw-twlead__dek">{lead.summary}</span> : null}
        </a>
        <StoryFeedbackMenu headline={lead} surface="today" />
      </div>
      {rest.length > 0 ? (
        <ul className="nw-twlist">
          {rest.map((headline) => (
            <li className="nw-twlist__item" key={headline.id}>
              <div className="nw-twlist__row">
                <a className="nw-twlist__link" href={headline.url} target="_blank" rel="noreferrer">
                  <span className="nw-twlist__tag">{headline.sourceLabel}</span>
                  <span className="nw-twlist__title">{headline.title}</span>
                </a>
                <StoryFeedbackMenu headline={headline} surface="today" />
              </div>
            </li>
          ))}
        </ul>
      ) : null}
    </section>
  );
}
