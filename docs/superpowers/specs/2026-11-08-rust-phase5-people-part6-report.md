# People part six: historical checkpoint receipts

## People part six: installed-dispatch checkpoint (JS-73)

Card 523. Base: merged main `33cf5da15`. This is a bounded, partially verified
checkpoint. It does not complete the People port or qualify the authenticated Rust
application. The next continuation must finish the package replay before claiming installed
route, consumer or screen acceptance.

### What changed

People validates the legacy POST/PATCH/folder-setting body schemas before handlers,
including required fields, string/string-array coercion, union errors and root-array
refusal. Unknown properties remain available. Rename defers note-only field parsing until
folder availability and canonical-note discovery, preserving projection fallback when no
note exists. Ignored summary fields do not break a note-backed edit.

Repeated search values use JavaScript array joining; repeated equality filters use
node-postgres array encoding. Positive limits beyond the SDK page space use an uncapped
scan if the count fits PostgreSQL `int8`; larger or negative values fail. Host resource
limits still apply. This does not establish unlimited-dataset parity.

The legacy relative `GET /people/notes-directories` is separate from the additive absolute
root chooser. Empty and null folder HTTP saves retain the legacy 400 folder error and
preserve the shared preference. Fastify coerces null to an empty string, which the legacy
service rejects. The app map describes input recovery and choosing a valid folder; it no
longer promises that an empty save clears the selection.

The route gate optionally accepts `JS73_PEOPLE_PACKAGE`, pins its bytes and component hash,
signs a temporary folder registry, installs with `PostgresLifecycle` and `PostgresCatalog`,
and reopens the installer. Actual signed installation, unchanged `core-legacy` migration
identity and reload succeeded. The People guest now accepts the host's required `install`
lifecycle hook after host migration; previously it rejected that hook.

The new test is set up to replay legacy responses and all seven table snapshots through
`Installer::dispatch_extended`, call all four public APIs from an installed consumer and
retrieve the installed Settings HTML. These assertions have **not completed successfully**.
The last replay stopped at a folder-setting mismatch, before the consumer and folder
assertions. Retrieving an asset would not prove a working browser screen. The provider
dependency and unavailable AI service are explicit fixtures, not real provider delivery.
The four public API versions, SQL migrations and existing job kinds remain unchanged.

No tool was installed globally. The approved pinned `wit-bindgen` (`=0.57.1`) and existing
scratch Cargo/Rustup caches built the generated guest. UI output and test packages stay
in scratch. The UI lockfile records an already declared shared dependency.

### Verification receipts and limits

- The exact pre-change source was archived from the base and compiled separately. The
  expanded real Fastify/database oracle failed against it: scalar `POST /people` returned
  500 instead of Fastify's 400 `body must be object` (gate exit 101).
- Review one found a test borrow error and root-array acceptance that could clear the
  saved folder. Both were fixed. The same native root-array assertion was observed
  failing before the fix and passing afterward; real registered Fastify routes reject
  those root arrays with 400.
- A trusted installed replay exposed the missing `install` hook (exit 101). After the
  fix, package installation with legacy SQL and reload succeeded. That replay then found
  a null/empty-folder mismatch: Rust returned 200 and cleared the value where legacy
  returned 400. A native empty-save regression was observed failing, then passed after
  the final fix. The final installed replay still needs rerunning.
- Final source checks: all **twelve native tests** and strict People Clippy passed, along
  with scoped Rust formatting. Root `pnpm lint`, `pnpm format:check`, `pnpm typecheck` and
  `pnpm check:file-size` passed; the later changes are Rust and documentation, with scoped
  formatting and file-size checks repeated for the checkpoint.
- The last installed run (`122143-76Fnix`) tested clean `f607976af`, fingerprint
  `107d5bd86144987204918adc9cd4ca2078d9caf08c7af94567ccd642cf9adc82`, and ended 101
  at the folder mismatch. It is failing evidence, not a green installed-parity receipt.
- The separate nine-suite run (`122051-mQhJ57`, same commit/fingerprint) ended 101 when
  the notes test executable disappeared from the reused scratch cache. Its completed
  preference/privacy, ABI, API and worker checks do not establish a complete matrix pass.
  The cache directory itself was subsequently gone. Use a task-owned cache next time.
- Both runs used Node `22.22.2`, pnpm `10.6.2`, Rust `1.95.0` and disposable PostgreSQL
  `17.11`. They used the earlier component/package hashes below. These artifacts precede
  the final empty-folder fix and must not be used as final successful-build evidence:

```text
component 9ae0cd7eb77a0f9cf7ef3be88f398dc33825fd34c13e6722646d266634ea30a6
package   8671e4507375cd9ad3ac12f096cb20f838bd670caf74f491edaf8f584f3188f6
```

The final corrected guest core compiled for `wasm32-wasip2`; wrapping/package verification
was not completed after the cache loss. A task-owned cache was seeded from existing build
artifacts, but rebuilding it exceeded this bounded continuation. The build was stopped.
The proof recipe records actual red/green native checks and the unsuccessful gate limits.
Independent review results are attached to the task. No live application proof is supplied.

### Exact remaining work after part six

1. Rebuild the final component and package using an isolated task-owned host target. Run
   both the complete People gate and `modules/people/tools/routes-gate.sh` through
   `scripts/run-gate.sh`, with the final component and `JS73_PEOPLE_PACKAGE`. Obtain green
   receipts for installed response/table comparisons, all four consumer APIs, asset and
   folder operations. Neither prior failed run can substitute for this.
2. Compose the authenticated Rust shell with the installed frame, shared preferences and
   linked-note adapters. Exercise actual Settings reads/writes and real chat approvals,
   blocked app actions and policy behavior. Library dispatch is not a network listener.
3. Finish index-refresh/cooldown, ingest nudges, real source-provider dependencies and
   sustained command quotas/retention. The registry test's provider is a fixture.
4. Broaden HTTP parity: configured-folder legacy filesystem comparisons, locale-sensitive
   mixed-case/Unicode directory ordering, unusual note-only values, backend errors and
   numeric edge cases beyond the oracle vectors. Directory sorting is currently Rust
   lexical ordering rather than JavaScript `localeCompare`. Directory-account fixture
   refusals do not establish a failing-first filesystem privacy property.
5. Run the installed Rust UI at desktop and phone widths, then sign in from a second
   physical device over HTTPS, including trusted-origin and cross-account privacy checks.
   No browser, LAN/tailnet or physical-device proof exists in this checkpoint.

Keep full People parity and live-device acceptance open. Prioritize working installed
screens and chat after the final package replay is green.
