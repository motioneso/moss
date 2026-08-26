import { createReadStream, existsSync, statSync } from "node:fs";
import { extname, join, normalize, resolve, sep } from "node:path";

import type { FastifyInstance, FastifyReply, FastifyRequest } from "fastify";

import { resolveMossEnv } from "@moss/db";
import { MODULE_IMAGE_CSP_HOSTS } from "@moss/module-registry";

export interface StaticWebOptions {
  readonly distDir?: string;
}

const MIME: Record<string, string> = {
  ".avif": "image/avif",
  ".css": "text/css; charset=utf-8",
  ".gif": "image/gif",
  ".html": "text/html; charset=utf-8",
  ".ico": "image/x-icon",
  ".jpeg": "image/jpeg",
  ".jpg": "image/jpeg",
  ".js": "text/javascript; charset=utf-8",
  ".json": "application/json; charset=utf-8",
  ".map": "application/json; charset=utf-8",
  ".png": "image/png",
  ".svg": "image/svg+xml",
  ".txt": "text/plain; charset=utf-8",
  ".webmanifest": "application/manifest+json; charset=utf-8",
  ".webp": "image/webp",
  ".woff2": "font/woff2"
};

// LOADER-SEAM(sports): img-src extends to the hosts the composed SportsSource declares.
// infra/nginx/jarv1s-web.conf must carry the same img-src (pinned by
// tests/unit/static-web-csp.test.ts).
const IMG_SRC = ["'self'", "data:", ...MODULE_IMAGE_CSP_HOSTS.map((h) => `https://${h}`)].join(" ");

export const SPA_CSP = [
  "default-src 'self'",
  "script-src 'self'",
  "style-src 'self' 'unsafe-inline'",
  `img-src ${IMG_SRC}`,
  "font-src 'self' data:",
  "worker-src 'self'",
  "connect-src 'self'",
  "frame-ancestors 'none'",
  "base-uri 'self'"
].join("; ");

export function defaultWebDistDir(): string {
  return (
    resolveMossEnv(process.env, "JARVIS_WEB_DIST_DIR") ?? resolve(process.cwd(), "apps/web/dist")
  );
}

export function registerStaticWeb(app: FastifyInstance, options: StaticWebOptions = {}): boolean {
  const distDir = resolve(options.distDir ?? defaultWebDistDir());
  const indexPath = join(distDir, "index.html");

  if (!existsSync(indexPath)) {
    app.log.info({ distDir }, "web dist not found; static web serving disabled");
    return false;
  }

  app.setNotFoundHandler((request, reply) => {
    void serveStaticOrSpa(request, reply, distDir, indexPath);
  });
  return true;
}

async function serveStaticOrSpa(
  request: FastifyRequest,
  reply: FastifyReply,
  distDir: string,
  indexPath: string
): Promise<void> {
  if (request.method !== "GET" && request.method !== "HEAD") {
    await reply.callNotFound();
    return;
  }

  const url = request.url.split("?")[0] ?? "/";
  if (url.startsWith("/api/") || url === "/api" || url.startsWith("/health")) {
    sendNotFound(reply);
    return;
  }

  const assetPath = resolveAssetPath(distDir, url);
  if (assetPath && existsSync(assetPath) && statSync(assetPath).isFile()) {
    sendFile(reply, assetPath);
    return;
  }

  const accept = request.headers.accept ?? "";
  const acceptsHtml = accept === "" || accept.includes("text/html") || accept.includes("*/*");
  if (url.includes(".") || !acceptsHtml) {
    // A missing hashed asset (e.g. a stale page still referencing a replaced build's
    // filename) must come back as a real 404 here. This handler IS the Fastify
    // not-found handler, so calling reply.callNotFound() from inside it re-enters
    // Fastify's generic fallback instead — still a 404, but mislabeled
    // "text/plain", which the browser then refuses to use as a stylesheet/script
    // under the app's nosniff header.
    sendNotFound(reply);
    return;
  }

  sendFile(reply, indexPath);
}

function sendNotFound(reply: FastifyReply): void {
  reply.header("Content-Type", "text/plain; charset=utf-8");
  reply.header("X-Content-Type-Options", "nosniff");
  reply.code(404).send("Not Found");
}

function resolveAssetPath(distDir: string, urlPath: string): string | undefined {
  let decoded: string;
  try {
    decoded = decodeURIComponent(urlPath);
  } catch {
    return undefined;
  }
  if (decoded.includes("\0")) {
    return undefined;
  }

  const relative = normalize(decoded.replace(/^\/+/, ""));
  const full = resolve(distDir, relative);
  if (full !== distDir && !full.startsWith(`${distDir}${sep}`)) {
    return undefined;
  }
  return full;
}

function sendFile(reply: FastifyReply, filePath: string): void {
  reply.header("Content-Type", MIME[extname(filePath)] ?? "application/octet-stream");
  reply.header("Content-Security-Policy", SPA_CSP);
  reply.header("X-Content-Type-Options", "nosniff");
  reply.header("Referrer-Policy", "no-referrer");
  reply.header("X-Frame-Options", "DENY");
  reply.send(createReadStream(filePath));
}
