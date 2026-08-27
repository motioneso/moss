import { getDomain } from "tldts";

export function publisherIdentity(hostname: string): string | null {
  return getDomain(hostname, { allowPrivateDomains: true });
}

export function sameSportsPublisher(left: string, right: string): boolean {
  const identity = publisherIdentity(left);
  return identity !== null && identity === publisherIdentity(right);
}
