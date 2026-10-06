import { useState, type ReactNode } from "react";
import { Link } from "react-router";
import {
  Badge,
  Button,
  Field,
  FormLabel,
  RowIndex,
  RowIndexItem,
  SectionHead,
  Select,
  Switch
} from "@moss/ui";
import type { MeetingCapturePermission } from "@moss/shared";
import type { MeetingSettingsState } from "./meeting-settings-state.js";
import { useMeetingDate } from "./locale.js";
import { MeetingUnlinkDialog } from "./meeting-unlink-dialog.js";

export function MeetingSettingsSection({
  number,
  title,
  description,
  children
}: {
  readonly number: string;
  readonly title: string;
  readonly description?: string;
  readonly children: ReactNode;
}) {
  return (
    <section className="meeting-settings-section">
      <SectionHead number={number} title={title} rule />
      <div className="meeting-settings-section__body">
        {description ? <p className="jds-hint">{description}</p> : null}
        {children}
      </div>
    </section>
  );
}
export function MeetingMacSettings({
  state,
  onRunSetup
}: {
  readonly state: MeetingSettingsState;
  readonly onRunSetup?: () => void;
}) {
  const { sessions, capabilities, devices, device, data, chooseDevice, saving } = state;
  const [unlink, setUnlink] = useState<{ id: string; name: string } | null>(null);
  const date = useMeetingDate({
    month: "short",
    day: "numeric",
    hour: "numeric",
    minute: "2-digit"
  });
  const linked = sessions.data?.sessions.filter((session) => session.source === "companion") ?? [];
  if (state.macAccessDenied)
    return (
      <MeetingSettingsSection number="01" title="Your Mac">
        <p role="alert" className="jds-hint jds-hint--error">
          Mac access could not be verified. Sign in again or check Profile settings.
        </p>
        <Link to="/settings?section=profile">Open Profile settings</Link>
      </MeetingSettingsSection>
    );
  return (
    <MeetingSettingsSection
      number="01"
      title="Your Mac"
      description="Moss listens through Trail Marker on your Mac. Linking never starts recording."
    >
      {sessions.isPending || capabilities.isPending || devices.isPending ? (
        <p role="status" className="jds-hint">
          Checking your linked Macs…
        </p>
      ) : null}
      {sessions.isError || capabilities.isError || devices.isError ? (
        <p role="status" className="jds-hint">
          Couldn’t confirm the latest Mac connection. Your source choices are kept.
        </p>
      ) : null}
      {linked.length ? (
        <div className="meeting-settings-macs">
          <RowIndex density="compact">
            {linked.map((session) => {
              const capability = capabilities.data?.devices.find(
                (item) => item.deviceId === session.id
              );
              const connected = devices.data?.devices.some((item) => item.deviceId === session.id);
              const name = session.companion?.displayName ?? session.deviceLabel;
              return (
                <RowIndexItem
                  key={session.id}
                  title={name}
                  excerpt={
                    <span>
                      Trail Marker
                      {session.companion?.appVersion ? ` ${session.companion.appVersion}` : ""}
                      {" · "}Last contact{" "}
                      {date(session.companion?.lastContactAt ?? session.lastSeenAt)}
                      {" · "}
                      {capabilities.isError
                        ? "Recording access could not be checked"
                        : capabilities.isPending
                          ? "Checking recording access"
                          : !capability
                            ? "Recording access is not available"
                            : capability.state === "approved"
                              ? "Meeting recording enabled"
                              : capability.state === "revoked"
                                ? "Recording permission revoked"
                                : "Update recording access in Profile settings"}
                      {" · "}
                      {devices.isError
                        ? "Connection not confirmed"
                        : connected
                          ? "Connected"
                          : "Open Trail Marker to reconnect"}
                    </span>
                  }
                  meta={
                    <div className="meeting-settings-stack">
                      <Badge tone={sessions.isError ? "amber" : "forest"}>
                        {sessions.isError ? "Link status unconfirmed" : "Linked"}
                      </Badge>
                      <Switch
                        ariaLabel={`Meeting recording on ${name}`}
                        label="Meeting recording"
                        checked={capability?.state === "approved"}
                        disabled={saving || !state.links.canChange(session.id, "revoke")}
                        onChange={(enabled) => {
                          if (!enabled) void state.links.change(session.id, "revoke");
                        }}
                      />
                      <Button
                        variant="secondary"
                        disabled={saving || !state.links.canChange(session.id, "unlink")}
                        onClick={() => setUnlink({ id: session.id, name })}
                      >
                        Unlink
                      </Button>
                    </div>
                  }
                />
              );
            })}
          </RowIndex>
        </div>
      ) : !sessions.isPending && !sessions.isError ? (
        <p role="status" className="jds-hint">
          No Mac is linked. Open Trail Marker on your Mac and connect it to this Moss account.
        </p>
      ) : null}
      <Field>
        <FormLabel htmlFor="meeting-settings-mac">Recording Mac</FormLabel>
        <Select
          id="meeting-settings-mac"
          value={data.deviceId}
          disabled={saving}
          onChange={(event) => chooseDevice(event.target.value)}
        >
          <option value="">Choose a connected Mac</option>
          {data.deviceId && !device ? (
            <option value={data.deviceId}>Saved Mac is not connected</option>
          ) : null}
          {state.visibleDevices.map((item) => (
            <option key={item.deviceId} value={item.deviceId}>
              {item.deviceName}
            </option>
          ))}
        </Select>
      </Field>
      {device?.busy ? (
        <p role="status" className="jds-hint">
          This Mac has a meeting in progress. Changes apply to the next Start or Resume.
        </p>
      ) : null}
      <div className="meeting-settings-actions">
        <Link to="/settings?section=profile">Link a Mac or enable recording access</Link>
        {onRunSetup ? (
          <Button variant="secondary" disabled={saving} onClick={onRunSetup}>
            Run setup again
          </Button>
        ) : null}
      </div>
      <p className="jds-hint">
        Turning off meeting recording keeps the Mac linked. To enable it again, request a connection
        update in Trail Marker and approve it in Profile settings. Recording permission stays on
        until you turn it off, unlink the Mac, or its device access expires.
      </p>
      {state.links.message ? (
        <p
          role={state.links.failed ? "alert" : "status"}
          className={state.links.failed ? "jds-hint jds-hint--error" : "jds-hint"}
        >
          {state.links.message}
        </p>
      ) : null}
      {unlink && linked.some((session) => session.id === unlink.id) ? (
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
    </MeetingSettingsSection>
  );
}
function permissionLabel(permission: MeetingCapturePermission | undefined): string {
  return permission === "granted"
    ? "Allowed"
    : permission === "denied"
      ? "Not allowed yet"
      : "Not confirmed yet";
}
export function MeetingReadiness({
  state,
  setup
}: {
  readonly state: MeetingSettingsState;
  readonly setup: boolean;
}) {
  const { device, devices, availability } = state;
  const inventory = device?.inventory;
  const summary = availability.data?.generationAvailability;
  return (
    <div className="meeting-settings-stack">
      <RowIndex density="compact">
        <RowIndexItem
          title="Microphone"
          excerpt="Your voice or the room"
          meta={
            devices.isError ? "Couldn’t check" : permissionLabel(inventory?.microphonePermission)
          }
        />
        <RowIndexItem
          title="Computer audio"
          excerpt={
            inventory && !inventory.computerAudio.available
              ? "Computer audio is unavailable on this Mac."
              : "Other people on the call"
          }
          meta={
            devices.isError ? "Couldn’t check" : permissionLabel(inventory?.systemAudioPermission)
          }
        />
        <RowIndexItem
          title="Transcripts"
          meta={
            devices.isPending
              ? "Checking…"
              : devices.isError
                ? "Couldn’t check"
                : devices.data?.processingReady
                  ? "Ready"
                  : "Needs a transcription route"
          }
        />
        <RowIndexItem
          title="Summaries"
          meta={
            availability.isPending
              ? "Checking…"
              : availability.isError || summary === "check-failed"
                ? "Couldn’t check"
                : summary === "available"
                  ? "Ready"
                  : "Needs a summary-capable model"
          }
        />
      </RowIndex>
      {inventory &&
      (inventory.microphonePermission !== "granted" ||
        inventory.systemAudioPermission !== "granted") ? (
        <p className="jds-hint">
          On your Mac, open System Settings → Privacy &amp; Security and allow Trail Marker to use
          the microphone and record system audio. Refresh sources in Trail Marker, then check again
          here.
        </p>
      ) : null}
      <div className="meeting-settings-actions">
        <Button variant="secondary" disabled={state.saving} onClick={state.refresh}>
          Check again
        </Button>
        {setup &&
        inventory &&
        (inventory.systemAudioPermission !== "granted" || !inventory.computerAudio.available) &&
        state.data.choice.mode !== "microphone-only" ? (
          <Button
            variant="link"
            disabled={state.saving}
            onClick={() =>
              state.edit({
                choice: { ...state.data.choice, mode: "microphone-only" },
                sourceChanged: true,
                skippedComputerAudio: true
              })
            }
          >
            Skip computer audio
          </Button>
        ) : null}
        <Link to="/settings?section=aiproviders">AI providers</Link>
      </div>
      <p className="jds-hint">
        Transcripts use your configured transcription route. Summaries need an API-key model; CLI
        models cannot write meeting summaries today.
      </p>
    </div>
  );
}
