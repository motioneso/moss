import { useReadCooldown } from "./read-cooldown";
import {
  Badge,
  Button,
  Note,
  RowIndex,
  RowIndexItem,
  SectionHead,
  useEffect,
  useRef,
  useState,
  type ExternalModuleToolsHandleV1,
  type ReactNodeLike
} from "@moss/module-web-sdk";
import type { MerchantRule } from "../domain/merchant-rules";
import type { RulesView } from "./merchant-rule-types";
import { MerchantRuleDialog } from "./merchant-rule-dialog";
import { invokeTool } from "./api";
import { invalidateQueries } from "./store";
export function MerchantRulesSection(props: {
  tools?: ExternalModuleToolsHandleV1;
}): ReactNodeLike {
  const [saved, setSaved] = useState<{
    scope: typeof props.tools;
    data: RulesView;
    search: string;
  } | null>(null);
  const [draftSearch, setSearch] = useState("");
  const [loading, setLoading] = useState(true),
    [error, setError] = useState<string | null>(null);
  const [uncertain, setUncertain] = useState(false);
  const [dialog, setDialog] = useState<{
    scope: typeof props.tools;
    rule: MerchantRule | null;
  } | null>(null);
  const readId = useRef(0);
  const cooldown = useReadCooldown();
  const data = saved && saved.scope === props.tools ? saved.data : null;
  const load = async (search: string, limit = 50, clearBlocked = false) => {
    if (cooldown.cooling) return;
    const id = ++readId.current;
    setLoading(true);
    setError(null);
    const result = await invokeTool<RulesView>("finance.rules.list", { search, limit }).catch(
      () => ({
        kind: "error" as const,
        message: "Merchant rules could not be loaded. Try checking saved rules again."
      })
    );
    if (id !== readId.current) return;
    setLoading(false);
    if (result.kind === "error" && "retryAfterSeconds" in result && result.retryAfterSeconds)
      cooldown.wait(result.retryAfterSeconds);
    if (result.kind === "ok") {
      setSaved({ scope: props.tools, data: result.result, search });
      if (clearBlocked && result.result.supported && result.result.ready) setUncertain(false);
    } else
      setError(
        result.kind === "error"
          ? result.message
          : "Merchant rules could not be loaded. Your saved view is kept."
      );
  };
  useEffect(() => {
    setSearch("");
    setUncertain(false);
    setDialog(null);
    void load("");
    return () => {
      readId.current += 1;
    };
  }, [props.tools]);
  const ready = Boolean(
    data?.supported && data.ready && !loading && !cooldown.cooling && !error && !uncertain
  );
  return (
    <section aria-label="Merchant rules" className="fnm-block fnm-block--tight">
      <SectionHead
        title="Merchant rules"
        rule
        align="center"
        meta={
          <Button
            variant="secondary"
            disabled={!ready || !props.tools}
            onClick={() => setDialog({ scope: props.tools, rule: null })}
          >
            Add merchant rule
          </Button>
        }
      />
      <div className="fnm-chips">
        <input
          className="jds-input fnm-search"
          type="search"
          placeholder="Find a merchant"
          aria-label="Search merchant rules"
          maxLength={200}
          value={draftSearch}
          onChange={(e) => setSearch(e.currentTarget.value)}
          onKeyDown={(e) => {
            if (e.key === "Enter" && !loading && !cooldown.cooling) void load(draftSearch.trim());
          }}
        />
        <Button
          variant="secondary"
          disabled={loading || cooldown.cooling}
          onClick={() => void load(draftSearch.trim())}
        >
          Search rules
        </Button>
        <Button
          variant="link"
          disabled={loading || cooldown.cooling}
          onClick={() =>
            void load(
              saved && saved.scope === props.tools ? saved.search : "",
              data?.limit ?? 50,
              true
            )
          }
        >
          {loading
            ? "Loading rules…"
            : cooldown.cooling
              ? "Wait before checking rules"
              : "Check saved rules"}
        </Button>
      </div>
      {error ? (
        <p role="alert">
          {error}{" "}
          {data
            ? "Keeping the last loaded rules; editing waits for a successful check."
            : "Check saved rules to try again."}
        </p>
      ) : null}
      {uncertain ? (
        <Note variant="practical">
          Check saved rules successfully before reviewing another change.
        </Note>
      ) : null}
      {data && !data.supported ? (
        <Note variant="practical">Merchant rule management needs updated Finance storage.</Note>
      ) : data && !data.ready ? (
        <Note variant="practical">
          Merchant rules are getting ready. Check saved rules again shortly.
        </Note>
      ) : data?.ready ? (
        <>
          {data.total ? (
            <p className="jds-hint">
              {data.rules?.length ?? 0} of {data.total} rules loaded
              {saved?.search ? ` for “${saved.search}”` : ""}
            </p>
          ) : null}
          {data.rules?.length ? (
            <RowIndex density="compact">
              {data.rules.map((r) => {
                const category = data.categories?.find((c) => c.id === r.categoryId);
                return (
                  <RowIndexItem
                    key={r.id}
                    title={r.payeeKey}
                    excerpt={category?.name ?? "Unavailable category"}
                    meta={
                      <div className="fnm-chips">
                        <Badge>
                          {!r.enabled
                            ? "Disabled"
                            : category?.archived
                              ? "Needs a live category"
                              : "Enabled"}
                        </Badge>
                        <Button
                          variant="link"
                          disabled={!ready || !props.tools}
                          aria-label={`Edit rule for ${r.payeeKey}`}
                          onClick={() => setDialog({ scope: props.tools, rule: { ...r } })}
                        >
                          Edit rule
                        </Button>
                      </div>
                    }
                  />
                );
              })}
            </RowIndex>
          ) : (
            <p>{saved?.search ? "No rules match this search." : "No merchant rules yet."}</p>
          )}
          {(data.rules?.length ?? 0) < (data.total ?? 0) ? (
            data.limit! < 1000 ? (
              <Button
                variant="secondary"
                disabled={loading || cooldown.cooling}
                onClick={() => void load(saved?.search ?? "", Math.min(1000, data.limit! + 50))}
              >
                Show more rules
              </Button>
            ) : (
              <p className="jds-hint">
                The first 1,000 matches are loaded. Narrow your merchant search to find another
                rule.
              </p>
            )
          ) : null}
        </>
      ) : null}
      {dialog && dialog.scope === props.tools ? (
        <MerchantRuleDialog
          rule={dialog.rule}
          categories={data?.categories ?? []}
          tools={props.tools}
          onClose={() => setDialog(null)}
          onUncertain={() => setUncertain(true)}
          onSaved={() => {
            setDialog(null);
            invalidateQueries();
            void load(saved?.search ?? "", data?.limit ?? 50);
          }}
        />
      ) : null}
    </section>
  );
}
