import { createContext, useContext, useState } from "react";
import { createLibrary, defineComponent, Renderer, useRenderNode } from "@openuidev/react-lang";
import { z } from "zod/v4";
import { Note, SectionHead } from "@moss/ui";
import { validateVisualCatalogReply, visualFactValue, type VisualReplyV1 } from "@moss/shared";
import { VisualFallback } from "./visual-reply";

const Snapshots = createContext<VisualReplyV1["snapshots"]>([]);
const Fact = defineComponent({
  name: "Fact",
  description: "An exact scalar field from the captured user data.",
  props: z.object({ ref: z.string(), field: z.string() }).strict(),
  component: ({ props }) => {
    const snapshot = useContext(Snapshots).find((value) => value.ref === props.ref);
    const value = snapshot ? visualFactValue(snapshot, props.field) : null;
    if (value === null) throw new Error("Visual binding unavailable");
    return (
      <Note variant="plan">
        <span>
          {props.field}: <strong>{value}</strong>
        </span>
      </Note>
    );
  }
});
const Section = defineComponent({
  name: "Section",
  description: "A titled group of captured facts.",
  props: z.object({ title: z.string(), children: z.array(z.unknown()).min(1).max(3) }).strict(),
  component: ({ props }) => {
    const render = useRenderNode();
    return (
      <section className="chat-visual__section">
        <SectionHead title={props.title} titleAs="h3" rule />
        {render(props.children)}
      </section>
    );
  }
});
const Reply = defineComponent({
  name: "Reply",
  description: "One to three sections of user-supplied data.",
  props: z.object({ children: z.array(z.unknown()).min(1).max(3) }).strict(),
  component: ({ props }) => {
    const render = useRenderNode();
    return (
      <div className="chat-visual__sections">
        <SectionHead title="Your data" meta="Not independently verified" titleAs="h3" />
        {render(props.children)}
      </div>
    );
  }
});
const library = createLibrary({ components: [Reply, Section, Fact], root: "Reply" });

export default function VisualRenderer({ reply }: { reply: VisualReplyV1 }) {
  const [failed, setFailed] = useState(false);
  const checked = validateVisualCatalogReply(reply);
  if (failed || !checked.ok) return <VisualFallback text={reply.fallbackText} />;
  return (
    <Snapshots.Provider value={checked.reply.snapshots}>
      <Renderer
        library={library}
        response={checked.reply.blocks[0]!.program!}
        isStreaming={false}
        publishObservability={false}
        toolProvider={null}
        onError={(errors) => {
          if (errors.length) setFailed(true);
        }}
      />
    </Snapshots.Provider>
  );
}
