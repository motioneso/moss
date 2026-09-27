import type { ComponentPropsWithoutRef } from "react";
import ReactMarkdown from "react-markdown";
import remarkGfm from "remark-gfm";
import type { AnswerSourceSupportCard } from "@moss/shared";

import { SourceChips, stripDisplayMarkers } from "./answer-provenance";

/**
 * Allowlist URL sanitizer for every link/image href the renderer produces.
 *
 * Only `http:`, `https:`, and `mailto:` survive; everything else (`javascript:`,
 * `data:`, `vbscript:`, relative/odd schemes) is dropped to an empty string. This is
 * stricter than react-markdown's default `urlTransform` and — importantly — also covers
 * the bare-URL autolinks that `remark-gfm` generates, where the source text never went
 * through markdown link syntax. Defense in depth against indirect prompt injection (#360).
 */
export function safeUrl(url: string): string {
  return /^(https?:|mailto:)/i.test(url) ? url : "";
}

/**
 * Renders untrusted assistant text as GitHub-flavoured markdown.
 *
 * Security-critical: raw HTML is NEVER rendered. We do not add `rehype-raw` and never use
 * `dangerouslySetInnerHTML`, so react-markdown escapes any HTML in the source. URLs are
 * passed through {@link safeUrl} (allowlist), and links open in a new tab with a hardened
 * `rel`. Chat content can echo tool results / fetched web content (indirect prompt
 * injection, #360), so these guarantees must stay intact.
 */
interface MarkdownMessageProps {
  readonly text: string;
  readonly answerProvenance?: readonly AnswerSourceSupportCard[];
  readonly answerProvenanceCitedIds?: readonly string[];
}

export function MarkdownMessage(props: MarkdownMessageProps) {
  const { text, answerProvenance, answerProvenanceCitedIds } = props;

  const citedSet = new Set(answerProvenanceCitedIds ?? []);
  const displayText =
    answerProvenance && answerProvenance.length > 0 ? stripDisplayMarkers(text, citedSet) : text;

  return (
    <div className="chatd-md">
      <ReactMarkdown
        remarkPlugins={[remarkGfm]}
        urlTransform={safeUrl}
        components={{
          a: ({ node: _node, ...rest }: ComponentPropsWithoutRef<"a"> & { node?: unknown }) => (
            <a {...rest} rel="noopener noreferrer" target="_blank" />
          )
        }}
      >
        {displayText}
      </ReactMarkdown>
      {answerProvenance && answerProvenance.length > 0 && (
        <SourceChips cards={answerProvenance} citedIds={answerProvenanceCitedIds} />
      )}
    </div>
  );
}
