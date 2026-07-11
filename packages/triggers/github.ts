import { logError, logInfo } from "@looped/core";
import type { AgentEvent, RunResult, Trigger } from "@looped/core";

// The GitHub trigger: a repository or organization webhook POSTs events here,
// each request verified against the webhook secret (X-Hub-Signature-256)
// before the payload is parsed. GitHub sends dozens of event types down one
// hook, so the config names which ones wake the agent, optionally down to the
// action ("pull_request.opened").
//
// There is no reply channel: GitHub expects an acknowledgement, nothing more.
// The agent acts through its own capabilities — typically the gh CLI or
// http_request against api.github.com, granted through permissions.

function timingSafeEqual(a: string, b: string): boolean {
  const enc = new TextEncoder();
  const ab = enc.encode(a);
  const bb = enc.encode(b);
  let diff = ab.length ^ bb.length;
  for (let i = 0; i < Math.max(ab.length, bb.length); i++) {
    diff |= (ab[i % ab.length] ?? 0) ^ (bb[i % bb.length] ?? 0);
  }
  return diff === 0;
}

/** Inputs for {@linkcode verifyGithubSignature}. */
export interface GithubVerifyOptions {
  /** The webhook secret configured on the GitHub webhook. */
  secret: string;
  /** The X-Hub-Signature-256 header: `sha256=<hex>`. */
  signature: string;
  /** The raw request body — the signature is over the exact bytes. */
  body: string;
}

/**
 * Verify a GitHub webhook request: HMAC-SHA256 over the raw body with the
 * webhook secret, hex-encoded, compared timing-safe against the
 * X-Hub-Signature-256 header. An unsigned request never reaches the parser.
 */
export async function verifyGithubSignature(opts: GithubVerifyOptions): Promise<boolean> {
  const key = await crypto.subtle.importKey(
    "raw",
    new TextEncoder().encode(opts.secret),
    { name: "HMAC", hash: "SHA-256" },
    false,
    ["sign"],
  );
  const signed = await crypto.subtle.sign("HMAC", key, new TextEncoder().encode(opts.body));
  const expected = "sha256=" +
    [...new Uint8Array(signed)].map((b) => b.toString(16).padStart(2, "0")).join("");
  return timingSafeEqual(opts.signature, expected);
}

/**
 * Pure filter: does this event pass the allowlist? Patterns are an event name
 * ("pull_request", any action), an event.action pair ("pull_request.opened"),
 * or "*" for everything. (unit-tested)
 */
export function eventAllowed(
  event: string,
  action: string | undefined,
  patterns: string[],
): boolean {
  return patterns.some((p) => {
    const pat = p.trim().toLowerCase();
    if (pat === "*") return true;
    const [pe, pa] = pat.split(".", 2);
    if (pe !== event) return false;
    return pa === undefined || pa === "*" || pa === (action ?? "");
  });
}

/**
 * Pure filter: is the event's repository on the allowlist? Patterns are
 * `owner/repo`, `owner/*` or `*`. An event without a repository (some
 * org-level events) only passes `*`.
 */
export function repoAllowed(fullName: string | undefined, patterns: string[]): boolean {
  return patterns.some((p) => {
    const pat = p.trim().toLowerCase();
    if (pat === "*") return true;
    if (fullName === undefined) return false;
    const name = fullName.toLowerCase();
    if (pat.endsWith("/*")) return name.startsWith(pat.slice(0, -1));
    return name === pat;
  });
}

/** The payload fields the trigger reads. Everything else passes through to rendering. */
export interface GithubPayload {
  action?: string;
  repository?: { full_name?: string };
  sender?: { login?: string };
  // deno-lint-ignore no-explicit-any
  [key: string]: any;
}

const MAX_BODY_CHARS = 2000;
const MAX_FALLBACK_CHARS = 3000;

function clip(text: string, max: number): string {
  return text.length > max ? text.slice(0, max) + "\n[truncated]" : text;
}

/** One line per field that exists; skips the rest. */
function fields(pairs: [string, unknown][]): string[] {
  return pairs
    .filter(([, v]) => v !== undefined && v !== null && v !== "")
    .map(([k, v]) => `${k}: ${v}`);
}

/**
 * Render a GitHub event into the plain-text input the agent sees. The common
 * event types get tailored fields; anything else falls back to the payload
 * itself with the bulky repeated objects pruned, so a new event type is
 * usable the day GitHub ships it.
 */
export function renderGithubEvent(event: string, payload: GithubPayload): string {
  const lines = fields([
    ["GitHub event", payload.action ? `${event}.${payload.action}` : event],
    ["Repository", payload.repository?.full_name],
    ["Sender", payload.sender?.login],
  ]);

  const pr = payload.pull_request;
  const issue = payload.issue;
  const detail: string[] = [];
  if (pr) {
    detail.push(...fields([
      ["Pull request", `#${pr.number} ${pr.title ?? ""}`.trim()],
      ["Branch", pr.head?.ref && pr.base?.ref ? `${pr.head.ref} -> ${pr.base.ref}` : undefined],
      ["State", pr.draft ? "draft" : pr.state],
      ["URL", pr.html_url],
    ]));
    if (pr.body) detail.push("", clip(String(pr.body), MAX_BODY_CHARS));
  } else if (issue) {
    detail.push(...fields([
      ["Issue", `#${issue.number} ${issue.title ?? ""}`.trim()],
      ["State", issue.state],
      [
        "Labels",
        issue.labels?.length
          // deno-lint-ignore no-explicit-any
          ? issue.labels.map((l: any) => l.name ?? l).join(", ")
          : undefined,
      ],
      ["URL", issue.html_url],
    ]));
    if (issue.body) detail.push("", clip(String(issue.body), MAX_BODY_CHARS));
  }

  const comment = payload.comment;
  if (comment) {
    detail.push(...fields([
      ["Comment by", comment.user?.login],
      ["Comment URL", comment.html_url],
    ]));
    if (comment.body) detail.push("", clip(String(comment.body), MAX_BODY_CHARS));
  }

  const review = payload.review;
  if (review) {
    detail.push(...fields([
      ["Review by", review.user?.login],
      ["Review state", review.state],
    ]));
    if (review.body) detail.push("", clip(String(review.body), MAX_BODY_CHARS));
  }

  if (event === "push") {
    detail.push(...fields([
      ["Ref", payload.ref],
      ["Compare", payload.compare],
      ["Commits", payload.commits?.length],
    ]));
    // deno-lint-ignore no-explicit-any
    for (const c of (payload.commits ?? []).slice(0, 10) as any[]) {
      detail.push(`- ${String(c.id ?? "").slice(0, 7)} ${(c.message ?? "").split("\n")[0]}`);
    }
    if ((payload.commits?.length ?? 0) > 10) {
      detail.push(`... and ${payload.commits.length - 10} more`);
    }
  }

  const release = payload.release;
  if (release) {
    detail.push(...fields([
      ["Release", release.tag_name],
      ["Name", release.name],
      ["URL", release.html_url],
    ]));
    if (release.body) detail.push("", clip(String(release.body), MAX_BODY_CHARS));
  }

  const run = payload.workflow_run;
  if (run) {
    detail.push(...fields([
      ["Workflow", run.name],
      ["Status", run.conclusion ?? run.status],
      ["Branch", run.head_branch],
      ["URL", run.html_url],
    ]));
  }

  // Unknown event shape: hand over the payload minus the bulky repeated
  // objects the header already summarized, clipped to a sane size.
  if (detail.length === 0) {
    const { repository: _r, sender: _s, organization: _o, installation: _i, ...rest } = payload;
    if (Object.keys(rest).length > 0) {
      detail.push("", clip(JSON.stringify(rest, null, 1), MAX_FALLBACK_CHARS));
    }
  }

  return [...lines, ...detail].join("\n");
}

/**
 * Conversation key: PR- and issue-scoped events share `github:<repo>#<number>`,
 * so with memory.scope: thread every event about one PR lands in one ongoing
 * conversation. Events without a number (push, release, workflow_run) run
 * one-shot.
 */
export function githubConversationKey(payload: GithubPayload): string | undefined {
  const repo = payload.repository?.full_name;
  const number = payload.pull_request?.number ?? payload.issue?.number;
  if (repo && number !== undefined) return `github:${repo}#${number}`;
  return undefined;
}

/** Options for {@linkcode GithubTrigger}. */
export interface GithubTriggerOptions {
  /** URL path GitHub POSTs webhook deliveries to. */
  path: string;
  /** TCP port to listen on. */
  port: number;
  /** The webhook secret (already resolved from secret_env). */
  secret: string;
  /** Events that wake the agent: "pull_request", "issues.opened", or "*". */
  events: string[];
  /** Repositories the agent handles: `owner/repo`, `owner/*` or `*`. Defaults to all. */
  repos?: string[];
  /** Injectable for tests: 0 picks an ephemeral port. */
  onListen?: (addr: { port: number }) => void;
}

/**
 * Wakes the agent on GitHub webhook events. Each delivery is verified against
 * the webhook secret and filtered by event and repository before the agent
 * runs; the delivery is acknowledged immediately and the run happens after,
 * because GitHub times out slow endpoints at ten seconds.
 */
export class GithubTrigger implements Trigger {
  /** Trigger name, used as the event's `trigger` field. */
  readonly name = "github";
  #opts: GithubTriggerOptions;
  #server?: Deno.HttpServer;
  #inflight = new Set<Promise<void>>();

  /** Create the trigger; no server runs until {@linkcode start}. */
  constructor(opts: GithubTriggerOptions) {
    this.#opts = opts;
  }

  /** Start the HTTP server; each verified, allowlisted delivery wakes the agent. */
  start(emit: (event: AgentEvent) => Promise<RunResult>): Promise<void> {
    const { path, port } = this.#opts;
    this.#server = Deno.serve({
      port,
      onListen: this.#opts.onListen ?? ((addr) => {
        logInfo(`github trigger listening on :${addr.port}${path}`);
      }),
    }, async (req) => {
      const url = new URL(req.url);
      if (url.pathname !== path) return Response.json({ error: "not found" }, { status: 404 });
      if (req.method !== "POST") {
        return Response.json({ error: "method not allowed" }, { status: 405 });
      }

      const body = await req.text();
      const signature = req.headers.get("x-hub-signature-256");
      const verified = signature !== null &&
        await verifyGithubSignature({ secret: this.#opts.secret, signature, body });
      if (!verified) return Response.json({ error: "invalid signature" }, { status: 401 });

      const eventName = req.headers.get("x-github-event") ?? "";
      const deliveryId = req.headers.get("x-github-delivery") ?? crypto.randomUUID();

      let payload: GithubPayload;
      try {
        payload = JSON.parse(body);
      } catch {
        return Response.json({ error: "body must be JSON" }, { status: 400 });
      }

      // GitHub's hook-creation handshake; answering it needs no model call.
      if (eventName === "ping") return Response.json({ pong: true });

      if (!eventAllowed(eventName, payload.action, this.#opts.events)) {
        return Response.json({ ignored: "event not in events list" });
      }
      if (this.#opts.repos && !repoAllowed(payload.repository?.full_name, this.#opts.repos)) {
        return Response.json({ ignored: "repository not in repos list" });
      }

      // Ack now, run the agent async: GitHub retries nothing and times out
      // at ten seconds, and a run is usually far longer than that.
      const task = emit({
        id: deliveryId,
        trigger: this.name,
        input: renderGithubEvent(eventName, payload),
        conversationKey: githubConversationKey(payload),
      }).then((result) => {
        if (result.status !== "ok") {
          logError(`github: run for ${eventName} (${deliveryId}) ended ${result.status}`);
        }
      }).catch((err) => {
        logError(`github: processing failed: ${(err as Error).message}`);
      });
      this.#inflight.add(task);
      task.finally(() => this.#inflight.delete(task));
      return Response.json({ accepted: true }, { status: 202 });
    });
    return Promise.resolve();
  }

  /** Shut down the HTTP server and wait for in-flight runs to finish. */
  async stop(): Promise<void> {
    await this.#server?.shutdown();
    await Promise.allSettled([...this.#inflight]);
  }
}
