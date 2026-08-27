import { useMutation, useQuery, useQueryClient } from "@tanstack/react-query";
import { Copy, Palette, Plus, Save, Trash2 } from "lucide-react";
import { useMemo, useState } from "react";

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
  deriveAccentRamp,
  isThemeColor,
  parsePalette,
  readCurrentAestheticTokens
} from "../theme/theme-runtime";
import type { AestheticThemeTokenKey, AestheticThemeTokens } from "@moss/shared";
import { AESTHETIC_THEME_TOKEN_KEYS } from "@moss/shared";
import { useFeedback } from "./settings-feedback";
import { Badge, Field, Group, Note, PaneHead } from "./settings-ui";
import { Button, Segmented } from "@moss/ui";

interface DraftTheme {
  readonly id: string;
  readonly name: string;
  readonly tokens: AestheticThemeTokens;
}

interface SaveThemeDraftDeps {
  readonly putCustomTheme: typeof putCustomTheme;
  readonly setActiveTheme: typeof setActiveTheme;
}

type EditorTokenKey = AestheticThemeTokenKey | "gold";

/* Gold is optional in the contract: themes saved without it keep the built-in
   constant, so the editor seeds a default instead of requiring a value. */
const DEFAULT_GOLD = "#c2872b";
const EDITOR_TOKEN_KEYS: readonly EditorTokenKey[] = [...AESTHETIC_THEME_TOKEN_KEYS, "gold"];

const TOKEN_LABELS: Record<EditorTokenKey, string> = {
  paper: "Paper",
  surface: "Surface",
  surface2: "Surface soft",
  surface3: "Surface track",
  ink: "Ink",
  ink2: "Ink soft",
  ink3: "Ink faint",
  ink4: "Ink quiet",
  line: "Line",
  lineSubtle: "Line soft",
  lineStrong: "Line strong",
  accent: "Accent",
  gold: "Gold (decorative)"
};

export function AppearancePane() {
  const queryClient = useQueryClient();
  const { toast } = useFeedback();
  const themesQuery = useQuery({ queryKey: queryKeys.settings.themes, queryFn: listThemes });
  const [draft, setDraft] = useState<DraftTheme | null>(null);
  const [selectedSlot, setSelectedSlot] = useState<EditorTokenKey>("accent");
  const [paletteText, setPaletteText] = useState("");
  const [staged, setStaged] = useState<readonly string[]>([]);
  const [error, setError] = useState<string | null>(null);
  const [status, setStatus] = useState<string | null>(null);
  const activeId = themesQuery.data?.activeId ?? "light";
  const activeMode = themesQuery.data?.mode ?? "light";
  const activeIsBuiltIn = themesQuery.data?.builtIn.some((theme) => theme.id === activeId) ?? true;

  const refreshThemes = async () => {
    await queryClient.invalidateQueries({ queryKey: queryKeys.settings.themes });
  };
  const activateMutation = useMutation({
    mutationFn: setActiveTheme,
    onSuccess: refreshThemes,
    onError: (err) => setError(readError(err))
  });
  const saveMutation = useMutation({
    mutationFn: (next: DraftTheme) => saveThemeDraft(next),
    onSuccess: async (response) => {
      setDraft(response.theme);
      setStatus("Saved");
      await refreshThemes();
    },
    onError: (err) => setError(readError(err))
  });
  const deleteMutation = useMutation({
    mutationFn: deleteCustomTheme,
    onSuccess: async () => {
      setDraft(null);
      await refreshThemes();
    },
    onError: (err) => toast(readError(err))
  });
  const modeMutation = useMutation({
    mutationFn: setColorMode,
    onSuccess: refreshThemes,
    onError: (err) => setError(readError(err))
  });

  const contrastWarnings = useMemo(() => {
    if (!draft) return [];
    return [
      ["Ink on paper", contrastRatio(draft.tokens.ink, draft.tokens.paper)],
      ["Accent on paper", contrastRatio(draft.tokens.accent, draft.tokens.paper)],
      ["Paper on accent", contrastRatio(draft.tokens.paper, draft.tokens.accent)]
    ].flatMap(([label, ratio]) =>
      typeof ratio === "number" && ratio < 4.5 ? [`${label} ${ratio.toFixed(2)}:1`] : []
    );
  }, [draft]);

  const goldWarning = useMemo(() => {
    if (!draft?.tokens.gold) return null;
    const ratio = contrastRatio(draft.tokens.gold, draft.tokens.paper);
    return ratio < 3
      ? `Gold on paper ${ratio.toFixed(2)}:1 — gold is decorative; aim for at least 3:1 on paper.`
      : null;
  }, [draft]);

  const updateToken = (key: EditorTokenKey, value: string) => {
    setDraft((current) =>
      current ? { ...current, tokens: { ...current.tokens, [key]: value } } : current
    );
    setError(isThemeColor(value) ? null : "Use #rrggbb or rgb(r, g, b).");
  };
  const makeDraft = (name: string, tokens: AestheticThemeTokens) => {
    setDraft({ id: slugifyThemeId(name), name, tokens: { gold: DEFAULT_GOLD, ...tokens } });
    setSelectedSlot("accent");
    setError(null);
    setStatus(null);
  };
  const saveDraft = () => {
    if (!draft) return;
    const invalid = AESTHETIC_THEME_TOKEN_KEYS.find((key) => !isThemeColor(draft.tokens[key]));
    if (invalid) {
      setError(`${TOKEN_LABELS[invalid]} must be #rrggbb or rgb(r, g, b).`);
      return;
    }
    if (draft.tokens.gold !== undefined && !isThemeColor(draft.tokens.gold)) {
      setError(`${TOKEN_LABELS.gold} must be #rrggbb or rgb(r, g, b).`);
      return;
    }
    saveMutation.mutate(draft);
  };

  return (
    <>
      <PaneHead
        title="Appearance"
        desc="Saved color themes for this account. Semantic warning and error colors stay locked."
      />
      <Group
        title="Themes"
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
        <div className="appearance-theme-mode">
          <Segmented
            ariaLabel="Color mode"
            value={activeMode}
            onChange={(mode) => modeMutation.mutate({ mode })}
            options={(["light", "dark"] as const).map((mode) => ({
              value: mode,
              label: mode === "light" ? "Light" : "Dark",
              disabled: !activeIsBuiltIn || modeMutation.isPending,
              title: activeIsBuiltIn
                ? undefined
                : "Custom themes use their saved fixed palette and do not support color mode."
            }))}
          />
        </div>
        {!activeIsBuiltIn ? (
          <Note>Custom themes use their saved fixed palette, so color mode is unavailable.</Note>
        ) : null}
        <div className="theme-list">
          {themesQuery.data?.builtIn.map((theme) => (
            <ThemeRow
              key={theme.id}
              name={theme.name}
              active={activeId === theme.id}
              onSelect={() => activateMutation.mutate({ id: theme.id })}
              onDuplicate={() => makeDraft(`${theme.name} copy`, readBuiltInTokens(theme.id))}
            />
          ))}
          {themesQuery.data?.custom.map((theme) => (
            <ThemeRow
              key={theme.id}
              name={theme.name}
              active={activeId === theme.id}
              onSelect={() => {
                activateMutation.mutate({ id: theme.id });
                setDraft(theme);
              }}
              onDuplicate={() => makeDraft(`${theme.name} copy`, theme.tokens)}
              onDelete={() => {
                if (window.confirm(`Delete "${theme.name}"? This can't be undone.`)) {
                  deleteMutation.mutate(theme.id);
                }
              }}
            />
          ))}
        </div>
      </Group>

      {draft ? (
        <Group
          title="Editor"
          action={
            <Button
              size="sm"
              disabled={saveMutation.isPending}
              onClick={saveDraft}
              icon={<Save size={15} aria-hidden="true" />}
            >
              Save
            </Button>
          }
        >
          <div className="theme-editor">
            <Field label="Name">
              <input
                className="jds-input"
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
            <div className="theme-token-grid">
              {EDITOR_TOKEN_KEYS.map((key) => {
                const value = draft.tokens[key] ?? DEFAULT_GOLD;
                return (
                  <label
                    className={`theme-token ${selectedSlot === key ? "is-selected" : ""}`}
                    key={key}
                  >
                    <span className="theme-token__label">{TOKEN_LABELS[key]}</span>
                    <span className="theme-token__controls">
                      <input
                        aria-label={`${TOKEN_LABELS[key]} color picker`}
                        type="color"
                        value={toHexInput(value)}
                        onFocus={() => setSelectedSlot(key)}
                        onChange={(event) => updateToken(key, event.target.value)}
                      />
                      <input
                        className="jds-input jds-input--sm"
                        value={value}
                        aria-invalid={!isThemeColor(value)}
                        onFocus={() => setSelectedSlot(key)}
                        onChange={(event) => updateToken(key, event.target.value)}
                      />
                    </span>
                  </label>
                );
              })}
            </div>
            <div className="theme-ramp" aria-label="Generated accent ramp">
              {Object.entries(deriveAccentRamp(draft.tokens.accent, draft.tokens.paper)).map(
                ([name, value]) => (
                  <span className="theme-ramp__item" key={name}>
                    <span
                      className="theme-swatch"
                      style={{ "--st-swatch": value } as React.CSSProperties}
                    />
                    <span>{name.replace("--", "")}</span>
                  </span>
                )
              )}
            </div>
            <Field label="Paste palette">
              <textarea
                className="jds-textarea"
                value={paletteText}
                onChange={(event) => {
                  const text = event.target.value;
                  setPaletteText(text);
                  const colors = parsePalette(text);
                  setStaged(colors);
                  if (colors.length > 0) setError(null);
                }}
                onPaste={(event) => {
                  const pasted = event.clipboardData.getData("text");
                  if (pasted.trim().length > 0 && parsePalette(pasted).length === 0) {
                    setError("Paste #rrggbb or rgb(r, g, b) values.");
                  }
                }}
              />
            </Field>
            {staged.length ? (
              <div className="theme-staged" aria-label="Staged palette">
                {staged.map((color) => (
                  <button
                    className="theme-swatch"
                    key={color}
                    type="button"
                    style={{ "--st-swatch": color } as React.CSSProperties}
                    title={`Assign ${color} to ${TOKEN_LABELS[selectedSlot]}`}
                    onClick={() => updateToken(selectedSlot, color)}
                  />
                ))}
              </div>
            ) : null}
            <div className="theme-preview" style={tokensToCssVars(draft.tokens)}>
              <div className="theme-preview__eyebrow">Preview</div>
              <h3>Daily plan</h3>
              <p>Paper, ink, line, and accent update here before saving.</p>
              <Button size="sm">Primary action</Button>
            </div>
            {contrastWarnings.length ? (
              <Note icon={<Palette size={13} aria-hidden="true" />}>
                Low contrast: {contrastWarnings.join(", ")}. Save is allowed.
              </Note>
            ) : null}
            {goldWarning ? (
              <Note icon={<Palette size={13} aria-hidden="true" />}>{goldWarning}</Note>
            ) : null}
            {error ? <Note>{error}</Note> : null}
            {status ? <Badge tone="forest">{status}</Badge> : null}
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

function ThemeRow(props: {
  readonly name: string;
  readonly active: boolean;
  readonly readonlyLabel?: string;
  readonly onSelect: () => void;
  readonly onDuplicate: () => void;
  readonly onDelete?: () => void;
}) {
  return (
    <div className={`theme-row ${props.active ? "is-active" : ""}`}>
      <button type="button" className="theme-row__select" onClick={props.onSelect}>
        <span>{props.name}</span>
        {props.active ? <Badge tone="forest">Active</Badge> : null}
        {props.readonlyLabel ? <Badge tone="neutral">{props.readonlyLabel}</Badge> : null}
      </button>
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
  const left = parseRgb(a);
  const right = parseRgb(b);
  if (!left || !right) return 1;
  const l1 = relativeLuminance(left);
  const l2 = relativeLuminance(right);
  return Number(((Math.max(l1, l2) + 0.05) / (Math.min(l1, l2) + 0.05)).toFixed(2));
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

function relativeLuminance(rgb: Rgb): number {
  const [r, g, b] = [rgb.r, rgb.g, rgb.b].map((channel) => {
    const c = channel / 255;
    return c <= 0.03928 ? c / 12.92 : ((c + 0.055) / 1.055) ** 2.4;
  });
  return 0.2126 * r! + 0.7152 * g! + 0.0722 * b!;
}

function rgbToHex(rgb: Rgb): string {
  return `#${toHex(rgb.r)}${toHex(rgb.g)}${toHex(rgb.b)}`;
}

function toHex(value: number): string {
  return value.toString(16).padStart(2, "0");
}
