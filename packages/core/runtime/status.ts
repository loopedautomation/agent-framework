import type { AgentService } from "./service.ts";

export interface StatusServerOptions {
  /** Loopback by default — expose deliberately, not accidentally. */
  hostname?: string;
  port?: number;
  /** Bearer token for /runs and /audit. Unset → loopback callers only. */
  token?: string;
  onListen?: (addr: { hostname: string; port: number }) => void;
}

/**
 * The agent's status surface (server-first architecture, v0):
 *   GET /healthz — liveness + identity; unauthenticated (it leaks nothing
 *                  a process list wouldn't)
 *   GET /runs    — recent run history from the audit store
 *   GET /audit   — recent permission decisions
 * Docker HEALTHCHECK hits /healthz from inside the container.
 */
export function startStatusServer(
  service: AgentService,
  opts: StatusServerOptions = {},
): Deno.HttpServer {
  const startedAt = Date.now();
  const hostname = opts.hostname ?? Deno.env.get("LOOPED_STATUS_HOST") ?? "127.0.0.1";
  const port = opts.port ?? Number(Deno.env.get("LOOPED_STATUS_PORT") ?? 9090);
  const token = opts.token ?? Deno.env.get("LOOPED_STATUS_TOKEN");

  const authorized = (req: Request, remoteHost: string): boolean => {
    if (token) return req.headers.get("authorization") === `Bearer ${token}`;
    return remoteHost === "127.0.0.1" || remoteHost === "::1";
  };

  return Deno.serve({
    hostname,
    port,
    onListen: opts.onListen ??
      ((addr) => console.log(`status surface on http://${addr.hostname}:${addr.port}/healthz`)),
  }, (req, info) => {
    const path = new URL(req.url).pathname;
    const remoteHost = info.remoteAddr.transport === "tcp" ? info.remoteAddr.hostname : "";

    switch (path) {
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
        return Response.json({ runs: service.store.recentRuns() });
      case "/audit":
        if (!authorized(req, remoteHost)) {
          return Response.json({ error: "unauthorized" }, { status: 401 });
        }
        return Response.json({ audit: service.store.recentAudit() });
      default:
        return Response.json({ error: "not found" }, { status: 404 });
    }
  });
}
