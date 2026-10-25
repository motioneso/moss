# AI providers redesign, slice 1 handoff

Branch: feat/ai-providers-redesign-3680. PR: #3683 (open, not merged).

## Done
- Add provider dialog (Choose, Connect), regrouped catalog, no Authentication switch or CLI agent dropdown.
- Name prefill, API key duplicates allowed, subscription kinds already connected stay disabled.
- "Which model does what" section; collapsible Voice, Web search, Auto-approve.
- App map and unit tests updated.
- Local gate passed (exit 0, excludes e2e). Live proof done on moss-proof (port 5181).

## Mid-flight
Nothing. No servers or browsers left running by this session.

## Next
- Wait for CI and an independent review of #3683; merge only when green and reviewed.
- Not live-checked: the disabled subscription line and the "X 2" second-name prefill (unit tests cover both).
- Slice 2 (separate subscription sign-in per provider, then lift the disabled-choice guard) is not started.
