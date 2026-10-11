// external-modules/finance/src/web/screens/settings.tsx
//
// #3186: Finance Settings. How much Moss does alone (preset or custom), the dollar limit,
// per-action switches, the admin-only bank keys and the activity list with Undo.
//
// Every control saves at once and reverts with an inline error when the save fails.
// Activity rows come from finance.activity.list; Undo runs the finance.activity-undo queue
// and then refetches until the row shows as undone.
import {
  Badge,
  Button,
  DisclosureToggle,
  Eyebrow,
  Field,
  FormLabel,
  Indicator,
  Masthead,
  RadioCardGroup,
  SectionHead,
  Switch,
  useEffect,
  useRef,
  useState,
  type ReactNodeLike
} from "@moss/module-web-sdk";
import { runWrite } from "../api";
import {
  detectStep,
  fetchKeySlots,
  fetchLimit,
  fetchTiers,
  parseLimit,
  saveKey,
  saveLimit,
  setFamilyTier,
  setStep,
  tiersForStep,
  type KeySlot,
  type Step,
  type TaggedFamily,
  type Tiers
} from "../settings-api";
import { announce, outcomeGate } from "../states";
import { invalidateQueries, useToolQuery } from "../store";

const FAMILY_ROWS: Array<{ id: TaggedFamily; label: string }> = [
  { id: "sorting", label: "Sort purchases from merchants you've seen" },
  { id: "moving_money", label: "Move money between categories" },
  { id: "sorting_new", label: "Sort purchases from new merchants" },
  { id: "rules", label: "Make merchant rules" },
  { id: "categories", label: "Add, rename or archive categories" }
];

const STEP_OPTIONS = [
  {
    value: "ask" as const,
    label: "Ask about everything",
    description: "Moss suggests every change for you to approve."
  },
  {
    value: "routine" as const,
    label: "Handle routine, ask about new",
    description:
      "Moss sorts merchants it knows and moves money up to your limit. It asks about anything new."
  },
  {
    value: "all" as const,
    label: "Run it all, review weekly",
    description: "Moss handles everything up to your limit. You look over its week."
  },
  {
    value: "custom" as const,
    label: "Custom",
    description: "You choose, action by action."
  }
];

function RailBlock(props: {
  eyebrow: string;
  title: string;
  children: ReactNodeLike;
}): ReactNodeLike {
  return (
    <section className="fnm-block fnm-block--tight">
      <div className="fnm-block fnm-block--tiny">
        <Eyebrow tone="gold">{props.eyebrow}</Eyebrow>
        <SectionHead title={props.title} rule />
      </div>
      {props.children}
    </section>
  );
}

function InlineError(props: { message: string | null }): ReactNodeLike {
  return props.message ? (
    <p className="jds-hint jds-hint--error" role="alert">
      {props.message}
    </p>
  ) : null;
}

// ---- Activity ----

interface ActivityRow {
  id: string;
  at: string;
  actor: string;
  summary: string;
  undone: boolean;
  undoable: boolean;
}

interface ActivityResult extends Record<string, unknown> {
  activity?: ActivityRow[];
}

const WEEK_MS = 7 * 24 * 60 * 60 * 1000;
const UNDO_CHECKS_MS = [2000, 4000, 8000];

function whenLabel(iso: string): string {
  const date = new Date(iso);
  return date.toLocaleString(undefined, {
    month: "short",
    day: "numeric",
    hour: "numeric",
    minute: "2-digit"
  });
}

function ActivityRows(props: { rows: ActivityRow[] }): ReactNodeLike {
  const [errors, setErrors] = useState<Record<string, string>>({});
  const [busy, setBusy] = useState<Record<string, boolean>>({});
  const latest = useRef(props.rows);
  latest.current = props.rows;

  const settle = (id: string, attempt: number): void => {
    setTimeout(() => {
      if (latest.current.find((row) => row.id === id)?.undone) {
        setBusy((previous) => ({ ...previous, [id]: false }));
        return;
      }
      if (attempt >= UNDO_CHECKS_MS.length) {
        setBusy((previous) => ({ ...previous, [id]: false }));
        setErrors((previous) => ({
          ...previous,
          [id]: "Couldn't undo that. It may have changed since."
        }));
        announce("Couldn't undo that.");
        return;
      }
      invalidateQueries();
      settle(id, attempt + 1);
    }, UNDO_CHECKS_MS[attempt]);
  };

  const onUndo = (row: ActivityRow): void => {
    setErrors((previous) => ({ ...previous, [row.id]: "" }));
    setBusy((previous) => ({ ...previous, [row.id]: true }));
    void runWrite("finance.activity-undo", "finance.activity-undo", { activityId: row.id }).then(
      (outcome) => {
        if (outcome.kind === "queued") {
          settle(row.id, 0);
          return;
        }
        setBusy((previous) => ({ ...previous, [row.id]: false }));
        setErrors((previous) => ({ ...previous, [row.id]: "Couldn't undo that. Try again." }));
        announce("Couldn't undo that.");
      }
    );
  };

  return (
    <div>
      {props.rows.map((row) => (
        <div key={row.id} className="fnm-switch-row">
          <div className="fnm-switch-text">
            <span>{row.summary}</span>
            <span className="jds-hint">
              {row.actor === "moss" ? "Moss" : "You"} · {whenLabel(row.at)}
              {row.undone ? " · Undone" : ""}
            </span>
            <InlineError message={errors[row.id] || null} />
          </div>
          {row.undoable ? (
            <Button
              variant="quiet"
              size="sm"
              disabled={busy[row.id] === true}
              onClick={() => onUndo(row)}
            >
              Undo
            </Button>
          ) : null}
        </div>
      ))}
    </div>
  );
}

function ActivityWindow(props: { from: string; to: string; emptyText: string }): ReactNodeLike {
  const query = useToolQuery<ActivityResult>("finance.activity.list", {
    from: props.from,
    to: props.to
  });
  return outcomeGate(
    query,
    (result) => {
      const rows = result.activity ?? [];
      if (rows.length === 0) return <p className="jds-hint">{props.emptyText}</p>;
      return <ActivityRows rows={rows} />;
    },
    { loadingLabel: "Loading activity" }
  );
}

function ActivityBlock(): ReactNodeLike {
  const [now] = useState(() => Date.now());
  const [weeks, setWeeks] = useState(1);
  const windows = [];
  for (let k = 0; k < weeks; k += 1) {
    windows.push(
      <ActivityWindow
        key={k}
        from={new Date(now - (k + 1) * WEEK_MS).toISOString()}
        to={new Date(now - k * WEEK_MS).toISOString()}
        emptyText={k === 0 ? "Nothing yet." : "Nothing in this week."}
      />
    );
  }
  return (
    <RailBlock eyebrow="Activity" title="This week">
      {windows}
      <div>
        <Button variant="secondary" size="sm" onClick={() => setWeeks(weeks + 1)}>
          Earlier weeks
        </Button>
      </div>
    </RailBlock>
  );
}

// ---- Bank keys ----

function KeyRow(props: { slot: KeySlot; onSaved: () => void }): ReactNodeLike {
  const [editing, setEditing] = useState(false);
  const [value, setValue] = useState("");
  const [error, setError] = useState<string | null>(null);
  const [saving, setSaving] = useState(false);
  const id = `fnm-key-${props.slot.credentialId}`;

  const onSave = (): void => {
    if (value.trim() === "") return;
    setSaving(true);
    setError(null);
    void saveKey(props.slot.credentialId, value.trim()).then((ok) => {
      setSaving(false);
      if (!ok) {
        setError("Couldn't save that. The old value is still in place.");
        announce("Couldn't save the key.");
        return;
      }
      setValue("");
      setEditing(false);
      props.onSaved();
    });
  };

  return (
    <div className="fnm-switch-row">
      <div className="fnm-switch-text">
        <span>{props.slot.displayName}</span>
        {editing ? (
          <Field>
            <FormLabel htmlFor={id}>New value for {props.slot.displayName}</FormLabel>
            <input
              id={id}
              className="jds-input fnm-limit"
              type="password"
              autoComplete="off"
              value={value}
              onChange={(event) => setValue(event.target.value)}
            />
          </Field>
        ) : null}
        <InlineError message={error} />
      </div>
      {editing ? (
        <div className="fnm-row">
          <Button variant="secondary" size="sm" disabled={saving} onClick={onSave}>
            Save
          </Button>
          <Button
            variant="quiet"
            size="sm"
            disabled={saving}
            onClick={() => {
              setEditing(false);
              setValue("");
              setError(null);
            }}
          >
            Cancel
          </Button>
        </div>
      ) : (
        <div className="fnm-row">
          {props.slot.configured ? (
            <Indicator status="ready" label="Saved" />
          ) : (
            <Indicator status="idle" label="Not set" />
          )}
          <Button variant="secondary" size="sm" onClick={() => setEditing(true)}>
            {props.slot.configured ? "Replace" : "Add"}
          </Button>
        </div>
      )}
    </div>
  );
}

function BankKeys(): ReactNodeLike {
  const [slots, setSlots] = useState<KeySlot[] | null>(null);
  const reload = (): void => {
    void fetchKeySlots().then(setSlots);
  };
  useEffect(reload, []);
  if (slots === null) return null;
  return (
    <section className="fnm-block fnm-block--tight">
      <SectionHead title="Bank connection" meta="Admins only" rule />
      <div>
        {slots.map((slot) => (
          <KeyRow key={slot.credentialId} slot={slot} onSaved={reload} />
        ))}
      </div>
    </section>
  );
}

// ---- Screen ----

export function SettingsScreen(): ReactNodeLike {
  const [tiers, setTiers] = useState<Tiers>(tiersForStep("routine"));
  const [loaded, setLoaded] = useState(false);
  const [loading, setLoading] = useState(true);
  const [loadFailed, setLoadFailed] = useState(false);
  const [limitLoadFailed, setLimitLoadFailed] = useState(false);
  const [loadAttempt, setLoadAttempt] = useState(0);
  const [forceCustom, setForceCustom] = useState(false);
  const [userOpen, setUserOpen] = useState<boolean | null>(null);
  const [stepError, setStepError] = useState<string | null>(null);
  const [familyError, setFamilyError] = useState<string | null>(null);
  const [limit, setLimit] = useState("");
  const [savedLimit, setSavedLimit] = useState<number | null>(null);
  const [limitError, setLimitError] = useState<string | null>(null);

  useEffect(() => {
    let current = true;
    void Promise.all([fetchTiers(), fetchLimit()]).then(([foundTiers, foundLimit]) => {
      if (!current) return;
      if (foundTiers !== null) {
        setTiers(foundTiers);
        setLoaded(true);
      }
      if (foundLimit !== null) {
        setSavedLimit(foundLimit);
        setLimit(`$${foundLimit}`);
      }
      setLoadFailed(foundTiers === null);
      setLimitLoadFailed(foundLimit === null);
      setLoading(false);
    });
    return () => {
      current = false;
    };
  }, [loadAttempt]);

  const settingsReady = !loading && !loadFailed && !limitLoadFailed;
  const retrySettings = (): void => {
    setLoading(true);
    setLoadAttempt((attempt) => attempt + 1);
  };

  const detected = detectStep(tiers);
  const value = forceCustom ? "custom" : detected;
  const open = userOpen ?? value === "custom";

  const onStep = (next: Step | "custom"): void => {
    if (!settingsReady) return;
    setStepError(null);
    if (next === "custom") {
      setForceCustom(true);
      setUserOpen(true);
      return;
    }
    const before = tiers;
    const beforeForce = forceCustom;
    setForceCustom(false);
    setTiers(tiersForStep(next));
    void setStep(next).then((ok) => {
      if (ok) return;
      setTiers(before);
      setForceCustom(beforeForce);
      setStepError("Couldn't save that. Put back to the earlier choice.");
      announce("Couldn't save that choice.");
    });
  };

  const onFamily = (family: TaggedFamily, on: boolean): void => {
    if (!settingsReady) return;
    setFamilyError(null);
    const before = tiers[family];
    const tier = on ? "trusted_auto" : "ask_each_time";
    setTiers((previous) => ({ ...previous, [family]: tier }));
    void setFamilyTier(family, tier).then((ok) => {
      if (ok) return;
      setTiers((previous) => ({ ...previous, [family]: before }));
      setFamilyError("Couldn't save that switch. Put back to how it was.");
      announce("Couldn't save that switch.");
    });
  };

  const commitLimit = (): void => {
    if (!settingsReady || savedLimit === null) return;
    const parsed = parseLimit(limit);
    if (parsed === null) {
      setLimitError("Enter a whole number of dollars from 0 to 100,000.");
      return;
    }
    setLimitError(null);
    if (parsed === savedLimit) {
      setLimit(`$${parsed}`);
      return;
    }
    void saveLimit(parsed).then((ok) => {
      if (ok) {
        setSavedLimit(parsed);
        setLimit(`$${parsed}`);
        return;
      }
      setLimit(`$${savedLimit}`);
      setLimitError("Couldn't save the limit. Put back to the old amount.");
      announce("Couldn't save the limit.");
    });
  };

  return (
    <section aria-label="Finance settings">
      <div className="fnm-hero">
        <Masthead compact title="Settings" />
      </div>
      <div className="fnm-page">
        <div className="fnm-block">
          {loading ? (
            <p className="jds-hint" role="status">
              Loading your current choices and dollar limit…
            </p>
          ) : loadFailed || limitLoadFailed ? (
            <div className="fnm-block fnm-block--tight">
              <div role="alert">
                {loadFailed ? (
                  <p className="jds-hint jds-hint--error">
                    Couldn't load your current choices.{" "}
                    {loaded ? "Keeping the last confirmed choices." : "Showing the safe defaults."}
                  </p>
                ) : null}
                {limitLoadFailed ? (
                  <p className="jds-hint jds-hint--error">Couldn't load your dollar limit.</p>
                ) : null}
                <p className="jds-hint">Your settings can't be edited until both are confirmed.</p>
              </div>
              <Button variant="link" onClick={retrySettings}>
                Retry loading settings
              </Button>
            </div>
          ) : null}
          <section className="fnm-block fnm-block--tight">
            <SectionHead title="How much Moss does alone" rule />
            <RadioCardGroup
              name="moss-step"
              ariaLabel="How much Moss does on its own"
              value={loaded ? value : null}
              disabled={!settingsReady}
              onChange={onStep}
              options={STEP_OPTIONS}
            />
            <InlineError message={stepError} />
          </section>
          <div className="fnm-phone-only">
            <ActivityBlock />
          </div>
          {value === "ask" ? null : (
            <section className="fnm-block fnm-block--tight">
              <SectionHead title="Dollar limit" rule />
              <Field>
                <FormLabel htmlFor="fnm-limit">Moss can move up to, per move</FormLabel>
                <input
                  id="fnm-limit"
                  className="jds-input fnm-limit"
                  inputMode="numeric"
                  value={limit}
                  disabled={!settingsReady}
                  placeholder={loading ? "Loading…" : "Unavailable"}
                  onChange={(event) => setLimit(event.target.value)}
                  onBlur={commitLimit}
                  onKeyDown={(event) => {
                    if (event.key === "Enter") commitLimit();
                  }}
                />
              </Field>
              <InlineError message={limitError} />
            </section>
          )}
          <section className="fnm-block fnm-block--tight">
            <SectionHead
              title={
                <DisclosureToggle
                  expanded={open}
                  controls="fnm-customize"
                  className="fnm-disclosure-head"
                  onClick={() => setUserOpen(!open)}
                >
                  Customize
                  <span className="fnm-disclosure-marker" aria-hidden="true" />
                </DisclosureToggle>
              }
              rule
            />
            {open ? (
              <div id="fnm-customize">
                {FAMILY_ROWS.map((family) => (
                  <div key={family.id} className="fnm-switch-row">
                    <span>{family.label}</span>
                    <Switch
                      ariaLabel={family.label}
                      checked={tiers[family.id] === "trusted_auto"}
                      disabled={!settingsReady}
                      onChange={(on: boolean) => onFamily(family.id, on)}
                    />
                  </div>
                ))}
                {["Connect a bank", "Share an account"].map((label) => (
                  <div key={label} className="fnm-switch-row">
                    <span>{label}</span>
                    <Badge tone="neutral">Always asks</Badge>
                  </div>
                ))}
                <InlineError message={familyError} />
              </div>
            ) : null}
          </section>
          <BankKeys />
        </div>
        <aside className="fnm-rail fnm-desktop-only">
          <ActivityBlock />
        </aside>
      </div>
    </section>
  );
}
