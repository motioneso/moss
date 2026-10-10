import { useCallback, useEffect, useRef, useState } from "react";
import type { UIEvent } from "react";
import { ArrowUp } from "lucide-react";
import { useInfiniteQuery, useMutation, useQuery, useQueryClient } from "@tanstack/react-query";
import { Link, useNavigate, useParams } from "react-router";
import { Button, ButtonLink, Dialog, EmptyState, Masthead, RowIndex, RowIndexItem } from "@moss/ui";
import {
  ActivityPeek,
  ApiError,
  BrandMark,
  Thread,
  randomUuid,
  usePageTrail
} from "@moss/module-web-sdk";
import type {
  LocaleSettingsDto,
  TranscriptRecord,
  WorkshopFeedEntry,
  WorkshopProjectCursor
} from "@moss/shared";
import { formatDate, useUserLocale } from "./locale.js";
import {
  createProject,
  deleteProject,
  getProject,
  listMessages,
  listProjects,
  projectKeys,
  renameProject,
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

export function ProjectError({
  title,
  retry,
  retained = false
}: {
  title: string;
  retry: () => void;
  retained?: boolean;
}) {
  const action = (
    <Button variant="secondary" onClick={retry}>
      Try again
    </Button>
  );
  return retained ? (
    <div className="workshop-notice" role="alert">
      <p className="workshop-status jds-caption">{title}</p>
      {action}
    </div>
  ) : (
    <div role="alert">
      <EmptyState title={title}>
        <div className="workshop-empty-action">{action}</div>
      </EmptyState>
    </div>
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
        <p className="workshop-status jds-caption" role="status">
          Loading your projects…
        </p>
      ) : null}
      {query.isError ? (
        <ProjectError
          title="Your projects could not be loaded. Try again to get the latest saved work."
          retained={Boolean(query.data)}
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

/**
 * The pinned composer both windows share: the label for screen readers, the box with the
 * arrow send button inside it, and an error note underneath if the last send failed.
 */
export function WorkshopComposer(props: {
  readonly label: string;
  readonly text: string;
  readonly onTextChange: (text: string) => void;
  readonly sending: boolean;
  readonly sendDisabled: boolean;
  readonly onSubmit: () => void;
  readonly error: string | null;
}) {
  return (
    <form
      className="workshop-chat__composer"
      onSubmit={(event) => {
        event.preventDefault();
        props.onSubmit();
      }}
    >
      <div className="chatd-input">
        <label className="jds-sr-only" htmlFor="project-message">
          {props.label}
        </label>
        <textarea
          id="project-message"
          rows={3}
          maxLength={16384}
          required
          value={props.text}
          disabled={props.sending}
          onChange={(event) => props.onTextChange(event.target.value)}
          onKeyDown={(event) => {
            // Enter sends, like the drawer's composer; Shift+Enter still makes a new line. An
            // Enter halfway through composing (input methods building one character from
            // several key presses) never sends.
            if (event.key === "Enter" && !event.shiftKey && !event.nativeEvent.isComposing) {
              event.preventDefault();
              props.onSubmit();
            }
          }}
        />
        <button
          type="submit"
          className="chatd-send"
          aria-label={props.sending ? "Sending" : "Send"}
          title={props.sending ? "Sending" : "Send"}
          disabled={props.sendDisabled}
        >
          <ArrowUp size={17} aria-hidden="true" />
        </button>
      </div>
      {props.error ? (
        <p role="alert" className="form-error">
          {props.error}
        </p>
      ) : null}
    </form>
  );
}

/** Fixed example requests on the new-project window: they write into the box, never send. */
export const NEW_PROJECT_EXAMPLES = [
  "A word of the day on Today",
  "Track the books I read",
  "A reminder to water the plants"
] as const;

export function WorkshopProjectNew({ canMutate }: { canMutate: boolean }) {
  usePageTrail({ name: "New project" });
  const navigate = useNavigate();
  const client = useQueryClient();
  const [requestKey, setRequestKey] = useState(() => randomUuid());
  const [text, setText] = useState("");
  const mutation = useMutation({
    mutationFn: (input: { requestKey: string; initialRequest: string }) => createProject(input),
    onSuccess: (result) => {
      void client.invalidateQueries({ queryKey: projectKeys.list });
      // The project exists now: replace the URL without a reload and let the detail window
      // mount, which shows the request as the first turn.
      navigate(result.destination, { replace: true });
    }
  });
  const ready = canMutate;
  return (
    <section className="workshop-chat" aria-label="New project">
      <div className="workshop-chat__history">
        <div className="workshop-open chatd-empty">
          <span className="chatd-empty__mark">
            <BrandMark size={22} />
          </span>
          <div className="chatd-empty__title">What would you like to make?</div>
          <div className="chatd-empty__sub">
            Say it in your own words. Moss will ask a few questions, show you the screens, then
            build it.
          </div>
          <div className="chatd-sugg">
            {NEW_PROJECT_EXAMPLES.map((example) => (
              <button
                key={example}
                type="button"
                className="chatd-sugg__btn"
                disabled={mutation.isPending}
                onClick={() => setText(example)}
              >
                {example}
              </button>
            ))}
          </div>
        </div>
      </div>
      <WorkshopComposer
        label="Your idea"
        text={text}
        onTextChange={(next) => {
          if (mutation.isError) {
            setRequestKey(randomUuid());
            mutation.reset();
          }
          setText(next);
        }}
        sending={mutation.isPending}
        sendDisabled={!ready || mutation.isPending || !text.trim()}
        onSubmit={() => {
          if (ready && !mutation.isPending && text.trim())
            mutation.mutate({ requestKey, initialRequest: text });
        }}
        error={
          mutation.isError
            ? "The project could not be confirmed as saved. Your text is still here; retry to check the same request."
            : null
        }
      />
    </section>
  );
}

const PROJECT_ID_RE = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

// A fixed identity on purpose: the trail hook republishes on every new array, so a literal
// here would re-render the top bar on each keystroke in the composer.
const TRAIL_ACTIONS = [{ id: "delete", label: "Delete project" }] as const;

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
  const navigate = useNavigate();
  const locale = useUserLocale();
  const [text, setText] = useState("");
  const [messageId, setMessageId] = useState(() => randomUuid());
  const [confirmingDelete, setConfirmingDelete] = useState(false);
  const keepProjectRef = useRef<HTMLButtonElement>(null);
  // Turns already sent but not yet back from the feed: they render in the thread
  // immediately so sending never looks stuck, and leave as their rows arrive.
  const [pending, setPending] = useState<readonly { messageId: string; text: string }[]>([]);
  const forgetPending = useCallback((sentId: string) => {
    setPending((current) => current.filter((item) => item.messageId !== sentId));
  }, []);
  // A normal chat follows new turns down while the reader is already at the bottom and
  // never yanks them away from earlier messages. Same contract as the chat drawer.
  const historyRef = useRef<HTMLDivElement | null>(null);
  const [stickToBottom, setStickToBottom] = useState(true);
  const AUTOSCROLL_THRESHOLD_PX = 48;
  const handleHistoryScroll = useCallback((event: UIEvent<HTMLDivElement>) => {
    const el = event.currentTarget;
    setStickToBottom(el.scrollHeight - el.scrollTop - el.clientHeight <= AUTOSCROLL_THRESHOLD_PX);
  }, []);
  const scrollHistoryToLatest = useCallback(() => {
    const el = historyRef.current;
    if (el) el.scrollTo({ top: el.scrollHeight, behavior: "auto" });
  }, []);
  const onRename = useCallback(
    async (title: string) => {
      const result = await renameProject(projectId, title);
      client.setQueryData(projectKeys.detail(projectId), { project: result.project });
      void client.invalidateQueries({ queryKey: projectKeys.list });
    },
    [client, projectId]
  );
  const deleteMutation = useMutation({
    mutationFn: () => deleteProject(projectId),
    onSuccess: () => {
      setConfirmingDelete(false);
      void client.invalidateQueries({ queryKey: projectKeys.list });
      navigate("/workshop", { replace: true });
    }
  });
  const onTrailAction = useCallback((id: string) => {
    if (id === "delete") setConfirmingDelete(true);
  }, []);
  const project = useQuery({
    queryKey: projectKeys.detail(projectId),
    queryFn: () => getProject(projectId),
    retry: false,
    refetchOnReconnect: "always"
  });
  const mutation = useMutation({
    mutationFn: (input: { messageId: string; text: string }) => saveMessage(projectId, input),
    onSuccess: () => {
      setMessageId(randomUuid());
      void client.invalidateQueries({ queryKey: projectKeys.detail(projectId) });
      void client.invalidateQueries({ queryKey: projectKeys.messages(projectId) });
    },
    onError: (_error, input) => {
      // A failed save was never stored, so its optimistic turn leaves and the text goes
      // back in the box when there is nothing newer to lose.
      forgetPending(input.messageId);
      setText((current) => (current ? current : input.text));
    }
  });
  const [now, setNow] = useState(() => Date.now());
  const firstSeenRef = useRef(new Map<string, number>());
  const messages = useInfiniteQuery({
    queryKey: projectKeys.messages(projectId),
    queryFn: ({ pageParam }) => listMessages(projectId, pageParam),
    initialPageParam: "0",
    getNextPageParam: (last) => (last.entries.length === 50 ? last.nextCursor : undefined),
    retry: false,
    refetchOnReconnect: "always",
    // While a turn is still on its way the reply can land at any moment: saving, sent
    // but not yet shown, or saved and still awaiting its reply. Otherwise leave the feed alone.
    refetchInterval: (query) => {
      // The feed data can be briefly absent-shaped mid-fetch; only read pages when they
      // are really there so a background poll can never crash the page.
      const pages = query.state.data?.pages;
      const waiting =
        Array.isArray(pages) &&
        isAwaitingReply(
          pendingSince(
            pages.flatMap((page) => page.entries),
            firstSeenRef.current
          ),
          Date.now()
        );
      return mutation.isPending || pending.length > 0 || waiting ? 2000 : false;
    }
  });

  const entries = messages.data?.pages.flatMap((page) => page.entries) ?? [];
  // Only the newest message can be waiting on a reply; older failures were superseded.
  const sentAt = pendingSince(entries, firstSeenRef.current);
  const awaitingDelivery = isAwaitingReply(sentAt, now);
  const unanswered = Number.isFinite(sentAt) && !awaitingDelivery;
  // The feed is oldest-first, so keep loading forward until the newest entry is in hand.
  const { hasNextPage, isFetching, isError, fetchNextPage } = messages;
  useEffect(() => {
    if (hasNextPage && !isFetching && !isError) void fetchNextPage();
  }, [hasNextPage, isFetching, isError, fetchNextPage]);
  // Re-render when the newest pending message passes its give-up time.
  useEffect(() => {
    if (!Number.isFinite(sentAt)) return;
    const wait = sentAt + REPLY_GIVE_UP_MS - Date.now();
    if (wait <= 0) {
      setNow(Date.now());
      return;
    }
    const timer = setTimeout(() => setNow(Date.now()), wait + 50);
    return () => clearTimeout(timer);
  }, [sentAt]);
  // The model is working while a turn is saving, sent but not yet shown, or saved and
  // still awaiting its reply.
  const thinking = mutation.isPending || pending.length > 0 || awaitingDelivery;
  const lastEntryIdRef = useRef<string | null>(null);
  // An optimistic turn leaves the thread the moment its row arrives. A fresh turn at the
  // foot of the thread follows it down while the reader is already there; older pages only
  // ever grow the head, so loading them never moves the reader — including when a load
  // returns nothing new. Thinking joining the thread counts as movement too, so the wait
  // stays in view.
  useEffect(() => {
    const arrived = new Set(entries.map((entry) => entry.messageId));
    if (pending.length > 0 && pending.some((item) => arrived.has(item.messageId))) {
      setPending((current) => current.filter((item) => !arrived.has(item.messageId)));
    }
    const lastId = entries.at(-1)?.messageId ?? null;
    const grown = lastId !== lastEntryIdRef.current;
    if (grown) lastEntryIdRef.current = lastId;
    if (stickToBottom && (grown || thinking)) scrollHistoryToLatest();
  }, [pending, entries, thinking, stickToBottom, scrollHistoryToLatest]);
  // The top bar carries the project's name while this page is mounted; before the project
  // loads there is no name to show, so the trail stays clear and the plain section title stands.
  usePageTrail(
    project.data
      ? {
          name: project.data.project.title,
          meta: `Started ${formatStartedOn(project.data.project.createdAt, locale)}`,
          actions: canMutate ? TRAIL_ACTIONS : undefined,
          onAction: canMutate ? onTrailAction : undefined,
          onRename: canMutate ? onRename : undefined
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
  const arrivedIds = new Set(entries.map((entry) => entry.messageId));
  const transcript = workshopTranscript(record, entries);
  const visibleTranscript =
    pending.length > 0
      ? [
          ...transcript,
          ...pending
            .filter((item) => !arrivedIds.has(item.messageId))
            .map((item) => ({ kind: "user" as const, text: item.text }))
        ]
      : transcript;
  const ready =
    canMutate &&
    !project.isError &&
    !project.isFetching &&
    !messages.isError &&
    !messages.isFetching;
  return (
    <section className="workshop-chat" aria-label="Project conversation">
      {confirmingDelete ? (
        <Dialog
          title="Delete this project?"
          initialFocusRef={keepProjectRef}
          closeLabel="Close delete confirmation"
          closeDisabled={deleteMutation.isPending}
          dismissOnEscape={!deleteMutation.isPending}
          dismissOnBackdrop={!deleteMutation.isPending}
          onClose={() => {
            if (!deleteMutation.isPending) setConfirmingDelete(false);
          }}
          footer={
            <>
              <Button
                ref={keepProjectRef}
                variant="secondary"
                disabled={deleteMutation.isPending}
                onClick={() => setConfirmingDelete(false)}
              >
                Keep it
              </Button>
              <Button
                variant="danger"
                disabled={deleteMutation.isPending || !canMutate}
                onClick={() => deleteMutation.mutate()}
              >
                {deleteMutation.isPending ? "Deleting…" : "Delete project"}
              </Button>
            </>
          }
        >
          <p className="workshop-status jds-caption">
            Delete “{record.title}”? Its messages go with it. This cannot be undone.
          </p>
          {deleteMutation.isError ? (
            <p className="jds-hint jds-hint--error" role="alert">
              The project could not be deleted. Try again.
            </p>
          ) : null}
        </Dialog>
      ) : null}
      {project.isError ? (
        <ProjectError
          title="The project could not be refreshed. Reload it before making changes."
          retained
          retry={() => void project.refetch()}
        />
      ) : null}
      <div className="workshop-chat__history" ref={historyRef} onScroll={handleHistoryScroll}>
        {messages.isPending ? <p role="status">Loading messages…</p> : null}
        {messages.isError ? (
          <ProjectError
            title="Messages could not be refreshed. Your unsent text is still here."
            retained
            retry={() => void messages.refetch()}
          />
        ) : null}
        {messages.data ? <Thread records={visibleTranscript} working={thinking} /> : null}
        {thinking ? <ActivityPeek records={[]} inProgress /> : null}
        {unanswered && !thinking ? (
          <p role="status" className="workshop-status jds-caption">
            Moss did not reply to your last message. Send it again to retry.
          </p>
        ) : null}
      </div>
      <WorkshopComposer
        label="Add to your project"
        text={text}
        onTextChange={(next) => {
          if (mutation.isError) {
            setMessageId(randomUuid());
            mutation.reset();
          }
          setText(next);
        }}
        sending={mutation.isPending}
        sendDisabled={!ready || mutation.isPending || !text.trim()}
        onSubmit={() => {
          // The turn joins the thread now, not when the save returns: the box clears
          // and the message renders immediately, with Thinking covering the wait.
          if (!ready || mutation.isPending || !text.trim()) return;
          const input = { messageId, text };
          setPending((current) => [...current, input]);
          setText("");
          mutation.mutate(input);
        }}
        error={
          mutation.isError
            ? "The message could not be confirmed as saved. Your text is still here; retry to check the same message."
            : null
        }
      />
    </section>
  );
}

// A reply attempt gives up after 45s on the server; later than this a pending row is stale.
const REPLY_GIVE_UP_MS = 90_000;

/**
 * Start time of the newest user message when it is still unanswered, else NaN. The earlier
 * of the server stamp and the time this page first saw the row keeps a client clock that
 * runs behind the server from stretching the wait.
 */
function pendingSince(entries: WorkshopFeedEntry[], firstSeen: Map<string, number>): number {
  const newest = [...entries].reverse().find((entry) => entry.kind === "user_message");
  if (!newest || newest.delivery !== "pending") return NaN;
  if (!firstSeen.has(newest.messageId)) firstSeen.set(newest.messageId, Date.now());
  return Math.min(Date.parse(newest.createdAt), firstSeen.get(newest.messageId)!);
}

function isAwaitingReply(sentAt: number, now: number): boolean {
  return now - sentAt < REPLY_GIVE_UP_MS;
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
