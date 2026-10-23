import { Component, Suspense, lazy, useState, type ReactNode } from "react";
import { Button, Note } from "@moss/ui";
import { readStoredVisual, visualReplyText, type TranscriptRecord } from "@moss/shared";
import "./visual-reply.css";

const VisualRenderer = lazy(() => import("./visual-renderer"));

export function VisualFallback({ text }: { text: string }) {
  return (
    <Note variant="practical">
      <p role="status">Visual unavailable</p>
      <p>{text}</p>
    </Note>
  );
}

class VisualBoundary extends Component<
  { children: ReactNode; fallback: ReactNode },
  { failed: boolean }
> {
  state = { failed: false };
  static getDerivedStateFromError() {
    return { failed: true };
  }
  render() {
    return this.state.failed ? this.props.fallback : this.props.children;
  }
}

/** Only complete, saved assistant replies enter the renderer. */
export function VisualReply({ record }: { record: TranscriptRecord }) {
  const [copyStatus, setCopyStatus] = useState("");
  if (record.kind !== "reply" || !record.messageId) return null;
  const { visualReply } = readStoredVisual(record.visualReply);
  const fallback = visualReply?.fallbackText ?? record.visualFallbackText;
  if (!fallback) return null;
  const unavailable = <VisualFallback text={fallback} />;
  return (
    <div className="chat-visual" aria-label="Visual reply">
      {visualReply ? (
        <VisualBoundary key={record.messageId} fallback={unavailable}>
          <Suspense
            fallback={
              <Note variant="practical">
                <p role="status">Preparing visual…</p>
                <p>{fallback}</p>
              </Note>
            }
          >
            <VisualRenderer reply={visualReply} />
          </Suspense>
        </VisualBoundary>
      ) : (
        unavailable
      )}
      <div className="chat-visual__copy">
        <Button
          variant="link"
          size="sm"
          onClick={async () => {
            try {
              await navigator.clipboard.writeText(visualReplyText(record.text, fallback));
              setCopyStatus("Reply copied");
            } catch {
              setCopyStatus("Could not copy. Select the reply text to copy it.");
            }
          }}
        >
          Copy reply
        </Button>
        <span role="status">{copyStatus}</span>
      </div>
    </div>
  );
}
