import { VERSION } from "@looped/core";

const META_URL = "https://jsr.io/@looped/af/meta.json";
const DAY_MS = 24 * 60 * 60 * 1000;

interface Cache {
  checkedAt: number;
  latest: string;
}

interface UpdateCheckOptions {
  command?: string;
  currentVersion?: string;
  inContainer?: boolean;
  now?: () => number;
  isTerminal?: () => boolean;
  getEnv?: (name: string) => string | undefined;
  fetch?: typeof fetch;
  readTextFile?: typeof Deno.readTextFile;
  writeTextFile?: typeof Deno.writeTextFile;
  mkdir?: typeof Deno.mkdir;
  stderr?: { writeSync(data: Uint8Array): number };
  cachePath?: string;
  timeoutMs?: number;
}

function parseVersion(version: string): number[] | undefined {
  const match = version.match(/^(\d+)\.(\d+)\.(\d+)(?:[-+].*)?$/);
  if (!match) return undefined;
  return match.slice(1).map(Number);
}

/** True when `latest` is newer than `current`. Unknown shapes compare false. */
export function isNewerVersion(latest: string, current: string): boolean {
  const a = parseVersion(latest);
  const b = parseVersion(current);
  if (!a || !b) return false;
  for (let i = 0; i < 3; i++) {
    if (a[i] > b[i]) return true;
    if (a[i] < b[i]) return false;
  }
  return false;
}

export function updateNotice(latest: string, current: string): string | undefined {
  if (!isNewerVersion(latest, current)) return undefined;
  return `af ${latest} is available; you have ${current}. Run \`af update\`.\n`;
}

function defaultCachePath(getEnv: (name: string) => string | undefined): string | undefined {
  const root = getEnv("XDG_CACHE_HOME") ??
    (getEnv("HOME") ? `${getEnv("HOME")}/.cache` : undefined);
  return root ? `${root}/looped/af-update.json` : undefined;
}

function cacheFresh(cache: Cache | undefined, now: number): cache is Cache {
  return cache !== undefined && Number.isFinite(cache.checkedAt) && now - cache.checkedAt < DAY_MS;
}

async function readCache(
  path: string | undefined,
  readTextFile: typeof Deno.readTextFile,
): Promise<Cache | undefined> {
  if (!path) return undefined;
  try {
    const data = JSON.parse(await readTextFile(path));
    if (typeof data.latest !== "string" || typeof data.checkedAt !== "number") return undefined;
    return data;
  } catch {
    return undefined;
  }
}

async function writeCache(
  path: string | undefined,
  cache: Cache,
  mkdir: typeof Deno.mkdir,
  writeTextFile: typeof Deno.writeTextFile,
) {
  if (!path) return;
  try {
    await mkdir(path.slice(0, path.lastIndexOf("/")), { recursive: true });
    await writeTextFile(path, JSON.stringify(cache));
  } catch {
    // The update check is advisory; cache failures must never affect the command.
  }
}

function write(stderr: { writeSync(data: Uint8Array): number }, text: string) {
  stderr.writeSync(new TextEncoder().encode(text));
}

async function fetchLatest(
  fetchFn: typeof fetch,
  timeoutMs: number,
): Promise<string | undefined> {
  try {
    const res = await fetchFn(META_URL, { signal: AbortSignal.timeout(timeoutMs) });
    if (!res.ok) {
      await res.body?.cancel();
      return undefined;
    }
    const data = await res.json();
    return typeof data.latest === "string" ? data.latest : undefined;
  } catch {
    return undefined;
  }
}

function shouldCheck(
  opts: Required<Pick<UpdateCheckOptions, "getEnv" | "isTerminal">> & {
    command?: string;
    inContainer?: boolean;
  },
): boolean {
  if (opts.inContainer) return false;
  if (!opts.isTerminal()) return false;
  if (opts.getEnv("CI") || opts.getEnv("AF_NO_UPDATE_CHECK")) return false;
  // `af update` is already the explicit version-checking path.
  if (opts.command === "update") return false;
  return true;
}

/**
 * Best-effort CLI update notice. It is cached, TTY-only and never throws:
 * a broken network or unreadable cache must not change command behavior.
 */
export async function maybeNotifyUpdate(opts: UpdateCheckOptions = {}) {
  try {
    const getEnv = opts.getEnv ?? ((name: string) => Deno.env.get(name));
    const isTerminal = opts.isTerminal ?? (() => Deno.stderr.isTerminal());
    if (
      !shouldCheck({ getEnv, isTerminal, command: opts.command, inContainer: opts.inContainer })
    ) {
      return;
    }

    const current = opts.currentVersion ?? VERSION;
    const now = opts.now?.() ?? Date.now();
    const cachePath = opts.cachePath ?? defaultCachePath(getEnv);
    const readTextFile = opts.readTextFile ?? Deno.readTextFile;
    const writeTextFile = opts.writeTextFile ?? Deno.writeTextFile;
    const mkdir = opts.mkdir ?? Deno.mkdir;
    const stderr = opts.stderr ?? Deno.stderr;
    const fetchFn = opts.fetch ?? fetch;
    const timeoutMs = opts.timeoutMs ?? 750;

    const cached = await readCache(cachePath, readTextFile);
    if (cacheFresh(cached, now)) {
      const notice = updateNotice(cached.latest, current);
      if (notice) write(stderr, notice);
      return;
    }

    const latest = await fetchLatest(fetchFn, timeoutMs);
    if (!latest) return;
    await writeCache(cachePath, { checkedAt: now, latest }, mkdir, writeTextFile);
    const notice = updateNotice(latest, current);
    if (notice) write(stderr, notice);
  } catch {
    // Advisory only: the real command must behave as if the check did not exist.
  }
}
