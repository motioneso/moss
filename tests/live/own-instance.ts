// Live proofs write owners, connections and gate settings, so they run only on a disposable
// instance. Those take a port from the shared dev range (devports, 5180-5299). Dev's screen
// (5173, and 5443 over https) and prod (1533) sit outside it, as does a URL with no port.
const OWN_PORTS = { first: 5180, last: 5299 };

/** Stops the run unless the base URL names a disposable instance of the operator's own. */
export function requireOwnInstance(baseUrl = process.env.LIVE_BASE_URL): void {
  if (!baseUrl) throw new Error("set LIVE_BASE_URL to your own disposable instance");
  const port = Number(new URL(baseUrl).port);
  if (!(port >= OWN_PORTS.first && port <= OWN_PORTS.last)) {
    throw new Error(`LIVE_BASE_URL ${baseUrl} is not on a disposable instance port (5180-5299)`);
  }
}
