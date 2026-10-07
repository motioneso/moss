# Account-local timestamps in model tool results

Tool-capable chat sessions, including module chats, receive tools through the shared MCP
transport. Both normal JSON-RPC and progress/SSE responses use `gatewayResponseToMcp`.
Meeting question-only chat has no tools. Tool listings are unchanged.

The gateway already resolves the account's saved timezone for each actor and supplies it in
`ToolContext`. Result shaping now computes references using that zone and the timestamp's own
instant, including date rollover and daylight-saving changes. It does not ask the model to do
that arithmetic. The original source string remains intact, including fractional precision.
Local display is 24-hour time to whole seconds; the source retains its original fractional precision.

## Wire shape

The original tool text, media and schema-projected `structuredData` are unchanged. A separate
model-only `timestampContext` is emitted as an additional MCP text block inside the existing
`tool_result` outside-content wrapper. The account zone appears once at the top, followed by
compact `source ISO = local date time (UTC offset)` lines. The original source string and
computed local date, time and offset sit next to each other. There is no redundant normalized
UTC field and no JSON key/quote overhead per reference. Existing escaping is retained; validated
timestamp values and generated lines need no quote-heavy representation.

References contain only parsed timestamp values and computed fields, never arbitrary source
instructions or property names. Repeated source timestamps share one reference. Nested objects,
arrays, serialized Date values and complete JSON text/tool-wrapped JSON are supported. Free
prose, date-only values, timestamps without an offset, invalid dates, unknown `-00:00` offsets,
and ID/secret/token/cursor fields are not interpreted. At this shaping seam, an invalid or absent zone leaves source values unchanged without a guessed
annotation. Production normally resolves an unset locale to the same default Settings shows.

Module authors should return timestamps in their own fields: timestamps embedded in prose are
not extracted. An uncovered zoned ISO timestamp retains the short prompt fallback: convert its
instant to the known account zone using the offset at that date, never relabel the UTC clock.

The classifier fast path fills templates from structured data without a model and is outside
this presentation fix. Its current calendar summaries already use local time; raw timestamps
in future integration templates remain a separate follow-up.

## Bounds and trust

The existing original-payload cap remains unchanged, so adding references never truncates a
page or changes its counts. The additional reference block has its own hard 16,000-character
cap measured on the serialized MCP text block, including its trust wrapper and wire escaping. Thus the model-result budget is explicitly the
existing capped original plus at most 16,000 extra characters, not a claim that the combined
result still fits the old original-only cap. References are limited to 512 retained candidates
and a 4,096-node, 24-level-deep scan. `omittedCount` counts qualifying distinct timestamps not shown;
`scanLimited` says when scanning stopped before the full structure was visited. Only values
already visible in the capped original can be referenced. No values are read from a database
again or persisted, and no source content is upgraded to trusted instructions.

Tests exercise the real gateway and both MCP response modes for two account timezones, along
with conversion, scope, bounds and input-preservation cases. These verify supplied model data;
only a live chat can verify the final wording produced by an actual model.

The full-page transport regression uses 50 rows with four distinct, long fractional ISO values
each. Both plain and SSE final wire results must contain all 200 references with zero omissions,
including the last row. Larger inputs remain bounded and explicitly report omitted references.
