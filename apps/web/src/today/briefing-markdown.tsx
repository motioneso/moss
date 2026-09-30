import { EVENING_SECTION_HEADERS } from "@moss/shared";
import type { ComponentPropsWithoutRef } from "react";
import ReactMarkdown from "react-markdown";
import remarkGfm from "remark-gfm";

import { safeUrl } from "../chat/markdown-message.js";

/** Evening report section names, for promoting bare header lines. */
export const EVENING_SECTION_NAMES: readonly string[] = Object.values(EVENING_SECTION_HEADERS);

/** Plain text of generated briefing prose, for surfaces that show one line or a lead. */
export function plainBriefingText(text: string): string {
  return text
    .replace(/^#{1,6}\s+/gm, "")
    .replace(/(\*\*|__)(?=\S)([\s\S]*?\S)\1/g, "$2")
    .replace(/(^|[^\w*])\*(?=\S)([^*\n]*?\S)\*(?![\w*])/g, "$1$2")
    .replace(/(^|[^\w_])_(?=\S)([^_\n]*?\S)_(?![\w_])/g, "$1$2")
    .replace(/`([^`\n]+)`/g, "$1");
}

/** Writers often label a section with a lone bold line; treat it as a heading. */
function boldLinesAsHeadings(text: string): string {
  return text.replace(/^[ \t]*(\*\*|__)([^*_\n]+?)\1[ \t]*:?[ \t]*$/gm, "## $2");
}

/**
 * The evening writer may put a section name on a bare line. Such a line is a heading
 * only when it names a known section and starts a paragraph, so a lone "Tomorrow"
 * inside prose stays prose.
 */
function bareSectionLinesAsHeadings(text: string, sectionNames: readonly string[]): string {
  if (sectionNames.length === 0) return text;
  const known = new Set(sectionNames.map((name) => name.toLowerCase()));
  let previous = "";
  return text
    .split(/\r?\n/)
    .map((line) => {
      const startsParagraph = previous.trim() === "";
      previous = line;
      const bare = line.trim().replace(/:$/, "").trim();
      return startsParagraph && known.has(bare.toLowerCase()) ? `## ${bare}` : line;
    })
    .join("\n");
}

type HeadingProps = ComponentPropsWithoutRef<"h4"> & { node?: unknown };

function SectionHeading({ node: _node, children }: HeadingProps) {
  return <h4 className="brief-reader__section-heading">{children}</h4>;
}

/**
 * Renders generated briefing prose as markdown. The text is model output built from
 * external sources, so raw HTML and images are never rendered and links pass the
 * chat allowlist.
 */
export function BriefingMarkdown(props: {
  readonly text: string;
  /** Section names that count as headings on a bare line. */
  readonly sectionNames?: readonly string[];
}) {
  return (
    <div className="brief-reader__sections">
      <ReactMarkdown
        remarkPlugins={[remarkGfm]}
        urlTransform={safeUrl}
        skipHtml
        disallowedElements={["img"]}
        components={{
          h1: SectionHeading,
          h2: SectionHeading,
          h3: SectionHeading,
          h4: SectionHeading,
          h5: SectionHeading,
          h6: SectionHeading,
          p: ({ node: _node, ...rest }: ComponentPropsWithoutRef<"p"> & { node?: unknown }) => (
            <p {...rest} className="jds-brief__body" />
          ),
          ul: ({ node: _node, ...rest }: ComponentPropsWithoutRef<"ul"> & { node?: unknown }) => (
            <ul {...rest} className="brief-reader__list" />
          ),
          ol: ({ node: _node, ...rest }: ComponentPropsWithoutRef<"ol"> & { node?: unknown }) => (
            <ol {...rest} className="brief-reader__list" />
          ),
          a: ({ node: _node, ...rest }: ComponentPropsWithoutRef<"a"> & { node?: unknown }) => (
            <a {...rest} rel="noopener noreferrer" target="_blank" />
          )
        }}
      >
        {boldLinesAsHeadings(bareSectionLinesAsHeadings(props.text, props.sectionNames ?? []))}
      </ReactMarkdown>
    </div>
  );
}
