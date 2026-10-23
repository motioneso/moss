import { createLibrary, defineComponent, useRenderNode } from "@openuidev/react-lang";
import { Card, Note, SectionHead } from "@moss/ui";
import { exampleFacts } from "./facts.js";
import { factProps, replyProps, sectionProps } from "./schemas.js";

const Fact = defineComponent({
  name: "Fact",
  description:
    "A fact from the host's explicitly labeled example snapshot. The field chooses its label and value.",
  props: factProps,
  component: ({ props }) => {
    const fact = exampleFacts[props.field];
    return (
      <Note variant="plan">
        <span>
          {fact.label}: <strong>{fact.value}</strong>
        </span>
      </Note>
    );
  }
});

const Section = defineComponent({
  name: "Section",
  description: "One titled group containing one to three Fact components.",
  props: sectionProps,
  component: ({ props }) => {
    const render = useRenderNode();
    return (
      <section className="runtime-section">
        <SectionHead title={props.title} />
        {render(props.children)}
      </section>
    );
  }
});

const Reply = defineComponent({
  name: "Reply",
  description: "The visual reply, containing one to three Section components.",
  props: replyProps,
  component: ({ props }) => {
    const render = useRenderNode();
    return (
      <Card title="Example data">
        <div className="runtime-sections">{render(props.children)}</div>
      </Card>
    );
  }
});

export const library = createLibrary({ components: [Reply, Section, Fact], root: "Reply" });
