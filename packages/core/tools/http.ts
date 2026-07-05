import { z } from "zod";
import type { PermissionEngine } from "../permissions/engine.ts";
import { defineTool, type NativeTool } from "./types.ts";

const MAX_BODY_CHARS = 8_000;

/** Options for {@linkcode createHttpRequestTool}. */
export interface HttpRequestOptions {
  /** Engine that decides which hosts are reachable. */
  permissions: PermissionEngine;
  /** Injectable for tests. */
  fetch?: typeof fetch;
  /** Abort the request after this long. Defaults to 30s. */
  timeoutMs?: number;
}

/** Build the http_request native tool: fetches allowlisted hosts, truncating long bodies. */
export function createHttpRequestTool(opts: HttpRequestOptions): NativeTool {
  const doFetch = opts.fetch ?? fetch;
  const timeoutMs = opts.timeoutMs ?? 30_000;
  return defineTool({
    name: "http_request",
    description:
      "Make an HTTP request and return the status and body. Only hosts in the agent's net allowlist are permitted.",
    schema: z.strictObject({
      method: z.enum(["GET", "POST", "PUT", "PATCH", "DELETE", "HEAD"]).default("GET"),
      url: z.url(),
      headers: z.record(z.string(), z.string()).optional(),
      body: z.string().optional(),
    }),
    readOnly: false, // POST/PUT mutate; the loop serializes to stay safe
    async execute({ method, url, headers, body }) {
      const host = new URL(url).hostname;
      const decision = opts.permissions.net(host);
      if (!decision.allowed) return decision.reason!;

      const res = await doFetch(url, {
        method,
        headers,
        body,
        signal: AbortSignal.timeout(timeoutMs),
        redirect: "manual", // a redirect must not smuggle the request to an unlisted host
      });
      const text = await res.text();
      const truncated = text.length > MAX_BODY_CHARS
        ? text.slice(0, MAX_BODY_CHARS) + `\n[truncated at ${MAX_BODY_CHARS} chars]`
        : text;
      return JSON.stringify({
        status: res.status,
        content_type: res.headers.get("content-type") ?? "",
        body: truncated,
      });
    },
  });
}
