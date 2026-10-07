import { createServer } from "node:http";
import { mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";

/** Synthetic, local hook transport only; no provider or vault contents are read. */
export async function serveHookGateway(permissionDecision: "allow" | "deny" = "allow") {
  const dir = await mkdtemp(join(tmpdir(), "moss-hook-gateway-"));
  const tokenPath = join(dir, "token");
  await writeFile(tokenPath, "jst_synthetic\n");
  const requests: Array<{ path: string; authorization: string; body: unknown }> = [];
  const server = createServer((req, res) => {
    let body = "";
    req.setEncoding("utf8");
    req.on("data", (chunk) => {
      body += String(chunk);
    });
    req.on("end", () => {
      requests.push({
        path: req.url ?? "",
        authorization: req.headers.authorization ?? "",
        body: JSON.parse(body)
      });
      if (req.url === "/internal/vault-read-report") {
        res.writeHead(204).end();
      } else {
        res.setHeader("content-type", "application/json");
        res.end(JSON.stringify({ decision: permissionDecision, reason: "Synthetic decision" }));
      }
    });
  });
  await new Promise<void>((resolve) => server.listen(0, "127.0.0.1", resolve));
  const address = server.address();
  if (!address || typeof address === "string") throw new Error("No synthetic server address");
  const baseUrl = `http://127.0.0.1:${address.port}`;
  return {
    requests,
    mcpServerUrl: `${baseUrl}/api/mcp`,
    env: {
      JARVIS_PERM_TOKEN_FILE: tokenPath,
      JARVIS_PERM_URL: `${baseUrl}/internal/permission`,
      JARVIS_VAULT_READ_REPORT_URL: `${baseUrl}/internal/vault-read-report`
    },
    async close() {
      await new Promise<void>((resolve, reject) =>
        server.close((error) => (error ? reject(error) : resolve()))
      );
      await rm(dir, { recursive: true, force: true });
    }
  };
}
