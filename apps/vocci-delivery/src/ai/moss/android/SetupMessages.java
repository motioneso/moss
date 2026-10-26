package ai.moss.android;

/** Fixed local explanations; never display vendor response bodies or exception text. */
final class SetupMessages {
    private SetupMessages() { }
    static String explain(Exception error) {
        if (error instanceof MossClient.Rejected) {
            int status = ((MossClient.Rejected) error).status;
            if (status == 409) return "Approval may already have been redeemed. Cancel setup and connect again to recover safely.";
            if (status == 403) return "Moss approval was declined or the account is unavailable. Cancel setup before trying again.";
            if (status == 404 || status == 410) return "Moss approval expired. Cancel setup and connect again.";
        }
        String reason = error instanceof VocciHttp.Failure ? ((VocciHttp.Failure) error).code : error.getMessage();
        if (reason == null) return retry();
        switch (reason) {
            case "origin": return "Enter a complete HTTPS Moss address with no page path, query or account details.";
            case "link_expired": return "Moss approval expired. Cancel setup and connect again.";
            case "setup_origin_pinned": return "Cancel the current setup before changing the Moss address.";
            case "owner_mismatch": return "The Moss account changed. Cancel setup; no new configuration was saved.";
            case "setup_recovery_required": case "configuration_identity_change": return "Existing setup or recordings need recovery. No account or ring was replaced.";
            case "setup_cleanup_required": return "Interrupted setup needs cleanup. Connect to the network and choose Cancel setup.";
            case "ring_identity": return "The physical ring identity did not match. Keep the selected ring nearby and retry.";
            case "ring_challenge": case "ring_start_app": return "The ring did not accept this account's key. Cancel setup and retry the account lookup.";
            case "auth_email_invalid": return "Enter the email address used for your existing Vocci account.";
            case "auth_code_invalid": case "auth_code_incorrect": return "That code was not accepted. Enter the six-digit code and try again.";
            case "auth_code_expired": return "The code expired. Request a new email code.";
            case "auth_resend_wait": case "auth_rate_limited": return "Vocci limits repeated attempts. Wait before requesting another code.";
            case "auth_account_not_found": return "No existing Vocci account was found. Clean up sign-in and check the email. Establish ownership in Vocci first.";
            case "auth_method_unsupported": return "This Vocci account requires a sign-in method this companion does not support yet. Clean up the sign-in; no setup was saved.";
            case "auth_service_rejected": return "Vocci did not accept this client's sign-in request. Clean up the attempt before trying again.";
            case "auth_session_expired": return "The saved Vocci session expired. Clean up sign-in before requesting another code.";
            case "auth_response_invalid": case "auth_client_changed": return "Vocci returned sign-in details this client could not validate. Clean up the sign-in.";
            case "binding_identity_ambiguous": case "binding_response_invalid": return "Vocci returned ring details that cannot be verified. Clean up sign-in and retry the lookup.";
            case "auth_network_unavailable": return "Could not reach Vocci. Check your connection and retry. Unconfirmed session cleanup stays pending.";
            default: return retry();
        }
    }
    private static String retry() { return "Setup did not finish. Check the network, Bluetooth and selected ring, then retry. Unconfirmed cleanup stays pending."; }
}
