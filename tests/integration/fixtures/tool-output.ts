/** Parse JSON gateway/MCP text, including the HTML-escaped outside-content envelope. */
export function parseToolOutputText(text: string): Record<string, unknown> {
  const inner = text
    .replace(/^<tool_result[^>]*>\n/, "")
    .replace(/\n<\/tool_result>$/, "")
    .replace(/&quot;/g, '"')
    .replace(/&#39;/g, "'")
    .replace(/&lt;/g, "<")
    .replace(/&gt;/g, ">")
    .replace(/&amp;/g, "&");
  return JSON.parse(inner) as Record<string, unknown>;
}
