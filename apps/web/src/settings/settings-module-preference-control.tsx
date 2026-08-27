// apps/web/src/settings/settings-module-preference-control.tsx
//
// #1757: the control the host draws for one declared module setting. Split out of
// settings-module-preferences.tsx because a number needs local draft state and a switch does
// not — the module still declares and the host still renders, which is the whole point of the
// declaration schema; only the widget varies.
import { useEffect, useState } from "react";

import type { ModulePreferenceDto } from "@moss/shared";

import { Switch } from "./settings-ui";

export function ModulePreferenceControl(props: {
  readonly preference: ModulePreferenceDto;
  readonly disabled: boolean;
  readonly onChange: (value: boolean | number | null) => void;
}) {
  if (props.preference.type === "boolean") {
    return (
      <Switch
        ariaLabel={props.preference.label}
        checked={props.preference.value === true}
        disabled={props.disabled}
        onChange={props.onChange}
      />
    );
  }
  return <IntegerControl {...props} />;
}

function IntegerControl(props: {
  readonly preference: ModulePreferenceDto;
  readonly disabled: boolean;
  readonly onChange: (value: number | null) => void;
}) {
  const { preference } = props;
  const serverValue = typeof preference.value === "number" ? preference.value : null;
  const [draft, setDraft] = useState(serverValue === null ? "" : String(serverValue));
  // The server's value is the only source of truth for what is stored; the draft exists purely
  // so typing "15" does not fire a write at "1". Resync when the saved value actually moves,
  // which is also how a rejected write puts the old number back in the box.
  useEffect(() => {
    setDraft(serverValue === null ? "" : String(serverValue));
  }, [serverValue]);

  // A blank box means "no number" and is only offered where the manifest said unset is a real
  // end state. Where it is not, blanking the box reverts rather than writing something arbitrary.
  const clearable = preference.default === null;

  const commit = (): void => {
    const trimmed = draft.trim();
    if (trimmed === "") {
      if (clearable && serverValue !== null) props.onChange(null);
      else setDraft(serverValue === null ? "" : String(serverValue));
      return;
    }
    const parsed = Number(trimmed);
    if (!Number.isSafeInteger(parsed)) {
      setDraft(serverValue === null ? "" : String(serverValue));
      return;
    }
    // Clamp rather than reject: the bounds came from the manifest, so the nearest legal number
    // is a better answer than silently discarding what the user typed.
    const lower = preference.min ?? Number.MIN_SAFE_INTEGER;
    const upper = preference.max ?? Number.MAX_SAFE_INTEGER;
    const clamped = Math.min(Math.max(parsed, lower), upper);
    setDraft(String(clamped));
    if (clamped !== serverValue) props.onChange(clamped);
  };

  return (
    <input
      className="jds-input jds-input--sm jds-input--num"
      type="number"
      inputMode="numeric"
      aria-label={preference.label}
      value={draft}
      disabled={props.disabled}
      {...(preference.min !== null ? { min: preference.min } : {})}
      {...(preference.max !== null ? { max: preference.max } : {})}
      placeholder={clearable ? "Not set" : ""}
      onChange={(event) => setDraft(event.target.value)}
      onBlur={commit}
      onKeyDown={(event) => {
        if (event.key === "Enter") event.currentTarget.blur();
      }}
    />
  );
}
