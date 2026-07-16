import type { AgentService } from "./service.ts";
import { logInfo } from "./log.ts";

/** Options for {@linkcode startStatusServer}. Env vars AF_STATUS_* fill any gaps. */
export interface StatusServerOptions {
  /** Loopback by default - exposure is deliberate. */
  hostname?: string;
  /** Port to listen on. Defaults to 9090. */
  port?: number;
  /** Bearer token for /runs and /audit. Unset → loopback callers only. */
  token?: string;
  /** Called with the bound address once listening. */
  onListen?: (addr: { hostname: string; port: number }) => void;
}

/**
 * The agent's status surface (server-first architecture, v0):
 *   GET /healthz — liveness + identity; unauthenticated (it leaks nothing
 *                  a process list wouldn't). /health is an alias.
 *   GET /runs    — recent run history from the audit store
 *   GET /audit   — recent permission decisions
 * Docker HEALTHCHECK hits /healthz from inside the container.
 */
export function startStatusServer(
  service: AgentService,
  opts: StatusServerOptions = {},
): Deno.HttpServer {
  const startedAt = Date.now();
  const hostname = opts.hostname ?? Deno.env.get("AF_STATUS_HOST") ?? "127.0.0.1";
  const port = opts.port ?? Number(Deno.env.get("AF_STATUS_PORT") ?? 9090);
  const token = opts.token ?? Deno.env.get("AF_STATUS_TOKEN");

  const authorized = (req: Request, remoteHost: string): boolean => {
    if (token) return req.headers.get("authorization") === `Bearer ${token}`;
    return remoteHost === "127.0.0.1" || remoteHost === "::1";
  };

  return Deno.serve({
    hostname,
    port,
    onListen: opts.onListen ??
      ((addr) => logInfo(`status surface on http://${addr.hostname}:${addr.port}/healthz`)),
  }, (req, info) => {
    const path = new URL(req.url).pathname;
    const remoteHost = info.remoteAddr.transport === "tcp" ? info.remoteAddr.hostname : "";

    switch (path) {
      case "/health":
      case "/healthz":
        return Response.json({
          ok: true,
          handle: service.config.handle,
          name: service.store.getIdentity("name") ?? service.config.handle,
          model: `${service.config.model.provider}/${service.config.model.id}`,
          triggers: service.config.triggers?.map((t) => t.type) ?? [],
          uptime_s: Math.floor((Date.now() - startedAt) / 1000),
        });
      case "/runs":
        if (!authorized(req, remoteHost)) {
          return Response.json({ error: "unauthorized" }, { status: 401 });
        }
        // The store is already redacted on write; scrubbing again on the way
        // out means an older database, or a row some other path wrote, cannot
        // serve a secret over HTTP.
        return Response.json({ runs: service.redactor.deep(service.store.recentRuns()) });
      case "/audit":
        if (!authorized(req, remoteHost)) {
          return Response.json({ error: "unauthorized" }, { status: 401 });
        }
        return Response.json({ audit: service.redactor.deep(service.store.recentAudit()) });
      default:
        return Response.json({ error: "not found" }, { status: 404 });
    }
  });
}
