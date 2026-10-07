# Account-local timestamps in model tool results

Tool-capable chat sessions, including module chats, receive tools through the shared MCP
transport. Both normal JSON-RPC and progress/SSE responses use `gatewayResponseToMcp`.
Meeting question-only chat has no tools. Tool listings are unchanged.

The gateway already resolves the account's saved timezone for each actor and supplies it in
`ToolContext`. Result shaping now computes references using that zone and the timestamp's own
instant, including date rollover and daylight-saving changes. It does not ask the model to do
that arithmetic. The original source string remains intact, including fractional precision.
Local display is 24-hour time to whole seconds; `utcInstant` is normalized to JavaScript's
millisecond precision and `source` retains the original precision.

## Wire shape

The original tool text, media and schema-projected `structuredData` are unchanged. A separate
model-only `timestampContext` is emitted as an additional MCP text block inside the existing
`tool_result` outside-content wrapper. It contains a list of pairs:

- Original zoned ISO string (`source`)
- Normalized UTC instant (`utcInstant`)
- Computed `localDate`, `localTime`, `timezone` and `utcOffsetMinutes`

References contain only parsed timestamp values and computed fields, never arbitrary source
instructions or property names. Repeated source timestamps share one reference. Nested objects,
arrays, serialized Date values and complete JSON text/tool-wrapped JSON are supported. Free
prose, date-only values, timestamps without an offset, invalid dates, unknown `-00:00` offsets,
and ID/secret/token/cursor fields are not interpreted. Invalid or absent account zones leave
source values unchanged without a guessed local annotation.

## Bounds and trust

The existing original-payload cap remains unchanged, so adding references never truncates a
page or changes its counts. The additional reference block has its own hard 4,000-character
cap, including its trust wrapper/escaping. Thus the model-result budget is explicitly the
existing capped original plus at most 4,000 extra characters, not a claim that the combined
result still fits the old original-only cap. References are limited to 64 retained candidates
and a 4,096-node, 24-level-deep scan. `omittedCount` counts qualifying distinct timestamps not shown;
`scanLimited` says when scanning stopped before the full structure was visited. Only values
already visible in the capped original can be referenced. No values are read from a database
again or persisted, and no source content is upgraded to trusted instructions.

Tests exercise the real gateway and both MCP response modes for two account timezones, along
with conversion, scope, bounds and input-preservation cases. These verify supplied model data;
only a live chat can verify the final wording produced by an actual model.
