import { useQuery } from "@tanstack/react-query";
import { ArrowLeft, ChevronRight, Folder, FolderCheck, FolderOpen, HardDrive } from "lucide-react";
import { useState } from "react";

import { Button, InfoTip } from "@moss/ui";
import { getNotesSourceDirectories } from "../api/notes-client";
import { getPeopleNotesDirectories } from "../api/people-client";
import { queryKeys } from "../api/query-keys";
import { ApiError } from "../api/client";
import { useAssistantName } from "../api/use-assistant-name";
import { readError } from "./settings-types";

export function shouldShowNotesRootRecovery(error: unknown, rootCount: number): boolean {
  if (error instanceof ApiError) return error.status === 503;
  return error == null && rootCount === 0;
}

export function VaultChooser(props: {
  readonly current: string;
  readonly mode?: "notes" | "people";
  readonly onCancel: () => void;
  readonly onChoose: (path: string) => void;
}) {
  const [path, setPath] = useState<string | null>(props.current || null);
  const mode = props.mode ?? "notes";
  const assistantName = useAssistantName();
  const rootsQuery = useQuery({
    queryKey:
      mode === "people"
        ? queryKeys.people.notesDirectories(null)
        : queryKeys.settings.notesSourceDirectories(null),
    queryFn: () =>
      mode === "people" ? getPeopleNotesDirectories(null) : getNotesSourceDirectories(null),
    retry: false
  });
  const roots = rootsQuery.data?.directories ?? [];
  const syntheticPeopleRecommendation =
    mode === "people" && path === "People" && !roots.some((root) => root.path === "People");
  const directoriesQuery = useQuery({
    queryKey:
      mode === "people"
        ? queryKeys.people.notesDirectories(path)
        : queryKeys.settings.notesSourceDirectories(path),
    queryFn: () =>
      mode === "people" ? getPeopleNotesDirectories(path) : getNotesSourceDirectories(path),
    retry: false,
    enabled: path !== null && !syntheticPeopleRecommendation
  });

  const visibleRoots =
    mode === "people" && !roots.some((root) => root.path === "People")
      ? [{ name: "People", path: "People" }, ...roots]
      : roots;
  const directories =
    (path ? directoriesQuery.data?.directories : rootsQuery.data?.directories) ?? [];
  const error = rootsQuery.error ?? (path ? directoriesQuery.error : null);
  const notesRootRecovery =
    mode === "notes" && path === null && shouldShowNotesRootRecovery(error, roots.length);
  const displayError = notesRootRecovery ? null : error;
  const loading = rootsQuery.isLoading || (path !== null && directoriesQuery.isLoading);

  const go = (nextPath: string | null) => {
    setPath(nextPath);
  };

  return (
    <div className="gflow">
      <button type="button" className="gflow__back" onClick={props.onCancel}>
        <ArrowLeft size={15} aria-hidden="true" />
        Data sources
      </button>
      <div className="gflow__intro">
        <span className="msub__mark">
          <HardDrive size={21} aria-hidden="true" />
        </span>
        <div className="gflow__introtx">
          <div className="gflow__title">Choose a notes folder</div>
          <div className="gflow__sub">
            {mode === "notes" ? (
              <>
                Browsing folders available on the server
                <InfoTip label="How a folder becomes available">
                  Folders show up here after whoever manages this server adds them to the server
                  setup and restarts it. If the folder you want isn't listed, ask them to add it.
                </InfoTip>
              </>
            ) : (
              "Browsing folders in your own notes"
            )}
          </div>
        </div>
      </div>

      <div className="vbrowse">
        <div className="vbrowse__roots">
          {visibleRoots.map((root) => (
            <button
              key={root.path}
              type="button"
              className={`vroot${path === root.path ? " is-active" : ""}`}
              onClick={() => go(root.path)}
            >
              <Folder size={15} aria-hidden="true" />
              <span className="vroot__main">
                <span className="vroot__label">{root.name}</span>
                <span className="vroot__path">{root.path}</span>
              </span>
            </button>
          ))}
        </div>

        <div className="vbrowse__panel">
          <div className="vcrumb">
            <button
              type="button"
              className="vcrumb__seg"
              disabled={path === null}
              onClick={() => go(null)}
            >
              Available folders
            </button>
            {path ? (
              <>
                <ChevronRight size={13} aria-hidden="true" />
                <span className="vcrumb__seg">{path}</span>
              </>
            ) : null}
          </div>

          <div className="vlist">
            {loading ? (
              <div className="vlist__empty">
                <FolderOpen size={16} aria-hidden="true" />
                Loading folders…
              </div>
            ) : null}
            {displayError ? (
              <div className="vlist__empty">
                <FolderOpen size={16} aria-hidden="true" />
                {readError(displayError)}
              </div>
            ) : null}
            {!loading && !displayError && directories.length === 0 ? (
              <div className="vlist__empty">
                <FolderOpen size={16} aria-hidden="true" />
                No subfolders here — pick "Use this folder" below to choose it.
              </div>
            ) : null}
            {!loading && !displayError
              ? directories.map((directory) => (
                  <button
                    key={directory.path}
                    type="button"
                    className="vitem"
                    onClick={() => go(directory.path)}
                  >
                    <Folder size={16} aria-hidden="true" />
                    <span className="vitem__name">{directory.name}</span>
                    <ChevronRight size={15} aria-hidden="true" />
                  </button>
                ))
              : null}
          </div>

          {mode === "notes" && !loading && notesRootRecovery ? (
            <div className="vlist__empty">
              No notes folders are available to {assistantName}. Ask an operator to mount
              /data/external-notes, set JARVIS_NOTES_ROOTS, and recreate the container.
              <a
                href="/docs/operations/deploy.md#notes-mount"
                target="_blank"
                rel="noopener noreferrer"
              >
                Notes mount recovery
              </a>
            </div>
          ) : null}
        </div>
      </div>

      <div className="vselect">
        <div className="vselect__main">
          <div className="vselect__lbl">Selected folder</div>
          <div className="vselect__path">
            <FolderCheck size={15} aria-hidden="true" />
            {path ?? "No folder selected"}
          </div>
          <div className="vselect__meta">{assistantName} reads this folder and its text files.</div>
        </div>
        <div className="vselect__acts">
          <Button variant="quiet" size="sm" onClick={props.onCancel}>
            Cancel
          </Button>
          <Button
            size="sm"
            disabled={!path || loading || Boolean(displayError)}
            onClick={() => (path ? props.onChoose(path) : undefined)}
            icon={<FolderCheck size={15} />}
          >
            Use this folder
          </Button>
        </div>
      </div>
    </div>
  );
}
