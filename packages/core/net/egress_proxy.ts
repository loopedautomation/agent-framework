import { logInfo } from "../runtime/log.ts";

/**
 * A filtering forward proxy: the layer that makes `permissions.net` true for
 * traffic the app-level engine cannot see.
 *
 * `http_request` is checked by the permission engine, but a `permissions.run`
 * grant or a stdio MCP server spawns a process, and that process's sockets
 * never pass through the engine. The Deno sandbox cannot help either: an agent
 * that spawns anything gets a broad `--allow-net`, because the subprocess is
 * outside the sandbox by design. The container is the only boundary left, and
 * a container with a default route reaches the whole internet.
 *
 * So the allowlist moves to a place a subprocess cannot walk around: a proxy
 * in its own container, with the agent on a network that has no other way
 * out. `gh`, `curl`, `git` over HTTPS and Deno's own `fetch` all honour
 * `HTTP_PROXY`, so the polite path and the enforced path are the same one.
 *
 * TLS is not terminated. A hostname allowlist only needs the CONNECT line, and
 * terminating would hand this process every credential the agent sends.
 */

/** How a request was resolved, for the audit line and the tests. */
export type EgressDecision = "allowed" | "denied";

/** One proxied request, after the allowlist has spoken. */
export interface EgressEvent {
  /** Host the client asked for, without the port. */
  host: string;
  /** Port it asked for. */
  port: number;
  /** Whether it was let through. */
  decision: EgressDecision;
}

/** Options for {@linkcode startEgressProxy}. */
export interface EgressProxyOptions {
  /**
   * Hosts that may be reached, in `permissions.net` syntax: exact names,
   * `*.example.com` for subdomains, or a bare `*` for everything.
   */
  hosts: string[];
  /** Port to listen on; 0 picks a free one, which the return value reports. */
  port?: number;
  /** Address to bind. Defaults to every interface, since peers are other containers. */
  hostname?: string;
  /** Called for every decision. Defaults to a log line naming the host. */
  onEvent?: (event: EgressEvent) => void;
}

/** A running proxy. */
export interface EgressProxy {
  /** The port it is listening on. */
  readonly port: number;
  /** Stop listening and drop in-flight tunnels. */
  close(): void;
  /** Resolves when the listener has stopped. */
  readonly done: Promise<void>;
}

/** Same rule as the permission engine: `*.example.com` matches subdomains, not the apex. */
function hostMatches(pattern: string, host: string): boolean {
  if (pattern === "*") return true;
  if (pattern.startsWith("*.")) return host.endsWith(pattern.slice(1)) && host !== pattern.slice(2);
  return pattern === host;
}

/** Whether `host` is in the allowlist. */
export function egressAllowed(hosts: string[], host: string): boolean {
  return hosts.some((p) => hostMatches(p, host));
}

/**
 * The body a refused client gets back. It names the host and the exact line
 * to add, because the alternative is an operator staring at a connection
 * error with no idea which allowlist refused it.
 */
export function refusalBody(host: string): string {
  return `egress denied: "${host}" is not in this agent's permissions.net allowlist.\n` +
    `Add it to agent.yaml if the agent should reach it:\n\n` +
    `permissions:\n  net: ["${host}"]\n`;
}

/** Split `example.com:443` into its parts; the port is required by the CONNECT grammar. */
function parseAuthority(authority: string): { host: string; port: number } | undefined {
  // A bracketed IPv6 literal keeps its brackets in the host position.
  const match = authority.match(/^(\[[^\]]+\]|[^:]+):(\d+)$/);
  if (!match) return undefined;
  const port = Number(match[2]);
  if (!Number.isInteger(port) || port < 1 || port > 65535) return undefined;
  return { host: match[1], port };
}

/** Read bytes until the end of the request head, or give up. */
async function readHead(conn: Deno.Conn): Promise<string | undefined> {
  const chunks: Uint8Array[] = [];
  let total = 0;
  const buf = new Uint8Array(1024);
  // A head this large is not a request we are going to understand, and reading
  // without a bound is how a proxy becomes a memory sink.
  while (total < 16 * 1024) {
    const n = await conn.read(buf);
    if (n === null) return undefined;
    chunks.push(buf.slice(0, n));
    total += n;
    const text = new TextDecoder().decode(concat(chunks));
    if (text.includes("\r\n\r\n")) return text;
  }
  return undefined;
}

function concat(chunks: Uint8Array[]): Uint8Array {
  const out = new Uint8Array(chunks.reduce((n, c) => n + c.length, 0));
  let at = 0;
  for (const c of chunks) {
    out.set(c, at);
    at += c.length;
  }
  return out;
}

async function write(conn: Deno.Conn, text: string): Promise<void> {
  try {
    await conn.write(new TextEncoder().encode(text));
  } catch {
    // The client hung up mid-refusal. Nothing to do and nothing to report.
  }
}

/**
 * Start the proxy. Handles `CONNECT host:port` (every HTTPS client) and
 * absolute-URI requests (plain HTTP), checking the host in both cases.
 */
export function startEgressProxy(opts: EgressProxyOptions): EgressProxy {
  const onEvent = opts.onEvent ??
    ((e: EgressEvent) =>
      logInfo(
        e.decision === "denied"
          ? `egress denied: ${e.host}:${e.port} is not in permissions.net`
          : `egress: ${e.host}:${e.port}`,
      ));
  const listener = Deno.listen({
    hostname: opts.hostname ?? "0.0.0.0",
    port: opts.port ?? 0,
  });
  const port = (listener.addr as Deno.NetAddr).port;
  let closed = false;

  const done = (async () => {
    for await (const conn of listener) {
      handle(conn).catch(() => {
        try {
          conn.close();
        } catch { /* already gone */ }
      });
    }
  })().catch(() => {
    // listener.close() during accept surfaces here; a deliberate close is not
    // an error worth propagating.
  });

  async function handle(conn: Deno.Conn) {
    const head = await readHead(conn);
    if (head === undefined) {
      conn.close();
      return;
    }
    const requestLine = head.split("\r\n")[0] ?? "";
    const [method, target] = requestLine.split(" ");

    let host: string | undefined;
    let port_: number | undefined;
    if (method === "CONNECT") {
      const parsed = parseAuthority(target ?? "");
      host = parsed?.host;
      port_ = parsed?.port;
    } else if (target?.includes("://")) {
      try {
        const url = new URL(target);
        host = url.hostname;
        port_ = Number(url.port) || (url.protocol === "https:" ? 443 : 80);
      } catch { /* falls through to the 400 below */ }
    }

    if (host === undefined || port_ === undefined) {
      // A relative-path request means someone pointed a browser at the proxy
      // rather than through it. Say so rather than looking broken.
      await write(
        conn,
        "HTTP/1.1 400 Bad Request\r\nContent-Type: text/plain\r\nConnection: close\r\n\r\n" +
          "this is a forward proxy; send an absolute URI or CONNECT\n",
      );
      conn.close();
      return;
    }

    // A bracketed literal is the wire form; the allowlist speaks in bare hosts.
    const bare = host.startsWith("[") ? host.slice(1, -1) : host;
    if (!egressAllowed(opts.hosts, bare)) {
      onEvent({ host: bare, port: port_, decision: "denied" });
      const body = refusalBody(bare);
      await write(
        conn,
        `HTTP/1.1 403 Forbidden\r\nContent-Type: text/plain\r\n` +
          `Content-Length: ${new TextEncoder().encode(body).length}\r\n` +
          `Connection: close\r\n\r\n${body}`,
      );
      conn.close();
      return;
    }

    onEvent({ host: bare, port: port_, decision: "allowed" });

    let upstream: Deno.Conn;
    try {
      upstream = await Deno.connect({ hostname: bare, port: port_ });
    } catch (err) {
      await write(
        conn,
        "HTTP/1.1 502 Bad Gateway\r\nContent-Type: text/plain\r\nConnection: close\r\n\r\n" +
          `cannot reach ${bare}:${port_}: ${(err as Error).message}\n`,
      );
      conn.close();
      return;
    }

    if (method === "CONNECT") {
      await write(conn, "HTTP/1.1 200 Connection established\r\n\r\n");
    } else {
      // Plain HTTP: the head we already consumed has to go upstream verbatim.
      await upstream.write(new TextEncoder().encode(head));
    }

    // Tunnel both ways. Either side closing ends the pair.
    await Promise.allSettled([
      conn.readable.pipeTo(upstream.writable),
      upstream.readable.pipeTo(conn.writable),
    ]);
  }

  return {
    port,
    done,
    close() {
      if (closed) return;
      closed = true;
      listener.close();
    },
  };
}
