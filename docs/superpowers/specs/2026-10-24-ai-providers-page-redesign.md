# AI providers page redesign

Status: approved direction (Ben, 2026-10-24). Surface: Settings > Admin / Setup > AI providers
(`apps/web/src/settings/settings-ai-admin-pane.tsx`).

## Problem

- Add provider opens its picker below the provider cards, usually off screen, so the click looks dead.
- The picker is a flat list of 13 entries that mixes vendors, protocols and tools. "Anthropic" and
  "Anthropic (API key)" read as near duplicates.
- A provider is configured in three places: the picker, an Authentication switch on its card, and a
  CLI agent dropdown. The dropdown shows for API key providers, where the server rejects an agent.
- The page is about 3,000px tall with seven open sections. Only Providers and Services are about providers.

## Decisions

1. Adding a provider happens in one place: a dialog with two steps, Choose then Connect.
2. How a provider connects is fixed when it is added. The card has no Authentication switch and no
   CLI agent dropdown. To change method, remove the provider and add it again.
3. Setting a provider stays on its card: Edit credentials, Log in, Terminal, models, default, remove.
4. Secondary sections collapse and show a one-line summary of their current state.

## Add provider dialog

Uses `Dialog` from `@moss/ui`. Opens from the Providers header button and from the empty state.
Focus lands on the first choice. Closing restores focus to the button.

Step 1, Choose. Choices are grouped by how the provider connects. Each choice is a
`RadioCardGroup`-style card with a name and one plain line. Every choice can be added any number
of times, so a person with two Claude accounts adds Claude twice. No choice is ever disabled.

| Group                       | Choices                                              |
| --------------------------- | ---------------------------------------------------- |
| Sign in with a subscription | Claude, Codex, Gemini, OpenCode                      |
| Use an API key              | OpenAI-compatible, Anthropic, Google, Ollama (local) |
| Decision models             | Jev, Clef, Any compatible service                    |

Step 2, Connect. Starts with a Name field, prefilled with the next free name ("Claude", then
"Claude 2"), so two accounts stay easy to tell apart on cards and in model pickers. Then shows only the fields that choice needs (address, API key, Cloudflare account id)
with the existing per-kind examples. A subscription choice has no fields and ends with the
existing sign-in dialog. A Back button returns to step 1 without losing the chosen group. Add
disables until the required fields are valid, using the existing rules.

Catalog changes: drop the `Authentication` switch path, drop `OPENAI_COMPATIBLE_CLI_AGENTS`, and
make each catalog entry carry its group, one-line description and fields. Mistral and Custom leave
the list. OpenAI-compatible covers Mistral and any other compatible API. If Custom has no distinct
server behaviour from OpenAI-compatible, fold it in; otherwise keep it under API key.

## Page structure

1. Providers (open). Cards, Add provider button, empty state.
2. Which model does what (open). Services, classifier, user chat override and chat lock together.
3. Voice (collapsed). Summary: configured or not.
4. Web search (collapsed). Summary: built-in or Brave key set.
5. Auto-approve (collapsed). Summary: off, or on with N members.

Collapsed sections use a new `CollapsibleGroup` in `settings-ui.tsx` built on `DisclosureToggle`.
State is remembered per browser. Nothing inside a collapsed section is lost or reordered.

## Several of the same provider

Allowed for every choice. Findings from the code, checked 2026-10-24:

- The database has no uniqueness rule on provider rows beyond one instance default and one voice
  provider, so duplicate rows already save.
- API key providers keep their credential on their own row, so duplicates already work.
- Subscription sign-ins do not. The Claude token file is named by provider kind
  (`packages/cli-runner/src/provider-token-store.ts`) and the Codex sign-in path is keyed by user, so
  two Claude or two Codex providers would share one account. This must be keyed by provider row id
  before the dialog offers a second subscription provider. It is slice 2 of the build (below).
- `catalogEntryIsAdded` in the picker goes away, and the page must not assume one card per kind.

## Build slices

1. Dialog, catalog, page structure, collapsible sections, card cleanup. API key duplicates work here.
2. Per-provider subscription sign-in in the runner, then lift any one-subscription-per-kind guard.
   Until it lands, the dialog explains that a second subscription of the same kind shares the first sign-in only if it cannot be separated. Do not ship slice 1 offering a second Claude that silently reuses the first account.

## Out of scope

- No change to provider storage, routes or the server rule on CLI agents.
- No change to the Services binding behaviour.
- Existing providers keep working untouched, including OpenAI-compatible providers set to CLI.
- Existing single-account sign-ins keep working; the migration to per-provider sign-in keeps the current login for the existing row.

## Acceptance

- Clicking Add provider shows the dialog on screen at desktop and phone width.
- Every catalog choice is added through the same dialog. No other add path exists on the page.
- No CLI agent dropdown or Authentication switch renders anywhere in the page.
- The page's open height drops by at least a third on a provider-less and one-provider install.
- Keyboard: dialog traps focus, Escape closes, focus returns to the Add button.
- App map declarations for the AI providers screen are updated in the same PR.
- Live proof on a running copy: add an API key provider and a subscription provider through the dialog, and add two of the same API key provider with different names.
- Slice 2 proof: two Claude providers signed in to different accounts each answer as their own account.

## Handoff notes

- The unit tests in `tests/unit/settings-ai-admin-pane.test.tsx` and
  `tests/unit/settings-ai-provider-catalog.test.ts` assert the old picker and need rewriting.
- Run the design-system skill and the invented-class audit before finishing.
