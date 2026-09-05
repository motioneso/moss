import { ButtonLink, Card } from "@moss/ui";

/** Streamed data is untrusted; accept only a saved project's internal destination. */
export function parseWorkshopProjectResult(result: Record<string, unknown> | undefined) {
  const project = result?.project;
  if (!project || typeof project !== "object" || Array.isArray(project)) return null;
  const { id, title } = project as Record<string, unknown>;
  if (
    typeof id !== "string" ||
    !/^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i.test(id) ||
    typeof title !== "string" ||
    !title.trim() ||
    typeof result?.created !== "boolean" ||
    result.destination !== `/workshop/${id}`
  )
    return null;
  return { title, destination: `/workshop/${id}` };
}

export function WorkshopProjectRecord(props: { title: string; destination: string }) {
  return (
    <Card>
      <p role="status">Project saved: {props.title}</p>
      <p>Your request is saved privately. Planning has not started.</p>
      <ButtonLink href={props.destination}>Open project</ButtonLink>
    </Card>
  );
}
