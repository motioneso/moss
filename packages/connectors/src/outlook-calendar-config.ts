import { createHash } from "node:crypto";
import { isUuid } from "@moss/db";
import {
  validateOutlookBrowserEndpoint,
  type OutlookBrowserBinding
} from "./outlook-calendar-browser.js";

export const OUTLOOK_BROWSER_PROVIDER = "outlook-browser-calendar";
export interface OutlookCalendarBinding extends OutlookBrowserBinding {
  readonly ownerUserId: string;
}

/** Optional operator-only binding. Never populated from HTTP or a job payload. */
export function outlookCalendarBinding(
  env: NodeJS.ProcessEnv = process.env
): OutlookCalendarBinding | null {
  const endpoint = env.MOSS_OUTLOOK_BROWSER_ENDPOINT;
  const ownerUserId = env.MOSS_OUTLOOK_BROWSER_OWNER;
  const accountAddress = env.MOSS_OUTLOOK_BROWSER_ACCOUNT;
  if (!endpoint && !ownerUserId && !accountAddress) return null;
  if (
    !endpoint ||
    !ownerUserId ||
    !isUuid(ownerUserId) ||
    !accountAddress ||
    !/^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(accountAddress)
  ) {
    throw new Error("Invalid Outlook browser operator binding");
  }
  return { endpoint: validateOutlookBrowserEndpoint(endpoint), ownerUserId, accountAddress };
}

export const outlookBindingKey = (accountId: string): string =>
  `connector.${accountId}.outlook_binding`;
export function outlookBindingFingerprint(binding: OutlookCalendarBinding): string {
  return createHash("sha256")
    .update(
      JSON.stringify([
        binding.ownerUserId,
        binding.accountAddress.trim().toLowerCase(),
        binding.endpoint
      ])
    )
    .digest("hex");
}
