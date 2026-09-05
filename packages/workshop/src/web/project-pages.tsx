import { useState } from "react";
import { useInfiniteQuery, useMutation, useQuery, useQueryClient } from "@tanstack/react-query";
import { Link, useNavigate, useParams } from "react-router";
import { Button, ButtonLink, Card, EmptyState } from "@moss/ui";
import { ApiError } from "@moss/module-web-sdk";
import type { WorkshopProjectCursor } from "@moss/shared";
import {
  createProject,
  getProject,
  listMessages,
  listProjects,
  projectKeys,
  saveMessage
} from "./project-client.js";

export function ProjectError({ title, retry }: { title: string; retry: () => void }) {
  return (
    <Card>
      <div role="alert">
        <p>{title}</p>
        <Button variant="secondary" onClick={retry}>
          Try again
        </Button>
      </div>
    </Card>
  );
}

export function WorkshopProjectList({ canMutate }: { canMutate: boolean }) {
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
      <header className="workshop-project-heading">
        <div>
          <h1>Your Workshop</h1>
          <p>Start with an idea. Keep your projects and their conversations here.</p>
        </div>
        <ButtonLink
          href="/workshop/new"
          aria-disabled={!canMutate}
          onClick={(event) => {
            if (!canMutate) event.preventDefault();
          }}
        >
          New project
        </ButtonLink>
      </header>
      {query.isPending ? <p role="status">Loading your projects…</p> : null}
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
        />
      ) : null}
      <div className="workshop-project-list">
        {projects.map((project) => (
          <Card key={project.id}>
            <div className="workshop-project-row">
              <div>
                <h2>
                  <Link to={`/workshop/${project.id}`}>{project.title}</Link>
                </h2>
                <p className="workshop-project-excerpt">{project.initialRequest}</p>
              </div>
              <span>Only you</span>
            </div>
          </Card>
        ))}
      </div>
      {query.hasNextPage ? (
        <Button
          variant="secondary"
          disabled={query.isFetching || !canMutate}
          onClick={() => void query.fetchNextPage()}
        >
          {query.isFetchingNextPage ? "Loading…" : "More projects"}
        </Button>
      ) : null}
      <p>
        <Link to="/workshop/legacy">Earlier builds and installed modules</Link>
      </p>
    </>
  );
}

export function WorkshopProjectCreate({ canMutate }: { canMutate: boolean }) {
  const navigate = useNavigate();
  const client = useQueryClient();
  const [requestKey, setRequestKey] = useState(() => crypto.randomUUID());
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
      setRequestKey(crypto.randomUUID());
      mutation.reset();
    }
  };
  return (
    <section className="workshop-project-form">
      <Link to="/workshop">← Your projects</Link>
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

export function WorkshopProjectDetail({ canMutate }: { canMutate: boolean }) {
  const { projectId = "" } = useParams();
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
  const [pane, setPane] = useState<"conversation" | "work">("conversation");
  const [text, setText] = useState("");
  const [messageId, setMessageId] = useState(() => crypto.randomUUID());
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
      setMessageId(crypto.randomUUID());
      setSaved(true);
      void client.invalidateQueries({ queryKey: projectKeys.detail(projectId) });
    }
  });
  if (!project.data) {
    if (project.isError)
      return (
        <>
          <Link to="/workshop">← Your projects</Link>
          <ProjectError
            title={
              project.error instanceof ApiError && project.error.status === 404
                ? "This project is not available to you."
                : "This project could not be loaded."
            }
            retry={() => void project.refetch()}
          />
        </>
      );
    return <p role="status">Loading your project…</p>;
  }
  const record = project.data.project;
  const ready =
    canMutate &&
    !project.isError &&
    !project.isFetching &&
    !messages.isError &&
    !messages.isFetching;
  return (
    <>
      <Link to="/workshop">← Your projects</Link>
      <header className="workshop-project-heading">
        <h1>{record.title}</h1>
        <span>Only you</span>
      </header>
      {project.isError ? (
        <ProjectError
          title="The project could not be refreshed. Reload it before making changes."
          retry={() => void project.refetch()}
        />
      ) : null}
      <div className="workshop-mobile-tabs" aria-label="Project view">
        <Button
          variant="secondary"
          active={pane === "conversation"}
          aria-pressed={pane === "conversation"}
          onClick={() => setPane("conversation")}
        >
          Conversation
        </Button>
        <Button
          variant="secondary"
          active={pane === "work"}
          aria-pressed={pane === "work"}
          onClick={() => setPane("work")}
        >
          Project work
        </Button>
      </div>
      <div className="workshop-project-detail">
        <section
          className={
            pane === "conversation"
              ? "workshop-project-pane"
              : "workshop-project-pane workshop-project-pane--inactive"
          }
          aria-label="Project conversation"
        >
          <h2>Conversation</h2>
          <div className="workshop-project-messages">
            <Card>
              <strong>Your idea</strong>
              <p className="workshop-project-text">{record.initialRequest}</p>
            </Card>
            {messages.data?.pages
              .flatMap((page) => page.entries)
              .map((entry) => (
                <Card key={entry.messageId}>
                  <strong>You</strong>
                  <p className="workshop-project-text">{entry.text}</p>
                  <p className="jds-hint">Saved · awaiting delivery</p>
                </Card>
              ))}
          </div>
          {messages.isPending ? <p role="status">Loading messages…</p> : null}
          {messages.isError ? (
            <ProjectError
              title="Messages could not be refreshed. Your unsent text is still here."
              retry={() => void messages.refetch()}
            />
          ) : null}
          {messages.hasNextPage ? (
            <Button
              variant="secondary"
              disabled={messages.isFetching || !canMutate}
              onClick={() => void messages.fetchNextPage()}
            >
              More messages
            </Button>
          ) : null}
          <form
            onSubmit={(event) => {
              event.preventDefault();
              if (ready && !mutation.isPending) mutation.mutate({ messageId, text });
            }}
          >
            <div className="jds-field">
              <label className="jds-label" htmlFor="project-message">
                Add to your project
              </label>
              <textarea
                className="jds-textarea"
                id="project-message"
                rows={3}
                maxLength={16384}
                required
                value={text}
                disabled={mutation.isPending}
                onChange={(event) => {
                  if (mutation.isError) {
                    setMessageId(crypto.randomUUID());
                    mutation.reset();
                  }
                  setSaved(false);
                  setText(event.target.value);
                }}
              />
            </div>
            {mutation.isError ? (
              <p role="alert" className="form-error">
                The message could not be confirmed as saved. Your text is still here; retry to check
                the same message.
              </p>
            ) : null}
            <Button type="submit" disabled={!ready || mutation.isPending || !text.trim()}>
              {mutation.isPending ? "Saving…" : "Save message"}
            </Button>
            {saved ? (
              <p role="status">Saved to this project. No planning or build has started.</p>
            ) : null}
          </form>
        </section>
        <section
          className={
            pane === "work"
              ? "workshop-project-pane"
              : "workshop-project-pane workshop-project-pane--inactive"
          }
          aria-label="Project work"
        >
          <h2>Project work</h2>
          <EmptyState
            title="No plan yet"
            description="Your idea and messages are saved. Planning is not available yet."
          />
          {record.context ? (
            <Card>
              <h3>Already decided</h3>
              <p className="workshop-project-text">{record.context}</p>
            </Card>
          ) : null}
        </section>
      </div>
    </>
  );
}
