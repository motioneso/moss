# Workshop D5a/U1: create-only projects and real project screens

Part of #2023. Uses the approved Workshop projects spec, prototype and supplementary state sheet
(A1 #2266, approved September 4). Ben's blanket authorization covers this continuation.

Connect D1/D2 storage to real owner/admin REST endpoints and the Workshop list/create/detail
screens. Both direct creation and the existing Moss tool use the same create-only operation.
A structured handoff returns the saved project ID and server-derived internal destination;
no model planning, YOLO queue dispatch, approval or execution occurs during creation.

Retain request keys and message text on failed/retried submissions. List/detail failures must
render recovery, not empty content. Reload server state on reconnect before mutations. Feed
acknowledgements show saved/pending honestly; no canned assistant replies or fake plan/build state.
Use authored primitives and the approved responsive layout. Every API enforces admin status and
owner RLS, including other admins. Incognito source cannot silently become durable project data.

Verify HTTP contracts with real runtime roles, browser create/reload/message/retry and owner
isolation, shared tool idempotency and no execution effects. Keep map declarations truthful.
