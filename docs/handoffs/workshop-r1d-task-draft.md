# Workshop R1d: add fixed-operation runtime control

Part of #2023; depends on the public build/render image in #2289.

Implement the approved host-owned control path for isolated Workshop builds. Accept only
bounded authenticated run references and source data. Fix image identity, commands, mounts,
limits and cleanup in the deployment-owned configuration; generated source cannot choose them.

Verify unauthorized and cross-owner denial, duplicate dispatch, exact stop/status behavior,
wall/output bounds, peer survival and cleanup after controller loss using disposable fixtures.
Add compatible optional development/production configuration without changing shared services.
Unavailable control must fail closed while the rest of Moss starts normally.

Keep Workshop execution disabled. Durable attempt authority, installation/promotion, deployment,
shared restarts, merge and execution enablement remain separate acceptance gates.
