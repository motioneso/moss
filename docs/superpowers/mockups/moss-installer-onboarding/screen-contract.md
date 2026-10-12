# Selected screen contract

## Baseline boundary

This is design reference, not proof that the installer, protected owner claim,
local-model integration, or new access-mode orchestration exists. The product
build specification is authoritative for implementation and rollout. The mockup
uses only fictional names, static city/team/topic catalogs, and generic folders.
No screen accepts a password, API key, provider return URL, or actual host path.

## Installation sequence

1. Choose local, remote Linux/headless, or manual Docker ownership.
2. Check the selected host, platform and Docker context.
3. Choose existing notes, a private Moss folder, or later **before** startup.
4. Review host/folder choices. Applying Docker bind changes may require recreation,
   not merely restart; retry preserves deployment identity, keys and volumes.
5. Verify application and database health using a real result in production.
6. Continue in the browser through protected same-instance bootstrap.
7. Create or resume the owner, then bind prepared notes to that owner.

A picker on the browser device cannot mount a folder on a remote Docker host.
Existing notes stay in place. Successful browsing alone is not verified writing.
A replacement draft or failed write check does not erase the saved source.

## Browser onboarding and appearance

- Six stages only: Account, You, AI, Email, News, Sports.
- Ready and first Today are quiet, centered screens; no dense dashboard or
  fabricated conversation appears during setup.
- A screen has one principal action, short decision copy and optional disclosures.
- Shared semantic tokens control type, color, border, focus and motion. Archivo
  is bundled locally; reduced-motion preferences remove entrance transitions.
- Progress, details, dialogs, Back/Forward and cancel keep the current choices.
  Failed simulated saves block advancement. The public review intentionally
  substitutes in-memory state for product persistence.
- Real authorization must verify the owner/instance/attempt before accepting a
  return. Old callbacks may not navigate a newer screen or another owner.
- Registry listing, installed adapter, authenticated provider, usable model and
  chat capability are separate states. A dated discovery version never silently
  replaces a tested adapter. Local chat remains explicitly proposed.
- Email consent and initial sync are separate from permission to send mail.
- Custom news requires structured output plus working web search. Catalog errors
  must preserve saved topics/teams rather than masquerading as empty results.

## Access revision proposal

The direction is approved; the new screens and precise copy remain a visual
revision proposal. Access lives in the Ready recap and a focused optional
subpanel. It does not add a numbered browser stage.

- Fresh installs start at **This computer only**. Existing installations show
  their actual saved mode; onboarding must not silently change it.
- Choices: **Keep local**, **Home network (HTTP, unencrypted)**, **HTTPS**.
- HTTP disclosure: “People or software on this network may read or alter your
  credentials and content. Some device features need HTTPS.”
- LAN HTTP can serve ordinary phone/computer browsers. Remote companions require
  HTTPS; these are different compatibility constraints.
- HTTPS is recommended, but a domain, new certificate flow, or Tailscale cannot
  become a requirement to finish onboarding.
- Changing the selection does not apply it. Review the exact host, bind interface,
  ports and resulting address, and disclose any widening or disconnection before
  host-side action. Mockup placeholders are not inspected infrastructure values.
- New first-owner claiming remains loopback, SSH tunnel, or verified HTTPS. Close
  the claim before widening access. This is not a new blanket ban on existing
  HTTP browser sessions.
- Save a same-owner/same-instance checkpoint, perform the reviewed host change,
  and check actual health, route/trust and owner session. Pending or failed checks
  must not be presented as verified readiness; preserve the previous saved mode.
- **Get started** only completes onboarding. It never changes bindings, opens
  firewall ports, creates credentials, enrolls a network or installs a service.

## Deliberate export exclusions

No review annotations, feedback records/history, original long-form design
history, backend endpoints, hosting metadata, deployment identifiers, private
links, owner-specific paths, emails, real location data, or browser-storage
synchronization is included. Public third-party license and copyright notices
remain for attribution. The public bundle may not be used as an executable
installer or as evidence that mocked health/security checks passed in production.
