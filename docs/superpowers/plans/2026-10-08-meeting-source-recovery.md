# Implementation plan: #3123

Base: main at 2c81aa48418f4b7dcb80218e72629e5bb495c642.

1. Add a narrowly scoped, idempotent native recovery command using existing server epochs, receipt transactions and grant/lease checks. Add contract, route, domain and service regression tests.
2. Introduce typed recoverable format/clock evidence at the native source boundary; preserve hard-fault priority and physical route/scope pinning. Test invalid numeric timing and source changes remain closed.
3. Coordinate paired quiescence and bounded recovery under the same selection. Confirm the server epoch and status before admission. Cancel on Pause/Stop/revocation and reject late results.
4. Retire expired old epoch audio before Resume and isolate receipt/sequence handling so it cannot pause a replacement epoch.
5. Add recovery and persistent interruption presentation using existing native UI primitives. Update meeting app-map metadata and release note.
6. Run portable/unit/static/native CI and independent safety review; fix findings and monitor the draft PR checks. Record exact blocked checks and request installed-Mac live proof without claiming completion.

All implementation and tests live in this independent branch. No merge or deployment is authorized by this plan.
