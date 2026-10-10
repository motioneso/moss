import { useMutation, useQuery, useQueryClient } from "@tanstack/react-query";
import {
  CalendarDays,
  Check,
  CheckSquare,
  Copy,
  House,
  Settings,
  Palette,
  PencilLine,
  Plus,
  Save,
  Trash2,
  X
} from "lucide-react";
import { useMemo, useRef, useState, type CSSProperties } from "react";

import {
  deleteCustomTheme,
  listThemes,
  putCustomTheme,
  setActiveTheme,
  setColorMode
} from "../api/client";
import { queryKeys } from "../api/query-keys";
import {
  applyThemeTokens,
  deriveHeaderColors,
  deriveNavColors,
  isSolidThemeColor,
  isThemeColor,
  parsePalette,
  readCurrentAestheticTokens
} from "../theme/theme-runtime";
import type { AestheticThemeTokens } from "@moss/shared";
import { AESTHETIC_THEME_TOKEN_KEYS } from "@moss/shared";
import { useFeedback } from "./settings-feedback";
import {
  PREVIEW_PARTS,
  ThemeReadability,
  readabilityContrastRatio,
  ThemePreview,
  type EditorTokenKey,
  type PreviewPart
} from "./settings-theme-preview";
import { Field, Group, Note, PaneHead, Row } from "./settings-ui";
import { Badge, BrandMark, Button, Eyebrow, ColorBox, ColorPopover, Segmented } from "@moss/ui";
import { assistantName, personalize } from "../api/use-assistant-name.js";

interface DraftTheme {
  readonly id: string;
  readonly name: string;
  readonly tokens: AestheticThemeTokens;
}

interface SaveThemeDraftDeps {
  readonly putCustomTheme: typeof putCustomTheme;
  readonly setActiveTheme: typeof setActiveTheme;
}

/* Highlight and nav are optional in the contract. The editor shows these
   defaults until the user sets them: the built-in gold, and the pale nav the
   shell draws for a custom theme without a nav color. */
const DEFAULT_HIGHLIGHT = "#c2872b";
const DEFAULT_NAV = "#e7ebdf";
/* No default color for the header: unset, the strip follows the theme's page color. */

interface FieldSpec {
  readonly key: EditorTokenKey;
  readonly name: string;
  readonly desc: string;
  /** Line colors show a rule at this weight instead of a flat fill. */
  readonly rule?: string;
}

const FIELD_GROUPS: readonly {
  readonly title: string;
  readonly hint: string;
  readonly fields: readonly FieldSpec[];
}[] = [
  {
    title: "Page and cards",
    hint: "The page behind everything, then the cards and wells that sit on it.",
    fields: [
      { key: "paper", name: "Page", desc: "The paper behind every screen" },
      { key: "surface", name: "Card", desc: "Cards, menus and dialogs" },
      { key: "surface2", name: "Soft card", desc: "Quiet wells and inset blocks" },
      { key: "surface3", name: "Track", desc: "Switch tracks and progress bars" }
    ]
  },
  {
    title: "Text",
    hint: "Main and secondary text, followed by decorative ink. The checks use rendered semantic text roles.",
    fields: [
      { key: "ink", name: "Text", desc: "Headlines and body" },
      { key: "ink2", name: "Soft text", desc: "Descriptions and secondary lines" },
      {
        key: "ink3",
        name: "Faint ink",
        desc: "Decorative marks; faint text uses a separate semantic color"
      },
      {
        key: "ink4",
        name: "Quiet ink",
        desc: "Decorative marks and legacy surfaces; not every quiet-text role"
      }
    ]
  },
  {
    title: "Lines",
    hint: "Rules between rows and around cards, from barely there to firm.",
    fields: [
      { key: "lineSubtle", name: "Hairline", desc: "Between rows", rule: "1px" },
      { key: "line", name: "Line", desc: "Around cards and fields", rule: "1px" },
      { key: "lineStrong", name: "Firm line", desc: "Under the top bar, heavy rules", rule: "2px" }
    ]
  },
  {
    title: "Accent and highlight",
    hint: "The accent fills the Today band, buttons and the selected nav item. The highlight draws the rules under it, never text.",
    fields: [
      { key: "accent", name: "Accent", desc: "Buttons, links, the Today band" },
      { key: "highlight", name: "Highlight", desc: "Rules and markers only" }
    ]
  }
];

const NAV_FIELD: FieldSpec = {
  key: "nav",
  name: "Background",
  desc: "Behind the links, icons and the Moss mark"
};

const HEADER_FIELD: FieldSpec = {
  key: "header",
  name: "Background",
  desc: "Behind the page title, the date line and the settings cog"
};

/** Description of the navigation background field, using the current assistant name. */
export function navFieldDesc(): string {
  return personalize(NAV_FIELD.desc);
}

const FIELD_NAMES = Object.fromEntries(
  [...FIELD_GROUPS.flatMap((group) => group.fields), NAV_FIELD, HEADER_FIELD].map((field) => [
    field.key,
    field.name
  ])
) as Record<EditorTokenKey, string>;
/* Nav and header boxes are both labelled Background in their own groups. Pickers and errors
   name them in full so the two cannot be confused. */
FIELD_NAMES.nav = "Nav bar background";
FIELD_NAMES.header = "Page header background";

/* The nav derives its text contrast from its own ground, so it must be opaque. */
export function themeColorError(key: EditorTokenKey, value: string): string | null {
  if (!isThemeColor(value)) return "Use #rrggbb or rgb(r, g, b).";
  if (key === "nav" && !isSolidThemeColor(value)) {
    return "The nav needs a solid color. Use #rrggbb, rgb(r, g, b), or rgba with alpha 1.";
  }
  if (key === "header" && !isSolidThemeColor(value)) {
    return "The page header needs a solid color. Use #rrggbb, rgb(r, g, b), or rgba with alpha 1.";
  }
  return null;
}

type PickerState =
  | { readonly key: EditorTokenKey; readonly from: "box" }
  | {
      readonly key: EditorTokenKey;
      readonly from: "preview";
      readonly part: PreviewPart;
      readonly left: number;
      readonly top: number;
    };

const PICKER_WIDTH = 240;

export function AppearancePane() {
  const queryClient = useQueryClient();
  const { toast, confirm } = useFeedback();
  const themesQuery = useQuery({ queryKey: queryKeys.settings.themes, queryFn: listThemes });
  const [draft, setDraft] = useState<DraftTheme | null>(null);
  const [draftIsNew, setDraftIsNew] = useState(true);
  const [paletteText, setPaletteText] = useState("");
  const [picker, setPicker] = useState<PickerState | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [status, setStatus] = useState<string | null>(null);
  const sideRef = useRef<HTMLElement>(null);
  const previewAnchorRef = useRef<HTMLElement | null>(null);
  const activeId = themesQuery.data?.activeId ?? "light";
  const activeMode = themesQuery.data?.mode ?? "light";
  const activeIsBuiltIn = themesQuery.data?.builtIn.some((theme) => theme.id === activeId) ?? true;
  const palette = useMemo(() => parsePalette(paletteText), [paletteText]);

  const refreshThemes = async () => {
    await queryClient.invalidateQueries({ queryKey: queryKeys.settings.themes });
  };
  const activateMutation = useMutation({
    mutationFn: setActiveTheme,
    onSuccess: refreshThemes,
    onError: (err) => toast(readError(err))
  });
  const saveMutation = useMutation({
    mutationFn: (next: DraftTheme) => saveThemeDraft(next),
    onSuccess: async (response) => {
      setDraft(response.theme);
      setDraftIsNew(false);
      setStatus("Saved");
      await refreshThemes();
    },
    onError: (err) => setError(readError(err))
  });
  const deleteMutation = useMutation({
    mutationFn: deleteCustomTheme,
    onSuccess: async () => {
      closeEditor();
      await refreshThemes();
    },
    onError: (err) => toast(readError(err))
  });
  const modeMutation = useMutation({
    mutationFn: setColorMode,
    onSuccess: refreshThemes,
    onError: (err) => toast(readError(err))
  });

  const fieldValue = (key: EditorTokenKey): string => {
    if (!draft) return "";
    if (key === "highlight") return draft.tokens.highlight ?? DEFAULT_HIGHLIGHT;
    if (key === "nav") return draft.tokens.nav ?? DEFAULT_NAV;
    if (key === "header") return draft.tokens.header ?? draft.tokens.paper;
    return draft.tokens[key];
  };
  const updateToken = (key: EditorTokenKey, value: string) => {
    setDraft((current) =>
      current ? { ...current, tokens: { ...current.tokens, [key]: value } } : current
    );
    setStatus(null);
    setError(themeColorError(key, value));
  };
  const resetNav = () => {
    setDraft((current) => {
      if (!current) return current;
      const tokens = { ...current.tokens };
      delete tokens.nav;
      return { ...current, tokens };
    });
    setStatus(null);
  };
  const resetHeader = () => {
    setDraft((current) => {
      if (!current) return current;
      const tokens = { ...current.tokens };
      delete tokens.header;
      return { ...current, tokens };
    });
    setStatus(null);
  };
  const openEditor = (next: DraftTheme, isNew: boolean) => {
    setDraft({ ...next, tokens: { highlight: DEFAULT_HIGHLIGHT, ...next.tokens } });
    setDraftIsNew(isNew);
    setPaletteText("");
    setPicker(null);
    setError(null);
    setStatus(null);
  };
  const makeDraft = (name: string, tokens: AestheticThemeTokens) => {
    openEditor({ id: slugifyThemeId(name), name, tokens }, true);
  };
  const closeEditor = () => {
    setDraft(null);
    setPaletteText("");
    setPicker(null);
    setError(null);
    setStatus(null);
  };
  const saveDraft = () => {
    if (!draft) return;
    for (const key of [
      ...AESTHETIC_THEME_TOKEN_KEYS,
      "highlight" as const,
      "nav" as const,
      "header" as const
    ]) {
      const value = draft.tokens[key];
      const problem = value === undefined ? null : themeColorError(key, value);
      if (problem) {
        setError(`Check ${FIELD_NAMES[key]}. ${problem}`);
        return;
      }
    }
    saveMutation.mutate(draft);
  };
  const openFromPreview = (part: PreviewPart, anchor: HTMLElement) => {
    if (picker?.from === "preview" && picker.part === part) {
      setPicker(null);
      return;
    }
    const side = sideRef.current?.getBoundingClientRect();
    const box = anchor.getBoundingClientRect();
    if (!side) return;
    previewAnchorRef.current = anchor;
    setPicker({
      key: PREVIEW_PARTS[part].key,
      from: "preview",
      part,
      left: Math.max(0, Math.min(box.left - side.left, side.width - PICKER_WIDTH)),
      top: box.bottom - side.top + 8
    });
  };

  const builtIn = themesQuery.data?.builtIn ?? [];
  const custom = themesQuery.data?.custom ?? [];
  const navColors = draft ? deriveNavColors(fieldValue("nav"), draft.tokens.accent) : null;
  const headerColors = draft ? deriveHeaderColors(fieldValue("header")) : null;

  const colorBox = (field: FieldSpec) => (
    <span className="theme-field__control">
      <ColorBox
        label={field.name}
        value={fieldValue(field.key)}
        rule={field.rule}
        palette={palette}
        open={picker?.from === "box" && picker.key === field.key}
        onOpenChange={(open) => setPicker(open ? { key: field.key, from: "box" } : null)}
        onChange={(color) => updateToken(field.key, color)}
      />
      <input
        className="jds-input jds-input--sm theme-field__hex"
        value={fieldValue(field.key)}
        aria-label={`${field.name} value`}
        aria-invalid={!isThemeColor(fieldValue(field.key))}
        onChange={(event) => updateToken(field.key, event.target.value)}
      />
    </span>
  );

  return (
    <>
      <PaneHead
        title="Appearance"
        desc="Pick a color theme for this account, or build your own. Warning and error colors stay fixed so they always read correctly."
      />
      <Group
        title="Theme"
        desc="Built-in themes follow light or dark. Your own themes keep the colors you saved, nav bar included."
        action={
          <Button
            variant="secondary"
            size="sm"
            onClick={() =>
              makeDraft(
                "New theme",
                readCurrentAestheticTokens(getComputedStyle(document.documentElement))
              )
            }
            icon={<Plus size={15} aria-hidden="true" />}
          >
            New theme
          </Button>
        }
      >
        <Row
          name="Color mode"
          desc={
            activeIsBuiltIn
              ? "Applies to every built-in theme."
              : "Built-in themes only. Your own themes keep their saved colors in light mode."
          }
          control={
            <Segmented
              ariaLabel="Color mode"
              value={activeMode}
              onChange={(mode) => modeMutation.mutate({ mode })}
              options={(["light", "dark"] as const).map((mode) => ({
                value: mode,
                label: mode === "light" ? "Light" : "Dark",
                disabled: !activeIsBuiltIn || modeMutation.isPending
              }))}
            />
          }
        />

        <div className="theme-gallery">
          <Eyebrow as="div" className="theme-gallery__eyebrow">
            Built in
          </Eyebrow>
          <div className="theme-gallery__grid">
            {builtIn.map((theme) => (
              <ThemeCard
                key={theme.id}
                name={theme.name}
                active={activeId === theme.id}
                busy={activateMutation.isPending}
                preview={{ kind: "builtIn", id: theme.id, mode: activeMode }}
                onApply={() => activateMutation.mutate({ id: theme.id })}
                onDuplicate={() => makeDraft(`${theme.name} copy`, readBuiltInTokens(theme.id))}
              />
            ))}
          </div>

          <Eyebrow as="div" className="theme-gallery__eyebrow">
            Your themes
          </Eyebrow>
          {custom.length ? (
            <div className="theme-gallery__grid">
              {custom.map((theme) => (
                <ThemeCard
                  key={theme.id}
                  name={theme.name}
                  active={activeId === theme.id}
                  busy={activateMutation.isPending}
                  editing={draft?.id === theme.id && !draftIsNew}
                  preview={{ kind: "custom", tokens: theme.tokens }}
                  onApply={() => activateMutation.mutate({ id: theme.id })}
                  onEdit={() => openEditor(theme, false)}
                  onDuplicate={() => makeDraft(`${theme.name} copy`, theme.tokens)}
                  onDelete={() => {
                    confirm({
                      title: `Delete "${theme.name}"?`,
                      description: "This can't be undone.",
                      confirmLabel: "Delete theme",
                      danger: true,
                      onConfirm: () => deleteMutation.mutate(theme.id)
                    });
                  }}
                />
              ))}
            </div>
          ) : (
            <Note icon={<Palette size={13} aria-hidden="true" />}>
              No custom themes yet. Start from New theme, or duplicate a built-in one and change its
              colors.
            </Note>
          )}
        </div>
      </Group>

      {draft ? (
        <Group
          title={draftIsNew ? "New theme" : `Edit ${draft.name}`}
          desc="The preview changes as you type. Nothing is applied until you save."
        >
          <div className="theme-editor">
            <div className="theme-editor__form">
              <Field label="Name" className="theme-editor__name">
                <input
                  className="jds-input"
                  aria-label="Theme name"
                  value={draft.name}
                  onChange={(event) =>
                    setDraft({
                      ...draft,
                      name: event.target.value,
                      id: slugifyThemeId(event.target.value)
                    })
                  }
                />
              </Field>

              <section className="theme-fields">
                <h4 className="theme-fields__title">Paste a palette</h4>
                <p className="theme-fields__hint">
                  Paste colors from a palette tool. They show at the top of every color box below,
                  ready to pick.
                </p>
                <textarea
                  className="jds-textarea theme-palette__input"
                  aria-label="Paste palette"
                  placeholder="#541388 / #f038ff / rgb(56, 163, 165)"
                  value={paletteText}
                  onChange={(event) => setPaletteText(event.target.value)}
                />
                {palette.length ? (
                  <div className="theme-palette__found" aria-label="Colors found">
                    {palette.map((color) => (
                      <span
                        key={color}
                        className="jds-swatch"
                        title={color}
                        style={{ "--jds-swatch": color } as CSSProperties}
                      />
                    ))}
                  </div>
                ) : paletteText.trim() ? (
                  <p className="theme-fields__hint">
                    No colors found. Paste #rrggbb or rgb(r, g, b) values.
                  </p>
                ) : null}
              </section>

              {FIELD_GROUPS.map((group) => (
                <section className="theme-fields" key={group.title}>
                  <h4 className="theme-fields__title">{group.title}</h4>
                  <p className="theme-fields__hint">{group.hint}</p>
                  {group.fields.map((field) => (
                    <Row
                      key={field.key}
                      name={field.name}
                      desc={field.desc}
                      control={colorBox(field)}
                    />
                  ))}
                </section>
              ))}

              <section className="theme-fields">
                <h4 className="theme-fields__title">Nav bar</h4>
                <p className="theme-fields__hint">
                  The column of links down the left side. On a phone it also colors the top bar and
                  the menu. Text and icons pick dark or light by themselves.
                </p>
                <Row name={NAV_FIELD.name} desc={navFieldDesc()} control={colorBox(NAV_FIELD)} />
                <div
                  className="theme-navstrip"
                  style={(navColors?.vars ?? {}) as CSSProperties}
                  aria-hidden="true"
                >
                  <span className="theme-navstrip__brand">
                    <BrandMark size={18} />
                    {assistantName()}
                  </span>
                  <span className="theme-navstrip__link is-active">
                    <House size={15} />
                    Today
                  </span>
                  <span className="theme-navstrip__link">
                    <CheckSquare size={15} />
                    Tasks
                  </span>
                  <span className="theme-navstrip__link">
                    <CalendarDays size={15} />
                    Calendar
                  </span>
                </div>
                <div className="theme-navstrip__foot">
                  <p className="theme-fields__hint">
                    {draft.tokens.nav && navColors
                      ? `Text and icons switch to ${navColors.textKind} on this color. Labels read at ${navColors.textRatio.toFixed(1)} to 1, quieter links at ${navColors.mutedRatio.toFixed(1)} to 1. Both clear the 4.5 to 1 floor.${
                          navColors.strongText
                            ? ` This is a middle tone, so ${assistantName()} uses full ${navColors.textKind === "dark" ? "black" : "white"} text.`
                            : ""
                        }`
                      : "Using the default pale nav."}
                  </p>
                  <Button
                    variant="quiet"
                    size="sm"
                    disabled={draft.tokens.nav === undefined}
                    onClick={resetNav}
                  >
                    Reset to default
                  </Button>
                </div>
              </section>

              <section className="theme-fields">
                <h4 className="theme-fields__title">Page header</h4>
                <p className="theme-fields__hint">
                  The strip across the top of every page, with the page title, the date line and the
                  settings cog. It applies on a computer. On a phone the strip follows the Nav bar
                  color. Text picks dark or light by itself.
                </p>
                <Row
                  name={HEADER_FIELD.name}
                  desc={HEADER_FIELD.desc}
                  control={colorBox(HEADER_FIELD)}
                />
                <div
                  className="theme-headerstrip"
                  style={(headerColors?.vars ?? {}) as CSSProperties}
                  aria-hidden="true"
                >
                  <span className="theme-headerstrip__title">Today</span>
                  <span className="theme-headerstrip__date">Sunday, October 4</span>
                  <span className="theme-headerstrip__cog">
                    <Settings size={15} />
                  </span>
                </div>
                <div className="theme-navstrip__foot">
                  <p className="theme-fields__hint">
                    {draft.tokens.header && headerColors
                      ? `Text switches to ${headerColors.textKind} on this color. The title reads at ${headerColors.textRatio.toFixed(1)} to 1, the date and cog at ${headerColors.mutedRatio.toFixed(1)} to 1. Both clear the 4.5 to 1 floor.${
                          headerColors.strongText
                            ? ` This is a middle tone, so ${assistantName()} uses full ${headerColors.textKind === "dark" ? "black" : "white"} text.`
                            : ""
                        }`
                      : "Using the theme's page color."}
                  </p>
                  <Button
                    variant="quiet"
                    size="sm"
                    disabled={draft.tokens.header === undefined}
                    onClick={resetHeader}
                  >
                    Reset to default
                  </Button>
                </div>
              </section>
            </div>

            <aside className="theme-editor__side" ref={sideRef}>
              <ThemePreview
                themeId={draft.id}
                style={tokensToCssVars(draft.tokens)}
                openPart={picker?.from === "preview" ? picker.part : null}
                onPick={openFromPreview}
              />
              {picker?.from === "preview" ? (
                <ColorPopover
                  title={FIELD_NAMES[picker.key]}
                  value={toHexInput(fieldValue(picker.key))}
                  palette={palette}
                  anchorRef={previewAnchorRef}
                  style={{ left: picker.left, top: picker.top }}
                  onClose={() => setPicker(null)}
                  onPick={(color) => {
                    updateToken(picker.key, color);
                    setPicker(null);
                  }}
                  onInput={(color) => updateToken(picker.key, color)}
                />
              ) : null}
              <ThemeReadability themeId={draft.id} style={tokensToCssVars(draft.tokens)} />
            </aside>
          </div>

          <div className="theme-editor__foot">
            <div className="theme-editor__status">
              {error ? <Note>{error}</Note> : null}
              {status ? <Badge tone="forest">{status}</Badge> : null}
            </div>
            <div className="theme-editor__buttons">
              <Button
                variant="quiet"
                size="sm"
                onClick={closeEditor}
                icon={<X size={15} aria-hidden="true" />}
              >
                Cancel
              </Button>
              <Button
                size="sm"
                disabled={saveMutation.isPending}
                onClick={saveDraft}
                icon={<Save size={15} aria-hidden="true" />}
              >
                {draftIsNew ? "Save theme" : "Save changes"}
              </Button>
            </div>
          </div>
        </Group>
      ) : null}
    </>
  );
}

export async function saveThemeDraft(
  draft: DraftTheme,
  deps: SaveThemeDraftDeps = { putCustomTheme, setActiveTheme }
) {
  const response = await deps.putCustomTheme(draft.id, { name: draft.name, tokens: draft.tokens });
  await deps.setActiveTheme({ id: response.theme.id });
  return response;
}

type ThemePreviewSource =
  | { readonly kind: "builtIn"; readonly id: string; readonly mode: "light" | "dark" }
  | { readonly kind: "custom"; readonly tokens: AestheticThemeTokens };

function ThemeCard(props: {
  readonly name: string;
  readonly active: boolean;
  readonly busy: boolean;
  readonly editing?: boolean;
  readonly preview: ThemePreviewSource;
  readonly onApply: () => void;
  readonly onEdit?: () => void;
  readonly onDuplicate: () => void;
  readonly onDelete?: () => void;
}) {
  const classes = ["theme-card"];
  if (props.active) classes.push("is-active");
  if (props.editing) classes.push("is-editing");
  return (
    <article className={classes.join(" ")} aria-current={props.active ? "true" : undefined}>
      <ThemeThumb source={props.preview} />
      <div className="theme-card__head">
        <span className="theme-card__name">{props.name}</span>
        {props.active ? (
          <Badge tone="forest">
            <Check size={12} aria-hidden="true" /> Current
          </Badge>
        ) : null}
      </div>
      <div className="theme-card__actions">
        {props.active ? null : (
          <Button variant="secondary" size="sm" disabled={props.busy} onClick={props.onApply}>
            Apply
          </Button>
        )}
        {props.onEdit ? (
          <Button
            variant="quiet"
            size="sm"
            onClick={props.onEdit}
            icon={<PencilLine size={14} aria-hidden="true" />}
          >
            Edit
          </Button>
        ) : null}
        <Button
          variant="quiet"
          size="sm"
          onClick={props.onDuplicate}
          icon={<Copy size={14} aria-hidden="true" />}
        >
          Duplicate
        </Button>
        {props.onDelete ? (
          <Button
            variant="quiet"
            size="sm"
            onClick={props.onDelete}
            icon={<Trash2 size={14} aria-hidden="true" />}
          >
            Delete
          </Button>
        ) : null}
      </div>
    </article>
  );
}

/* A miniature Moss screen: nav column with the selected item, a Today band
   with its highlight rule, and rows. Built-in themes resolve their colors
   through the theme attributes; custom themes inject their saved tokens. */
function ThemeThumb(props: { readonly source: ThemePreviewSource }) {
  const attrs =
    props.source.kind === "builtIn"
      ? { "data-theme": props.source.id, "data-color-mode": props.source.mode }
      : { style: tokensToCssVars(props.source.tokens) };
  return (
    <div className="theme-thumb" aria-hidden="true" {...attrs}>
      <span className="theme-thumb__nav">
        <i />
        <i className="is-active" />
        <i />
        <i />
      </span>
      <span className="theme-thumb__body">
        <span className="theme-thumb__band" />
        <span className="theme-thumb__rows">
          <i />
          <i />
          <i />
        </span>
      </span>
    </div>
  );
}

export function slugifyThemeId(name: string): string {
  const slug = name
    .trim()
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, "-")
    .replace(/^-+|-+$/g, "")
    .slice(0, 80);
  return slug || `theme-${Date.now().toString(36)}`;
}

export function tokensToCssVars(tokens: AestheticThemeTokens): Record<string, string> {
  const style = memoryStyle();
  applyThemeTokens(style, tokens);
  return Object.fromEntries(style.values);
}

export function contrastRatio(a: string, b: string): number {
  return readabilityContrastRatio(a, b) ?? 1;
}

function readBuiltInTokens(id: string): AestheticThemeTokens {
  const probe = document.createElement("div");
  probe.setAttribute("data-theme", id);
  document.body.appendChild(probe);
  try {
    return readCurrentAestheticTokens(getComputedStyle(probe));
  } finally {
    probe.remove();
  }
}

function toHexInput(value: string): string {
  const rgb = parseRgb(value);
  return rgb ? rgbToHex(rgb) : "#000000";
}

function readError(error: unknown): string {
  return error instanceof Error ? error.message : "Theme update failed";
}

function memoryStyle() {
  const values = new Map<string, string>();
  return {
    values,
    setProperty: (name: string, value: string) => values.set(name, value),
    removeProperty: (name: string) => {
      values.delete(name);
      return "";
    },
    getPropertyValue: (name: string) => values.get(name) ?? ""
  };
}

interface Rgb {
  readonly r: number;
  readonly g: number;
  readonly b: number;
}

function parseRgb(value: string): Rgb | null {
  const hex = /^#([0-9a-fA-F]{6})$/.exec(value.trim());
  if (hex) {
    const raw = hex[1]!;
    return {
      r: parseInt(raw.slice(0, 2), 16),
      g: parseInt(raw.slice(2, 4), 16),
      b: parseInt(raw.slice(4, 6), 16)
    };
  }
  const rgb = /^rgba?\((\d{1,3}),\s*(\d{1,3}),\s*(\d{1,3})(?:,\s*[\d.]+)?\)$/.exec(value.trim());
  if (!rgb) return null;
  const channels = rgb.slice(1).map(Number);
  if (channels.some((channel) => channel < 0 || channel > 255)) return null;
  return { r: channels[0]!, g: channels[1]!, b: channels[2]! };
}

function rgbToHex(rgb: Rgb): string {
  return `#${toHex(rgb.r)}${toHex(rgb.g)}${toHex(rgb.b)}`;
}

function toHex(value: number): string {
  return value.toString(16).padStart(2, "0");
}
