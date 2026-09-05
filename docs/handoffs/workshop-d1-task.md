# Workshop D1: persist private projects

Part of #2023. Implements D1 of the approved Workshop projects and supervised-builds plan.
Ben's subsequent blanket approval and explicit continuation authorize this implementation.

Add Workshop-owned durable project records with bounded title, initial request and handoff
context. Creation is idempotent per owner/request key; replay with changed input conflicts.
Create/list/get use actor-scoped transactions and database owner RLS, including against other
admins. Creating a project cannot start planning, generation, execution or installation.

Use the existing module migration declarations, DataContextDb and plain API contracts. Preserve
settings ownership of build execution records. Verify concurrent create/replay and two-owner
denial with the real runtime roles in an isolated database. The later conversation/revision/UI
slices consume this persistence; no fake completion or generated source execution is introduced.
