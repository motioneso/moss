import { Check, ChevronLeft, ChevronRight, Star } from "lucide-react";
import { useEffect, useRef, useState, type KeyboardEvent } from "react";

import {
  MODEL_SEARCH_THRESHOLD,
  favoriteChoices,
  filterChoices,
  groupChoicesByProvider,
  starrableChoices,
  type ModelChoice,
  type ProviderGroup
} from "./chat-model-picker-model.js";

type View = { readonly kind: "top" } | { readonly kind: "provider"; readonly providerId: string };

const ROW_SELECTOR = "[data-picker-row]";

/**
 * The open panel of the chat model picker. The top level lists favorites, then providers; a
 * provider row drills into its models. Unmounted on close, so view and search reset each time.
 */
export function ChatModelPickerMenu(props: {
  readonly choices: readonly ModelChoice[];
  readonly favoriteIds: readonly string[];
  readonly disabled: boolean;
  readonly onPick: (choice: ModelChoice) => void;
  readonly onToggleFavorite: (choice: ModelChoice) => void;
}) {
  const [view, setView] = useState<View>({ kind: "top" });
  const [query, setQuery] = useState("");
  const menuRef = useRef<HTMLDivElement>(null);
  const searchRef = useRef<HTMLInputElement>(null);
  const returnToProvider = useRef<string | null>(null);

  const defaultChoice = props.choices.find((choice) => choice.modelId === null) ?? null;
  const models = starrableChoices(props.choices);
  const providers = groupChoicesByProvider(props.choices);
  const favorites = favoriteChoices(props.choices, props.favoriteIds);
  const favoriteSet = new Set(props.favoriteIds);
  const showSearch = models.length > MODEL_SEARCH_THRESHOLD;
  const searching = view.kind === "top" && query.trim().length > 0;
  const matches = searching ? filterChoices(props.choices, query) : [];
  const openProvider =
    view.kind === "provider"
      ? providers.find((group) => group.providerId === view.providerId)
      : null;

  useEffect(() => {
    const menu = menuRef.current;
    if (!menu) return;
    const target = returnToProvider.current;
    returnToProvider.current = null;
    if (target) {
      menu.querySelector<HTMLElement>(`[data-provider-id="${CSS.escape(target)}"]`)?.focus();
      return;
    }
    if (view.kind === "top" && searchRef.current) {
      searchRef.current.focus();
      return;
    }
    const rows = [...menu.querySelectorAll<HTMLElement>(ROW_SELECTOR)];
    const selected = rows.find((row) => row.dataset.selected === "true");
    const firstModel = view.kind === "provider" ? rows[1] : rows[0];
    (selected ?? firstModel ?? rows[0])?.focus();
  }, [view]);

  const goBack = () => {
    if (view.kind !== "provider") return;
    returnToProvider.current = view.providerId;
    setView({ kind: "top" });
  };

  const onKeyDown = (event: KeyboardEvent<HTMLDivElement>) => {
    const menu = menuRef.current;
    if (!menu) return;
    const rows = [...menu.querySelectorAll<HTMLElement>(ROW_SELECTOR)];
    const target = event.target as HTMLElement;
    const inSearch = target === searchRef.current;
    // A star button moves as if focus were on the row it belongs to.
    const rowTarget =
      target.closest(".chatd-model__row")?.querySelector<HTMLElement>(ROW_SELECTOR) ?? target;
    const index = rows.indexOf(rowTarget);
    const focusRow = (next: number) => {
      event.preventDefault();
      rows[Math.max(0, Math.min(rows.length - 1, next))]?.focus();
    };
    switch (event.key) {
      case "ArrowDown":
        focusRow(inSearch ? 0 : index + 1);
        return;
      case "ArrowUp":
        if (index <= 0 && searchRef.current) {
          event.preventDefault();
          searchRef.current.focus();
        } else focusRow(index - 1);
        return;
      case "Home":
        if (!inSearch) focusRow(0);
        return;
      case "End":
        if (!inSearch) focusRow(rows.length - 1);
        return;
      case "ArrowRight": {
        const providerId = target.dataset.providerId;
        if (providerId) {
          event.preventDefault();
          setView({ kind: "provider", providerId });
        }
        return;
      }
      case "ArrowLeft":
      case "Backspace":
        if (!inSearch && view.kind === "provider") {
          event.preventDefault();
          goBack();
        }
        return;
    }
  };

  const modelRow = (choice: ModelChoice, options: { readonly showProvider: boolean }) => (
    <ModelRow
      key={choice.modelId ?? "default"}
      choice={choice}
      showProvider={options.showProvider}
      starred={choice.modelId !== null && favoriteSet.has(choice.modelId)}
      disabled={props.disabled}
      onPick={props.onPick}
      onToggleFavorite={choice.modelId === null ? null : props.onToggleFavorite}
    />
  );

  return (
    <div className="chatd-model__menu" ref={menuRef} onKeyDown={onKeyDown}>
      {openProvider ? (
        <>
          <button
            type="button"
            className="chatd-model__back"
            data-picker-row
            onClick={goBack}
            aria-label={`Back to all providers from ${openProvider.label}`}
          >
            <ChevronLeft size={14} aria-hidden="true" />
            <span>{openProvider.label}</span>
          </button>
          <div className="chatd-model__list" role="group" aria-label={openProvider.label}>
            {openProvider.choices.map((choice) => modelRow(choice, { showProvider: false }))}
          </div>
        </>
      ) : (
        <>
          {showSearch ? (
            <input
              ref={searchRef}
              type="search"
              className="jds-input jds-input--sm chatd-model__search"
              placeholder="Search models"
              aria-label="Search models"
              value={query}
              onChange={(event) => setQuery(event.target.value)}
            />
          ) : null}
          {searching ? (
            <div className="chatd-model__list" role="group" aria-label="Matching models">
              {matches.map((choice) => modelRow(choice, { showProvider: true }))}
              {matches.length === 0 ? (
                <p className="jds-caption chatd-model__hint">No models match.</p>
              ) : null}
            </div>
          ) : (
            <>
              {defaultChoice ? (
                <ModelRow
                  choice={defaultChoice}
                  showProvider
                  subtitle={defaultChoice.model.providerModelId ?? defaultChoice.model.displayName}
                  starred={false}
                  disabled={props.disabled}
                  onPick={props.onPick}
                  onToggleFavorite={null}
                />
              ) : null}
              <p className="jds-eyebrow chatd-model__head">Favorites</p>
              {favorites.length > 0 ? (
                <div className="chatd-model__list" role="group" aria-label="Favorites">
                  {favorites.map((choice) => modelRow(choice, { showProvider: true }))}
                </div>
              ) : (
                <p className="jds-caption chatd-model__hint">Star a model to pin it here.</p>
              )}
              <p className="jds-eyebrow chatd-model__head">Providers</p>
              <div className="chatd-model__list" role="group" aria-label="Providers">
                {providers.map((group) => (
                  <ProviderRow
                    key={group.providerId}
                    group={group}
                    onOpen={() => setView({ kind: "provider", providerId: group.providerId })}
                  />
                ))}
              </div>
            </>
          )}
        </>
      )}
    </div>
  );
}

function ModelRow(props: {
  readonly choice: ModelChoice;
  readonly showProvider: boolean;
  readonly subtitle?: string;
  readonly starred: boolean;
  readonly disabled: boolean;
  readonly onPick: (choice: ModelChoice) => void;
  readonly onToggleFavorite: ((choice: ModelChoice) => void) | null;
}) {
  const { choice } = props;
  const subtitle = props.subtitle ?? (props.showProvider ? choice.providerLabel : null);
  return (
    <div className="chatd-model__row">
      <button
        type="button"
        className="chatd-model__pick"
        data-picker-row
        data-selected={choice.selected ? "true" : undefined}
        aria-current={choice.selected ? "true" : undefined}
        disabled={props.disabled}
        onClick={() => props.onPick(choice)}
      >
        <span className="chatd-model__text">
          <b>{choice.label}</b>
          {subtitle ? <small>{subtitle}</small> : null}
        </span>
        {choice.selected ? <Check size={13} aria-label="Current model" /> : null}
      </button>
      {props.onToggleFavorite ? (
        <button
          type="button"
          className="chatd-model__star"
          aria-pressed={props.starred}
          aria-label={props.starred ? `Unstar ${choice.label}` : `Star ${choice.label}`}
          onClick={() => props.onToggleFavorite?.(choice)}
        >
          <Star size={14} aria-hidden="true" fill={props.starred ? "currentColor" : "none"} />
        </button>
      ) : null}
    </div>
  );
}

function ProviderRow(props: { readonly group: ProviderGroup; readonly onOpen: () => void }) {
  const { group } = props;
  return (
    <button
      type="button"
      className="chatd-model__provider"
      data-picker-row
      data-provider-id={group.providerId}
      data-selected={group.selectedChoice ? "true" : undefined}
      aria-label={`${group.label}, ${group.choices.length} models${
        group.selectedChoice ? `, current model ${group.selectedChoice.label}` : ""
      }`}
      onClick={props.onOpen}
    >
      <span className="chatd-model__text">
        <b>{group.label}</b>
        {group.selectedChoice ? <small>{group.selectedChoice.label}</small> : null}
      </span>
      <span className="chatd-model__count">
        {group.selectedChoice ? <Check size={13} aria-hidden="true" /> : null}
        {group.choices.length}
        <ChevronRight size={14} aria-hidden="true" />
      </span>
    </button>
  );
}
