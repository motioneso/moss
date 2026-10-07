import { useState } from "react";
import { Badge, Button, Divider, Field, FormLabel, SectionHead, Select } from "@moss/ui";
import { useMeetingSettings } from "./meeting-settings-state.js";
import { MeetingUnlinkDialog } from "./meeting-unlink-dialog.js";
import "./meeting-settings.css";

export function MeetingSettingsForm() {
  const state = useMeetingSettings();
  const [unlink, setUnlink] = useState<{ id: string; name: string } | null>(null);
  return (
    <div className="meeting-settings">
      <SectionHead title="Meetings" titleAs="h1" />
      {state.denied ? (
        <p role="alert" className="jds-hint jds-hint--error">
          Mac access could not be verified. Sign in again.
        </p>
      ) : state.loading ? (
        <p role="status" className="jds-hint">
          Checking your linked Mac…
        </p>
      ) : (
        <>
          <div className="meeting-settings-macs">
            {state.linked.map((session) => {
              const name = session.companion?.displayName ?? session.deviceLabel;
              return (
                <div key={session.id}>
                  <div className="meeting-settings-mac">
                    <strong>{name}</strong>
                    <Badge tone={state.unavailable ? "amber" : "forest"}>
                      {state.unavailable ? "Link status unconfirmed" : "Linked"}
                    </Badge>
                  </div>
                  <Divider />
                </div>
              );
            })}
            {!state.linked.length && !state.unavailable ? (
              <p className="jds-hint">
                No Mac linked. Open Trail Marker and follow its linking instructions.
              </p>
            ) : null}
          </div>
          {state.unavailable ? (
            <p role="status" className="jds-hint">
              Couldn’t confirm the latest Mac connection.{" "}
              <Button variant="link" onClick={state.refresh}>
                Check again
              </Button>
            </p>
          ) : null}
        </>
      )}
      {state.preferences.isPending ? (
        <p role="status" className="jds-hint">
          Loading your meeting settings…
        </p>
      ) : state.preferences.isError ? (
        <p role="alert" className="jds-hint jds-hint--error">
          Couldn’t load your meeting settings.{" "}
          <Button variant="link" onClick={() => void state.preferences.refetch()}>
            Retry loading settings
          </Button>
        </p>
      ) : !state.denied ? (
        <div className="meeting-settings-audio">
          <Field>
            <FormLabel htmlFor="meeting-settings-audio-source">Audio source</FormLabel>
            <Select
              id="meeting-settings-audio-source"
              value={state.data.mode}
              disabled={state.saving}
              onChange={(event) => {
                const mode = event.target.value;
                if (mode === "computer-audio" || mode === "microphone-only") void state.save(mode);
              }}
            >
              {state.data.mode === "selected-app" ? (
                <option value="selected-app" disabled>
                  Selected app (saved)
                </option>
              ) : null}
              <option value="computer-audio">Microphone + system audio</option>
              <option value="microphone-only">Microphone only</option>
            </Select>
          </Field>
          {state.data.requestKey ? (
            <p role="status" className="jds-hint">
              Saving…
            </p>
          ) : null}
          {state.data.error ? (
            <p role="alert" className="jds-hint jds-hint--error">
              {state.data.error}{" "}
              <Button variant="link" onClick={state.retry}>
                Retry
              </Button>
            </p>
          ) : null}
        </div>
      ) : null}
      {!state.denied &&
        state.linked.map((session) => {
          const name = session.companion?.displayName ?? session.deviceLabel;
          return (
            <div key={session.id}>
              <Button
                variant="quiet"
                aria-label={state.linked.length > 1 ? `Unlink ${name}` : undefined}
                disabled={state.saving || !state.links.canChange(session.id, "unlink")}
                onClick={() => setUnlink({ id: session.id, name })}
              >
                Unlink Mac
              </Button>
            </div>
          );
        })}
      {state.links.message ? (
        <p
          role={state.links.failed ? "alert" : "status"}
          className={state.links.failed ? "jds-hint jds-hint--error" : "jds-hint"}
        >
          {state.links.message}
        </p>
      ) : null}
      {unlink && state.linked.some((session) => session.id === unlink.id) ? (
        <MeetingUnlinkDialog
          name={unlink.name}
          pending={state.links.pending}
          allowed={state.links.canChange(unlink.id, "unlink")}
          error={
            state.links.failed && state.links.deviceId === unlink.id ? state.links.message : null
          }
          onClose={() => setUnlink(null)}
          onConfirm={() => {
            void state.links.change(unlink.id, "unlink").then((confirmed) => {
              if (confirmed) setUnlink(null);
            });
          }}
        />
      ) : null}
    </div>
  );
}
