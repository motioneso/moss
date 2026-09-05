# Workshop R1a/M2: route source generation through the selected model

Part of #2023. This task implements the already approved limited R1a/M2 scope.

Replace the worker's interactive source-writing path with source-only generation through the
existing capability router. Preserve owner-scoped inputs, explicit model choices and the concrete
model passed to the provider. Validate returned source as data and preserve cancellation behavior.

Keep new Workshop execution unavailable until the isolated runtime and actor-isolation checks pass.
Verify unavailable routes, concrete model propagation, invalid source rejection and cancellation.
Record the limits of synthetic tests separately from live evidence.

Run targeted tests, root TypeScript and scoped lint/formatting. No installation, deployment,
shared service restart, merge or Workshop enablement is included.
