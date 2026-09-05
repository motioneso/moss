// Synthetic OAuth token-info transport; only used inside the network-none proof container.
import assert from "node:assert/strict";
import { execFileSync } from "node:child_process";
import { readFileSync } from "node:fs";
import { createServer } from "node:http";
import { createServer as createHttpsServer } from "node:https";
import { connect } from "node:net";
import { join } from "node:path";

export async function startOAuthFixture(root, token) {
  const certificate = join(root, "fixture.crt");
  const key = join(root, "fixture.key");
  execFileSync(
    "openssl",
    [
      "req",
      "-x509",
      "-newkey",
      "rsa:2048",
      "-nodes",
      "-days",
      "1",
      "-subj",
      "/CN=workshop-oauth-fixture",
      "-addext",
      "subjectAltName=DNS:oauth2.googleapis.com,DNS:www.googleapis.com",
      "-keyout",
      key,
      "-out",
      certificate
    ],
    { stdio: "ignore", timeout: 10_000 }
  );
  const requests = [];
  const sockets = new Set();
  let failure;
  const tls = createHttpsServer(
    { key: readFileSync(key), cert: readFileSync(certificate) },
    async (req, res) => {
      try {
        assert.ok(["/token", "/tokeninfo", "/oauth2/v2/userinfo"].includes(req.url));
        requests.push(req.url);
        assert.ok(requests.length <= 10);
        if (req.url === "/token") {
          assert.equal(req.method, "POST");
          let body = "";
          for await (const chunk of req) {
            body += chunk;
            assert.ok(body.length < 4096);
          }
          const params = new URLSearchParams(body);
          assert.equal(params.get("grant_type"), "refresh_token");
          assert.equal(params.get("refresh_token"), "synthetic-refresh");
        } else assert.equal(req.headers.authorization, `Bearer ${token}`);
        res.setHeader("content-type", "application/json");
        res.end(
          JSON.stringify(
            req.url === "/token"
              ? { access_token: token, expires_in: 3600, token_type: "Bearer" }
              : req.url === "/tokeninfo"
                ? {
                    expires_in: 3600,
                    scope: "openid email https://www.googleapis.com/auth/cloud-platform"
                  }
                : { email: "fixture@example.invalid" }
          )
        );
      } catch (error) {
        failure = error;
        res.writeHead(400).end();
      }
    }
  );
  const proxy = createServer((_req, res) => res.writeHead(400).end());
  for (const server of [tls, proxy])
    server.on("connection", (socket) => {
      sockets.add(socket);
      socket.once("close", () => sockets.delete(socket));
    });
  await new Promise((resolve) => tls.listen(0, "127.0.0.1", resolve));
  proxy.on("connect", (req, client, head) => {
    if (!["oauth2.googleapis.com:443", "www.googleapis.com:443"].includes(req.url)) {
      failure = new Error(
        `Unexpected OAuth fixture CONNECT target: ${String(req.url).slice(0, 160)}`
      );
      client.destroy();
      return;
    }
    // Every permitted CONNECT terminates at our own synthetic TLS server, never the internet.
    const upstream = connect(tls.address().port, "127.0.0.1", () => {
      client.write("HTTP/1.1 200 Connection Established\r\n\r\n");
      if (head.length) upstream.write(head);
      client.pipe(upstream).pipe(client);
    });
    sockets.add(upstream);
    upstream.once("close", () => sockets.delete(upstream));
    upstream.on("error", () => client.destroy());
    client.on("error", () => upstream.destroy());
  });
  await new Promise((resolve) => proxy.listen(0, "127.0.0.1", resolve));
  return {
    env: {
      HTTPS_PROXY: `http://127.0.0.1:${proxy.address().port}`,
      NO_PROXY: "127.0.0.1,localhost",
      NODE_EXTRA_CA_CERTS: certificate
    },
    get requestCount() {
      return requests.length;
    },
    verify(from, missing, refresh) {
      if (failure) throw failure;
      const current = requests.slice(from);
      assert.equal(
        current.includes("/tokeninfo"),
        !missing,
        "Unexpected native OAuth credential lookup"
      );
      assert.equal(current.includes("/token"), !!refresh, "Unexpected native OAuth refresh");
      if (missing) assert.deepEqual(current, []);
    },
    async close() {
      for (const socket of sockets) socket.destroy();
      await Promise.all(
        [tls, proxy].map((server) => new Promise((resolve) => server.close(resolve)))
      );
    }
  };
}
