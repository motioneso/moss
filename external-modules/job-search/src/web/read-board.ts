// Reading the whole board, rather than its first page.
//
// A browser read returns through the assistant tool-result route, which throws the structured
// result away and substitutes a truncation notice once the rendered form passes 16 000 characters
// (packages/ai/src/routes.ts). So one response carries about 25 rows and no more — that ceiling is
// real and is not the module's to raise. What WAS the module's problem is that the board asked for
// one page and stopped: a profile with 167 matches rendered 25 rows, and a search that found
// dozens more left the count sitting on 25, which reads as a search that did nothing.
//
// This walks the pages instead. `matches.list` returns `hasMore`, so the loop ends on the tool's
// own answer rather than on a guess: a page can be short of `limit` without being the last one
// (a match whose posting has since been removed is skipped server-side), which is also why the
// offset advances by the requested page size and never by the number of rows that came back.
import { invokeTool } from "./api";
import { isBoardMatch, type BoardMatch } from "./board-types";
import { MATCHES_LIST_MAX_LIMIT } from "../domain/records.js";

// 40 pages × 25 = 1000 rows. Not a taste limit: it is the point past which the sequential round
// trips cost more than the rows are worth to someone scrolling a board, and a stop has to exist
// somewhere or a bug in `hasMore` becomes an infinite request loop. `truncated` is returned rather
// than swallowed so a caller that hits it can say so instead of quietly showing a partial board.
export const MAX_BOARD_PAGES = 40;

export interface BoardPageResult {
  readonly items: BoardMatch[];
  /** True when the board really does have more rows than MAX_BOARD_PAGES could carry. */
  readonly truncated: boolean;
  /** Rows the server sent that didn't have the shape a match row requires — dropped rather than
   * rendered broken (#1336). Zero on every normal read. */
  readonly invalidCount: number;
}

interface MatchesListResponse {
  items?: unknown[];
  hasMore?: boolean;
}

/**
 * Reads every match on a profile's board, one page at a time.
 *
 * Throws whatever `invokeTool` throws. A partial read is deliberately NOT returned as a success:
 * a board that silently drops the pages after a failed request would show a smaller number than
 * the truth, which is the exact defect this file exists to fix.
 */
export async function readWholeBoard(profileId: string): Promise<BoardPageResult> {
  const items: BoardMatch[] = [];
  let invalidCount = 0;
  let offset = 0;
  for (let page = 0; page < MAX_BOARD_PAGES; page++) {
    const result = (await invokeTool("job-search.matches.list", {
      profileId,
      limit: MATCHES_LIST_MAX_LIMIT,
      offset
    })) as MatchesListResponse | null;
    const rawBatch = Array.isArray(result?.items) ? result!.items : [];
    // #1336: matches.list's response is never trusted at face value — every row is checked
    // against the shape the board actually needs before it's rendered. A row that fails is
    // dropped, not rendered with gaps, and counted so the board can say plainly that something
    // was left off (board.tsx's invalidCount notice) rather than showing a smaller board with no
    // explanation.
    const batch = rawBatch.filter(isBoardMatch);
    invalidCount += rawBatch.length - batch.length;
    items.push(...batch);
    if (result?.hasMore !== true) return { items, truncated: false, invalidCount };
    offset += MATCHES_LIST_MAX_LIMIT;
  }
  return { items, truncated: true, invalidCount };
}
