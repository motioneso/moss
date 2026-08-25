import { useMutation, useQueryClient } from "@tanstack/react-query";
import { LoaderCircle, TriangleAlert } from "lucide-react";
import { useId, useState, type FormEvent } from "react";

import { Button, Dialog } from "@moss/ui";
import type { MeResponse } from "@moss/shared";
import { DELETE_MY_ACCOUNT_PHRASE } from "@moss/shared";

import { ApiError, deleteMyAccount } from "../api/client";
import { queryKeys } from "../api/query-keys";
import { useFeedback } from "./settings-feedback";
import { Group, Note, Row } from "./settings-ui";
import { readError } from "./settings-types";

/**
 * Self-service account deletion (#239). Renders the Danger-zone row and a
 * destructive dialog that collects the typed confirmation factors the server
 * requires: the account email, the fixed phrase, and (only when the account
 * owns a password credential) the current password. The final action goes
 * through `useFeedback().confirm` (StrictMode-safe — mutate() is called in
 * onConfirm, never inside a setState updater).
 *
 * On a 200 the caller's own session was cascade-destroyed server-side, so the
 * client clears `queryKeys.auth.me` and routes to the signed-out root — the
 * same transition sign-out uses. A 409 surfaces the server's code as guidance.
 */
export function DeleteAccount({ me }: { readonly me: MeResponse }) {
  const { confirm, toast } = useFeedback();
  const queryClient = useQueryClient();
  const [open, setOpen] = useState(false);
  const [confirmEmail, setConfirmEmail] = useState("");
  const [confirmPhrase, setConfirmPhrase] = useState("");
  const [password, setPassword] = useState("");
  const needsPassword = me.hasPasswordCredential;

  const reset = () => {
    setConfirmEmail("");
    setConfirmPhrase("");
    setPassword("");
  };

  const close = () => {
    setOpen(false);
    reset();
  };

  const deleteMutation = useMutation({
    mutationFn: deleteMyAccount,
    onSuccess: () => {
      // The user row (and with it this session) is gone. Drop the cached
      // identity and route to the signed-out root; no follow-up request from
      // the dead session will authenticate (spec §Locked decision 8).
      queryClient.removeQueries({ queryKey: queryKeys.auth.me });
      window.location.assign("/");
    },
    onError: (error: unknown) => {
      close();
      if (error instanceof ApiError && error.code === "bootstrap_owner") {
        toast("The instance owner can't be deleted. Transfer ownership first.", {
          tone: "drift",
          icon: <TriangleAlert size={17} />
        });
      } else if (error instanceof ApiError && error.code === "last_admin") {
        toast("Demote yourself or appoint another admin first.", {
          tone: "drift",
          icon: <TriangleAlert size={17} />
        });
      } else {
        toast(readError(error), { tone: "error", icon: <TriangleAlert size={17} /> });
      }
    }
  });

  const titleId = useId();

  const canSubmit =
    confirmEmail.trim().length > 0 &&
    confirmPhrase === DELETE_MY_ACCOUNT_PHRASE &&
    (!needsPassword || password.length > 0);

  const onSubmit = (event: FormEvent) => {
    event.preventDefault();
    if (!canSubmit || deleteMutation.isPending) return;
    confirm({
      title: "Delete your account permanently?",
      description:
        "This removes your personal data, sessions, and vault files. Audit metadata is kept anonymously. This cannot be undone.",
      confirmLabel: "Delete my account",
      danger: true,
      onConfirm: () =>
        deleteMutation.mutate({
          confirmEmail: confirmEmail.trim(),
          confirmPhrase,
          password: needsPassword ? password : undefined
        })
    });
  };

  return (
    <>
      <Group
        title="Danger zone"
        desc="Irreversible actions. Account deletion is immediate and removes all your personal data."
        tone="danger"
      >
        <Row
          name="Delete account"
          desc="Permanently remove your account, personal data, and vault files."
          control={
            <Button
              variant="danger"
              size="sm"
              onClick={() => setOpen(true)}
              icon={<TriangleAlert size={15} />}
            >
              Delete account
            </Button>
          }
        />
      </Group>

      {open ? (
        <form onSubmit={onSubmit}>
          <Dialog
            className="deldlg"
            onClose={() => {
              if (!deleteMutation.isPending) close();
            }}
            aria-labelledby={titleId}
            title={<span id={titleId}>Delete your account</span>}
            description="This permanently deletes your account, personal data, and vault files. Audit metadata is retained anonymously. You'll be signed out everywhere immediately."
            footer={
              <>
                <Button variant="quiet" onClick={close} disabled={deleteMutation.isPending}>
                  Cancel
                </Button>
                <Button
                  type="submit"
                  variant="danger"
                  disabled={!canSubmit || deleteMutation.isPending}
                >
                  {deleteMutation.isPending ? (
                    <>
                      <LoaderCircle size={15} className="dexp__spin" aria-hidden="true" />
                      Deleting…
                    </>
                  ) : (
                    "Delete my account"
                  )}
                </Button>
              </>
            }
          >
            <div className="deldlg__body">
              <label className="deldlg__field">
                <span className="deldlg__label">
                  Type your email — <code>{me.user.email}</code>
                </span>
                <input
                  className="jds-input"
                  type="email"
                  value={confirmEmail}
                  onChange={(e) => setConfirmEmail(e.target.value)}
                  autoComplete="email"
                  disabled={deleteMutation.isPending}
                  placeholder={me.user.email}
                  aria-label="Confirm your email"
                />
              </label>

              <label className="deldlg__field">
                <span className="deldlg__label">
                  Type the phrase <code>{DELETE_MY_ACCOUNT_PHRASE}</code>
                </span>
                <input
                  className="jds-input"
                  type="text"
                  value={confirmPhrase}
                  onChange={(e) => setConfirmPhrase(e.target.value)}
                  disabled={deleteMutation.isPending}
                  placeholder={DELETE_MY_ACCOUNT_PHRASE}
                  aria-label="Type the confirmation phrase"
                />
              </label>

              {needsPassword ? (
                <label className="deldlg__field">
                  <span className="deldlg__label">Your password</span>
                  <input
                    className="jds-input"
                    type="password"
                    value={password}
                    onChange={(e) => setPassword(e.target.value)}
                    autoComplete="current-password"
                    disabled={deleteMutation.isPending}
                    aria-label="Your current password"
                  />
                </label>
              ) : null}
            </div>

            <Note icon={<TriangleAlert size={13} />}>
              Export your data above before deleting your account.
            </Note>
          </Dialog>
        </form>
      ) : null}
    </>
  );
}
