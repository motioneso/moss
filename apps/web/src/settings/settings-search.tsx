import { useId, useState } from "react";

export interface SettingsSearchItem {
  readonly id: string;
  readonly label: string;
  readonly description: string;
  readonly group: string;
  readonly keywords: readonly string[];
}

const RESULT_LIMIT = 8;

/** Ranks settings sections against a free-text query. Every word in the query
    must hit the label, a keyword, the description or the group; label hits
    rank above keyword hits, which rank above description hits. */
export function searchSettings(
  items: readonly SettingsSearchItem[],
  query: string,
  limit = RESULT_LIMIT
): SettingsSearchItem[] {
  const terms = query.trim().toLowerCase().split(/\s+/).filter(Boolean);
  if (terms.length === 0) return [];
  const scored = items.flatMap((item) => {
    const label = item.label.toLowerCase();
    const description = item.description.toLowerCase();
    const group = item.group.toLowerCase();
    const keywords = item.keywords.map((keyword) => keyword.toLowerCase());
    let score = 0;
    for (const term of terms) {
      if (label.includes(term)) score += label.startsWith(term) ? 4 : 3;
      else if (keywords.some((keyword) => keyword.includes(term))) score += 2;
      else if (description.includes(term) || group.includes(term)) score += 1;
      else return [];
    }
    return [{ item, score }];
  });
  return scored
    .sort((a, b) => b.score - a.score || a.item.label.localeCompare(b.item.label))
    .slice(0, limit)
    .map((entry) => entry.item);
}

interface SettingsSearchProps {
  readonly items: readonly SettingsSearchItem[];
  readonly onSelect: (id: string) => void;
}

/** Search box on the Settings top bar (Ben, 2026-09-04): type a few letters
    and jump straight to the section that holds the setting. Reuses the
    combobox pop, list and option primitives so it looks like every other picker. */
export function SettingsSearch({ items, onSelect }: SettingsSearchProps) {
  const listId = useId();
  const [query, setQuery] = useState("");
  const [focused, setFocused] = useState(false);
  const [active, setActive] = useState(0);
  const results = searchSettings(items, query);
  const open = focused && query.trim().length > 0;
  const activeIndex = Math.min(active, Math.max(0, results.length - 1));

  const pick = (item: SettingsSearchItem) => {
    setQuery("");
    setActive(0);
    onSelect(item.id);
  };

  return (
    <div className="set2__search jds-combobox">
      <input
        className="jds-input jds-input--sm"
        type="search"
        role="combobox"
        aria-label="Search settings"
        aria-expanded={open}
        aria-controls={listId}
        aria-autocomplete="list"
        placeholder="Search settings"
        value={query}
        onChange={(event) => {
          setQuery(event.currentTarget.value);
          setActive(0);
        }}
        onFocus={() => setFocused(true)}
        onBlur={() => setFocused(false)}
        onKeyDown={(event) => {
          if (event.key === "ArrowDown" && results.length > 0) {
            event.preventDefault();
            setActive((index) => Math.min(index + 1, results.length - 1));
          } else if (event.key === "ArrowUp" && results.length > 0) {
            event.preventDefault();
            setActive((index) => Math.max(index - 1, 0));
          } else if (event.key === "Enter" && results[activeIndex]) {
            event.preventDefault();
            pick(results[activeIndex]);
          } else if (event.key === "Escape") {
            setQuery("");
          }
        }}
      />
      {open ? (
        <div className="jds-combobox__pop">
          {results.length > 0 ? (
            <div className="jds-combobox__list" role="listbox" id={listId}>
              {results.map((item, index) => (
                <button
                  key={item.id}
                  type="button"
                  role="option"
                  aria-selected={index === activeIndex}
                  className={`jds-combobox__option${index === activeIndex ? " jds-combobox__option--active" : ""}`}
                  onMouseDown={(event) => event.preventDefault()}
                  onMouseEnter={() => setActive(index)}
                  onClick={() => pick(item)}
                >
                  <span>{item.label}</span>
                  <span className="jds-caption set2__search-group">{item.group}</span>
                </button>
              ))}
            </div>
          ) : (
            <div className="jds-combobox__empty">No settings match.</div>
          )}
        </div>
      ) : null}
    </div>
  );
}
