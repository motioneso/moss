export function ChatPrivateStatus(props: {
  readonly activating: boolean;
  readonly error: string | null;
  readonly active: boolean;
  readonly ended: boolean;
  readonly onDismissError: () => void;
  readonly onEnd: () => void;
}) {
  return (
    <>
      {props.activating ? (
        <div className="chatd-private is-activating">
          <span>Starting private chat…</span>
        </div>
      ) : null}
      {props.error ? (
        <div className="chatd-private is-error">
          <span>{props.error}</span>
          <button type="button" onClick={props.onDismissError}>
            Dismiss
          </button>
        </div>
      ) : null}
      {props.active ? (
        <div className={`chatd-private${props.ended ? " is-ended" : ""}`}>
          <span>
            {props.ended
              ? "Private chat ended. Start a new chat to continue."
              : "Private chat: not saved to history. Approved actions still keep records."}
          </span>
          <button type="button" onClick={props.onEnd}>
            End
          </button>
        </div>
      ) : null}
    </>
  );
}
