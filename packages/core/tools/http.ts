import { z } from "zod";
import type { PermissionEngine } from "../permissions/engine.ts";
import { defineTool, type NativeTool } from "./types.ts";

const MAX_BODY_CHARS = 8_000;

/** A credential the tool attaches to requests whose URL starts with `url`. */
export interface HttpCredential {
  /** URL prefix this credential applies to; the longest match wins. */
  url: string;
  /** Header to attach it as, e.g. Authorization. */
  header: string;
  /** The resolved header value. Never shown to the model. */
  value: string;
}

/** Options for {@linkcode createHttpRequestTool}. */
export interface HttpRequestOptions {
  /** Engine that decides which hosts are reachable. */
  permissions: PermissionEngine;
  /** Credentials attached after the model's tool call, matched by URL prefix. */
  credentials?: HttpCredential[];
  /** Injectable for tests. */
  fetch?: typeof fetch;
  /** Abort the request after this long. Defaults to 30s. */
  timeoutMs?: number;
}

/** Matching credentials, longest prefix last so a specific endpoint beats a whole host. */
function credentialsFor(credentials: HttpCredential[], url: string): HttpCredential[] {
  const byHeader = new Map<string, HttpCredential>();
  const matches = credentials
    .filter((c) => url.startsWith(c.url))
    .sort((a, b) => a.url.length - b.url.length);
  for (const c of matches) byHeader.set(c.header.toLowerCase(), c);
  return [...byHeader.values()];
}

/** Build the http_request native tool: fetches allowlisted hosts, truncating long bodies. */
export function createHttpRequestTool(opts: HttpRequestOptions): NativeTool {
  const doFetch = opts.fetch ?? fetch;
  const timeoutMs = opts.timeoutMs ?? 30_000;
  const credentials = opts.credentials ?? [];
  const authNote = credentials.length
    ? " Requests to these URLs are authenticated for you, so send no credentials of your own: " +
      credentials.map((c) => c.url).join(", ")
    : "";
  return defineTool({
    name: "http_request",
    description:
      "Make an HTTP request and return the status and body. Only hosts in the agent's net allowlist are permitted." +
      authNote,
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

      // Attached after the model's tool call and last, so a configured
      // credential overrides whatever the model put in the same header. The
      // real value never has to pass through the model's context to be used.
      const merged = new Headers(headers);
      for (const credential of credentialsFor(credentials, url)) {
        merged.set(credential.header, credential.value);
      }

      const res = await doFetch(url, {
        method,
        headers: merged,
        body,
        signal: AbortSignal.timeout(timeoutMs),
        // A redirect must not smuggle the request — or its credential — to an unlisted host.
        redirect: "manual",
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
