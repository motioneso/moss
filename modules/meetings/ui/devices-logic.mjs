/** Pure rules for the Devices list and the link approval dialog. */

/** Download addresses for the two companion apps. A null address renders a disabled button. */
export const APP_LINKS = { mac: null, android: null };

const CONNECTED_MS = 5 * 60 * 1000;
const MONTHS = ["Jan", "Feb", "Mar", "Apr", "May", "Jun", "Jul", "Aug", "Sep", "Oct", "Nov", "Dec"];

const when = (iso) => {
  const t = Date.parse(iso ?? "");
  return Number.isFinite(t) ? t : null;
};

/** "Nov 3", or "Nov 3, 2025" when the year differs from now. */
export function shortDate(iso, now = Date.now()) {
  const t = when(iso);
  if (t === null) return "";
  const d = new Date(t);
  const base = `${MONTHS[d.getUTCMonth()]} ${d.getUTCDate()}`;
  return d.getUTCFullYear() === new Date(now).getUTCFullYear() ? base : `${base}, ${d.getUTCFullYear()}`;
}

export const isAndroid = (device) => device.platform === "android";
export const kindWord = (device) => (isAndroid(device) ? "phone" : "Mac");

/** A device counts as connected when it has been heard from in the last five minutes. */
export function isConnected(device, now = Date.now()) {
  const t = when(device.lastContactAt);
  return t !== null && now - t <= CONNECTED_MS && now - t > -CONNECTED_MS;
}

/** The indicator tone and wording for the row. */
export function presence(device, now = Date.now()) {
  if (isConnected(device, now)) return { tone: "ready", text: "Connected" };
  const t = when(device.lastContactAt);
  if (t === null) return { tone: "idle", text: "Not seen yet" };
  const days = Math.floor((now - t) / 86_400_000);
  const day = (n) => new Date(n).getUTCDate();
  if (days <= 0 && day(t) === day(now)) return { tone: "idle", text: "Last seen today" };
  if (days <= 1 && day(t) === day(now - 86_400_000)) return { tone: "idle", text: "Last seen yesterday" };
  return { tone: "idle", text: `Last seen ${shortDate(device.lastContactAt, now)}` };
}

/** "macOS · Linked Nov 3" or "Android · Ring linked · Linked Oct 28". */
export function detailLine(device, now = Date.now()) {
  const created = when(device.createdAt);
  const linked = created !== null && now - created < 120_000 ? "just now" : shortDate(device.createdAt, now);
  return isAndroid(device)
    ? `Android · Ring linked · Linked ${linked}`
    : `${device.platform === "macos" ? "macOS" : "Mac"} · Linked ${linked}`;
}

/** The name the owner typed, or the reason it cannot be used. */
export function renameCheck(raw) {
  const name = String(raw ?? "").trim();
  if (!name) return { error: "Enter a name." };
  if ([...name].length > 64) return { error: "Use 64 characters or fewer." };
  return { name };
}

/** The wording of the approval dialog for one asking device. */
export function approvalCopy(attempt) {
  const phone = attempt.platform === "android";
  const noun = phone ? "phone" : "Mac";
  const can = phone
    ? ["Record meetings when you choose Start", "Bring in recordings from your ring"]
    : [
        ...(attempt.recordingPolicyVersion === 1 ? ["Record meetings when you choose Start"] : []),
        "Send screen history to Backtrack"
      ];
  return {
    title: `Do you recognise this ${noun}?`,
    name: attempt.deviceName,
    os: phone ? "Android" : "macOS",
    can,
    link: phone ? "Link phone" : "Link Mac",
    deny: phone ? "Not this phone" : "Not this Mac"
  };
}

/** The decision body the server expects. Linking a Mac that asked for recording names the policy. */
export function decisionBody(code, approve, attempt) {
  const body = { code, decision: approve ? "approve" : "deny" };
  if (approve && attempt.recordingPolicyVersion === 1) body.recordingPolicyVersion = 1;
  return body;
}

/** Reads the code from an address fragment such as "#code=abc". */
export function codeFromHash(hash) {
  const value = new URLSearchParams(String(hash ?? "").replace(/^#/, "")).get("code");
  return value && /^[A-Za-z0-9_-]{8,128}$/.test(value) ? value : null;
}
