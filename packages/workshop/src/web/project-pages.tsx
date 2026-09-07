import { useState } from "react";
import { useInfiniteQuery, useMutation, useQuery, useQueryClient } from "@tanstack/react-query";
import { Link, useNavigate, useParams } from "react-router";
import {
  Button,
  ButtonLink,
  Card,
  EmptyState,
  Masthead,
  RowIndex,
  RowIndexItem
} from "@moss/ui";
import { ActivityPeek, ApiError, Thread, randomUuid, usePageTrail } from "@moss/module-web-sdk";
import type {
  LocaleSettingsDto,
  TranscriptRecord,
  WorkshopFeedEntry,
  WorkshopProjectCursor
} from "@moss/shared";
import { formatDate, useUserLocale } from "./locale.js";
import {
  createProject,
  getProject,
  listMessages,
  listProjects,
  projectKeys,
  saveMessage
} from "./project-client.js";

/**
 * A short, user-locale date for a project card's meta line.
 *
 * A row that fails to parse simply loses its date rather than crashing the list — the timestamp is
 * decoration here, and the project itself is still readable and openable without it.
 */
function formatStartedOn(createdAt: string, locale: LocaleSettingsDto): string {
  const at = new Date(createdAt);
  if (Number.isNaN(at.getTime())) return "recently";
  return formatDate(createdAt, locale);
}

export function ProjectError({ title, retry }: { title: string; retry: () => void }) {
  return (
    <Card>
      <div role="alert">
        <p className="workshop-status">{title}</p>
        <Button variant="secondary" onClick={retry}>
          Try again
        </Button>
      </div>
    </Card>
  );
}

export function WorkshopProjectList({ canMutate }: { canMutate: boolean }) {
  const locale = useUserLocale();
  const query = useInfiniteQuery({
    queryKey: projectKeys.list,
    queryFn: ({ pageParam }) => listProjects(pageParam),
    initialPageParam: null as WorkshopProjectCursor | null,
    getNextPageParam: (last) => last.nextCursor ?? undefined,
    retry: false,
    refetchOnReconnect: "always"
  });
  const projects = query.data?.pages.flatMap((page) => page.projects) ?? [];
  return (
    <>
      <Masthead
        tone="field"
        title="Your Projects"
        aside={
          <ButtonLink
            href="/workshop/new"
            variant="field"
            size="lg"
            aria-disabled={!canMutate}
            onClick={(event) => {
              if (!canMutate) event.preventDefault();
            }}
          >
            New project
          </ButtonLink>
        }
      />
      {query.isPending ? (
        <p className="workshop-status" role="status">
          Loading your projects…
        </p>
      ) : null}
      {query.isError ? (
        <ProjectError
          title="Your projects could not be loaded. Try again to get the latest saved work."
          retry={() => void query.refetch()}
        />
      ) : null}
      {!query.isPending && !query.isError && projects.length === 0 ? (
        <EmptyState
          title="A small idea is a good start."
          description="Your projects will stay here, from the first question to a finished module."
        >
          <div className="workshop-empty-action">
            <ButtonLink
              href="/workshop/new"
              aria-disabled={!canMutate}
              onClick={(event) => {
                if (!canMutate) event.preventDefault();
              }}
            >
              Start a project
            </ButtonLink>
          </div>
        </EmptyState>
      ) : null}
      {projects.length > 0 ? (
        <RowIndex>
          {projects.map((project) => (
            <RowIndexItem
              key={project.id}
              title={<Link to={`/workshop/${project.id}`}>{project.title}</Link>}
              excerpt={project.initialRequest}
              meta={
                <span className="jds-caption">{formatStartedOn(project.createdAt, locale)}</span>
              }
            />
          ))}
        </RowIndex>
      ) : null}
      {query.hasNextPage ? (
        <div className="workshop-project-more">
          <Button
            variant="secondary"
            disabled={query.isFetching || !canMutate}
            onClick={() => void query.fetchNextPage()}
          >
            {query.isFetchingNextPage ? "Loading…" : "More projects"}
          </Button>
        </div>
      ) : null}
    </>
  );
}

export function WorkshopProjectCreate({ canMutate }: { canMutate: boolean }) {
  const navigate = useNavigate();
  const client = useQueryClient();
  const [requestKey, setRequestKey] = useState(() => randomUuid());
  const [title, setTitle] = useState("");
  const [initialRequest, setInitialRequest] = useState("");
  const [context, setContext] = useState("");
  const mutation = useMutation({
    mutationFn: createProject,
    onSuccess: (result) => {
      void client.invalidateQueries({ queryKey: projectKeys.list });
      navigate(`/workshop/${result.project.id}`);
    }
  });
  const changed = () => {
    if (mutation.isError) {
      setRequestKey(randomUuid());
      mutation.reset();
    }
  };
  return (
    <section className="workshop-project-form">
      <Link className="workshop-back" to="/workshop">
        ← Your projects
      </Link>
      <h1>What would you like to make?</h1>
      <p>Start with what you want it to do. This project is private to you.</p>
      <form
        onSubmit={(event) => {
          event.preventDefault();
          if (canMutate && !mutation.isPending)
            mutation.mutate({ requestKey, title, initialRequest, context });
        }}
      >
        <div className="jds-field">
          <label className="jds-label" htmlFor="project-title">
            Project name
          </label>
          <input
            className="jds-input"
            id="project-title"
            required
            maxLength={160}
            value={title}
            disabled={mutation.isPending}
            onChange={(event) => {
              changed();
              setTitle(event.target.value);
            }}
          />
        </div>
        <div className="jds-field">
          <label className="jds-label" htmlFor="project-idea">
            Your idea
          </label>
          <textarea
            className="jds-textarea"
            id="project-idea"
            required
            maxLength={16384}
            rows={5}
            value={initialRequest}
            disabled={mutation.isPending}
            onChange={(event) => {
              changed();
              setInitialRequest(event.target.value);
            }}
          />
        </div>
        <div className="jds-field">
          <label className="jds-label" htmlFor="project-context">
            Already decided <span>(optional)</span>
          </label>
          <textarea
            className="jds-textarea"
            id="project-context"
            maxLength={16384}
            rows={3}
            value={context}
            disabled={mutation.isPending}
            onChange={(event) => {
              changed();
              setContext(event.target.value);
            }}
          />
          <p className="jds-hint">Include only the details you want saved in this project.</p>
        </div>
        {mutation.isError ? (
          <p className="form-error" role="alert">
            {mutation.error instanceof ApiError && mutation.error.status === 400
              ? "Check your entries. Use a shorter name or message, then try again."
              : "The project could not be confirmed as saved. Your text is still here; retry to check the same request."}
          </p>
        ) : null}
        <div className="workshop-actions">
          <Button
            type="submit"
            disabled={!canMutate || mutation.isPending || !title.trim() || !initialRequest.trim()}
          >
            {mutation.isPending ? "Creating…" : "Create project"}
          </Button>
          <ButtonLink href="/workshop" variant="quiet">
            Cancel
          </ButtonLink>
        </div>
        <p className="jds-hint">Creating a project saves your idea. It does not start a build.</p>
      </form>
    </section>
  );
}

const PROJECT_ID_RE = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

export function WorkshopProjectDetail({ canMutate }: { canMutate: boolean }) {
  const { projectId = "" } = useParams();
  if (!PROJECT_ID_RE.test(projectId))
    return <EmptyState title="This Workshop page was not found" />;
  return <WorkshopProjectContent key={projectId} projectId={projectId} canMutate={canMutate} />;
}

function WorkshopProjectContent({
  projectId,
  canMutate
}: {
  projectId: string;
  canMutate: boolean;
}) {
  const client = useQueryClient();
  const locale = useUserLocale();
  const [text, setText] = useState("");
  const [messageId, setMessageId] = useState(() => randomUuid());
  const [saved, setSaved] = useState(false);
  const project = useQuery({
    queryKey: projectKeys.detail(projectId),
    queryFn: () => getProject(projectId),
    retry: false,
    refetchOnReconnect: "always"
  });
  const messages = useInfiniteQuery({
    queryKey: projectKeys.messages(projectId),
    queryFn: ({ pageParam }) => listMessages(projectId, pageParam),
    initialPageParam: "0",
    getNextPageParam: (last) => (last.entries.length === 50 ? last.nextCursor : undefined),
    retry: false,
    refetchOnReconnect: "always"
  });
  const mutation = useMutation({
    mutationFn: (input: { messageId: string; text: string }) => saveMessage(projectId, input),
    onSuccess: () => {
      setText("");
      setMessageId(randomUuid());
      setSaved(true);
      void client.invalidateQueries({ queryKey: projectKeys.detail(projectId) });
    }
  });
  // The top bar carries the project's name while this page is mounted; before the project
  // loads there is no name to show, so the trail stays clear and the plain section title stands.
  usePageTrail(
    project.data
      ? {
          name: project.data.project.title,
          meta: `Started ${formatStartedOn(project.data.project.createdAt, locale)}`
        }
      : { name: "" }
  );
  if (!project.data) {
    if (project.isError)
      return (
        <ProjectError
          title={
            project.error instanceof ApiError && project.error.status === 404
              ? "This project is not available to you."
              : "This project could not be loaded."
          }
          retry={() => void project.refetch()}
        />
      );
    return <p role="status">Loading your project…</p>;
  }
  const record = project.data.project;
  const entries = messages.data?.pages.flatMap((page) => page.entries) ?? [];
  const awaitingDelivery = entries.some((entry) => entry.delivery === "pending");
  const ready =
    canMutate &&
    !project.isError &&
    !project.isFetching &&
    !messages.isError &&
    !messages.isFetching;
  return (
    <section className="workshop-chat" aria-label="Project conversation">
      {project.isError ? (
        <ProjectError
          title="The project could not be refreshed. Reload it before making changes."
          retry={() => void project.refetch()}
        />
      ) : null}
      {messages.hasNextPage ? (
        <div className="workshop-chat__earlier">
          <Button
            variant="quiet"
            disabled={messages.isFetching || !canMutate}
            onClick={() => void messages.fetchNextPage()}
          >
            {messages.isFetching ? "Loading…" : "Earlier messages"}
          </Button>
        </div>
      ) : null}
      <div className="workshop-chat__history">
        {messages.isPending ? <p role="status">Loading messages…</p> : null}
        {messages.isError ? (
          <ProjectError
            title="Messages could not be refreshed. Your unsent text is still here."
            retry={() => void messages.refetch()}
          />
        ) : null}
        {!messages.isPending && !messages.isError ? (
          <Thread records={workshopTranscript(record, entries)} working={mutation.isPending} />
        ) : null}
        {mutation.isPending ? <ActivityPeek records={[]} inProgress /> : null}
        {awaitingDelivery ? (
          <p className="workshop-chat__caption" role="status">
            Saved · awaiting delivery
          </p>
        ) : null}
      </div>
      <form
        className="workshop-chat__composer"
        onSubmit={(event) => {
          event.preventDefault();
          if (ready && !mutation.isPending) mutation.mutate({ messageId, text });
        }}
      >
        <div className="chatd-input">
          <label className="jds-sr-only" htmlFor="project-message">
            Add to your project
          </label>
          <textarea
            id="project-message"
            rows={3}
            maxLength={16384}
            required
            value={text}
            disabled={mutation.isPending}
            onChange={(event) => {
              if (mutation.isError) {
                setMessageId(randomUuid());
                mutation.reset();
              }
              setSaved(false);
              setText(event.target.value);
            }}
          />
          <button
            type="submit"
            className="chatd-send"
            disabled={!ready || mutation.isPending || !text.trim()}
          >
            {mutation.isPending ? "Sending…" : "Send"}
          </button>
        </div>
        {mutation.isError ? (
          <p role="alert" className="form-error">
            The message could not be confirmed as saved. Your text is still here; retry to check
            the same message.
          </p>
        ) : null}
        {saved ? (
          <p role="status">Saved to this project. No planning or build has started.</p>
        ) : null}
      </form>
    </section>
  );
}

/**
 * The opening request plus the saved feed entries as transcript records, oldest first: your
 * opening request is the first turn, your messages read as your turns, Moss's messages as
 * replies once they exist.
 */
export function workshopTranscript(
  project: { readonly initialRequest: string },
  entries: readonly WorkshopFeedEntry[]
): TranscriptRecord[] {
  return [
    { kind: "user", text: project.initialRequest },
    ...entries.map(
      (entry): TranscriptRecord =>
        entry.kind === "assistant_message"
          ? { kind: "reply", text: entry.text, messageId: entry.messageId }
          : { kind: "user", text: entry.text, messageId: entry.messageId }
    )
  ];
}
