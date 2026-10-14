# Validation record

Checked 2026-10-12 UTC. This record covers the sanitized repository-review
bundle, not production installer behavior.

## Passed

- `node --check app.js`: JavaScript syntax.
- `node tests/verify.mjs`: complete file inventory, relative HTML/CSS asset
  resolution, CSP, safe SVG markup, six local font weights and privacy scan.
- `node tests/dom-check.cjs` with an existing jsdom installation: **28/28 checks**.
  These include all **42 selectable review scenarios** within a fixture-loop test.
- Five host routes: local Mac, local Windows, local Linux, remote/headless Linux,
  manual Docker. Each keeps notes selection before startup and requires health
  and protected continuation before the owner screen.
- Full happy path, optional skips, Today, provider replacement, notes recovery,
  registry discovery, custom topics, HTML escaping, themes and reset.
- First-owner HTTP/unknown/certificate gates and a separate existing-LAN browser
  path. Legacy HTTP can complete without silently switching access modes.
- Access local default, six numbered stages, optional subpanel, HTTP warning,
  HTTPS recommendation, host-plan review, pending checkpoint, failed check,
  retry, cancellation before applying, save failures, stale action guards,
  same-instance identity and simulated verification.
- Browser-history events, dialog close and same-tab restart simulations.
- Six predefined deep links, including every new access entrypoint.
- Test-time traps recorded zero network, new-window, native-picker or persistent
  storage calls. No password, email-address, or file-upload input is present.
- At the initial export, all 20 selected source files were hash-checked and
  remained byte-identical to their pre-export values. Subsequent public-copy
  revisions were staged separately. This export work did not write the original
  source or data; feedback records or exports were never export inputs.

## Privacy and network review

Only an allowlisted subset of source artwork/fonts and screen code was used.
The annotation UI, bridge, script and stylesheet were removed rather than hidden.
No backend, API calls, database, deployment files or original historical spec is
bundled. No browser-storage read/write or synchronization remains.

Original personal references in styling comments were removed. Host folder
fixtures use generic labels; registry publisher/contact values were omitted.
The default city is unset and the initial time zone is a fixed sample, not a
browser/device location inference. Public vendor attribution and mandatory
license/copyright notices remain. No user identity/contact data, private links,
Library references, hosting identifiers, owner-specific paths, private IPs,
credentials or tokens were found by the source scan.

Address-like UI fixtures use the reserved documentation address `192.0.2.10`,
example domain `moss.example`, generic label `moss-host`, and standard
localhost/loopback technical labels. No address is contacted. Runtime
assets are local and `connect-src 'none'`, `worker-src 'none'`, `frame-src 'none'`,
`object-src 'none'`, and `form-action 'none'` are set. External source URLs in
attribution and provenance are documentation, not requests made by the mockup.

## Copy-only follow-up

The access chooser uses the revised LAN, HTTPS and HTTP-warning wording. Fresh
setup shows only the current mode; existing-deployment scenarios also show the
explicit access-retention reminder. A new DOM assertion checks the exact copy,
conditional reminder and removed repetition. Review status is retained outside
the product-facing screen copy. No mock
state transition, transport gate or access behavior was changed.

The user reported viewing the earlier access screen on a phone and requested
this clearer wording. That user-supplied review applies to the prior screen;
it is not rendered-browser verification of this revised copy. Visual review of the revised screens remains pending; this status is recorded
in the review documentation and tucked-away controls, not product-facing copy.

## Product-facing copy cleanup

The ordinary screen journey omits prototype/demo labels, implementation
explainers and simulated-action wording. The header uses a discreet icon with
an accessible “Review tools” label. Review-only context and controls stay in
that separate dialog and this documentation. Genuine warnings, failures,
permissions and consent requirements remain. Underlying actions are still
inert, no credential input was added, and no host/network integration was added.
Three additional DOM checks cover all 42 fixtures and the normal journey,
active detail dialogs, the tucked-away failed-check control, and preservation
of real HTTP/certificate warnings and email-consent copy.

## Not run / not established

- **Rendered-browser QA was not run.** The earlier browser route was blocked.
  No browser-launch, socket or sandbox workaround was retried.
- jsdom does not establish visual fidelity, screenshot equivalence, responsive
  overflow, real focus/screen-reader behavior, font rendering or browser-specific
  file-origin behavior. Pixel review remains required, especially for the new
  access proposal at narrow widths and in all four theme/mode combinations.
- No real Docker, host helper, account claim, folder, provider, email, SSH,
  certificate, firewall, networking or companion action was run.
- This is not a new end-to-end test of Moss adapter compatibility. ACP metadata
  is a dated snapshot; the support overlay remains separately source-grounded.
- Vendor identity marks retain their original artwork and source notices, but
  this export does not establish independent production trademark clearance.
- No Site publication or deployment was performed. Repository delivery is limited
  to the requested documentation-only PR.

## Integrity

`inventory.sha256` records every deliverable file except itself. Verify with
`sha256sum -c inventory.sha256` from this directory. These hashes describe the
export, not an installed product or a security attestation.
