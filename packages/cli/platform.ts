/**
 * Platform commands: deploy and inspect agents hosted on Looped Agents
 * (agents.looped.sh) from the terminal.
 *
 * v1 scope: repo-backed agents only. The platform deploys what's on the
 * connected GitHub branch; `af deploy` makes sure the local checkout is
 * pushed, matches it to the hosted agent by git remote, and triggers a
 * deploy of the branch head. Connecting a repo (the GitHub App install)
 * happens once, in the dashboard.
 *
 * Auth is a team API key with the read:agent / write:agent scopes, minted
 * in the dashboard and stored by `af login`. All calls go through the
 * public gateway (api.looped.sh).
 */

import { resolveAgentConfig } from "@looped/core";
import { fail } from "./docker_commands.ts";
import { accent, dim, err, ok, warn } from "./style.ts";

const DEFAULT_API_URL = "https://api.looped.sh/v1";
const DASHBOARD_URL = "https://agents.looped.sh";
const POLL_INTERVAL_MS = 3_000;
const POLL_TIMEOUT_MS = 5 * 60_000;

interface Credentials {
  apiKey: string;
  apiUrl: string;
}

interface PlatformAgent {
  id: string;
  handle: string;
  sourceType?: "manual" | "github" | null;
  repoFullName?: string | null;
  repoBranch?: string | null;
}

interface Deployment {
  id: string;
  status: "pending" | "deploying" | "healthy" | "failed";
  error?: string | null;
  createdAt?: string;
}

function credentialsPath(): string {
  const configHome = Deno.env.get("XDG_CONFIG_HOME") ??
    `${Deno.env.get("HOME") ?? "."}/.config`;
  return `${configHome}/looped/credentials.json`;
}

async function loadCredentials(): Promise<Credentials | undefined> {
  // Env vars win: CI deploys without a credentials file.
  const envKey = Deno.env.get("LOOPED_API_KEY");
  const apiUrl = Deno.env.get("LOOPED_API_URL") ?? DEFAULT_API_URL;
  if (envKey) return { apiKey: envKey, apiUrl };
  try {
    const raw = JSON.parse(await Deno.readTextFile(credentialsPath()));
    if (typeof raw.apiKey === "string" && raw.apiKey) {
      return { apiKey: raw.apiKey, apiUrl: raw.apiUrl ?? apiUrl };
    }
  } catch {
    // fall through
  }
  return undefined;
}

async function requireCredentials(): Promise<Credentials> {
  const creds = await loadCredentials();
  if (!creds) {
    fail(
      `not logged in — run ${accent("af login")} (or set LOOPED_API_KEY). ` +
        `Keys are minted in the dashboard with the read:agent and write:agent scopes.`,
    );
  }
  return creds;
}

async function api(
  creds: Credentials,
  path: string,
  init?: { method?: string; body?: unknown },
): Promise<Response> {
  const res = await fetch(`${creds.apiUrl}${path}`, {
    method: init?.method ?? "GET",
    headers: {
      "X-API-Key": creds.apiKey,
      ...(init?.body !== undefined ? { "content-type": "application/json" } : {}),
    },
    body: init?.body !== undefined ? JSON.stringify(init.body) : undefined,
  });
  return res;
}

async function apiError(res: Response, fallback: string): Promise<string> {
  const data = await res.json().catch(() => undefined) as
    | { error?: string; missingSecrets?: string[] }
    | undefined;
  let message = data?.error ?? `${fallback} (${res.status})`;
  if (data?.missingSecrets?.length) {
    message += `\n  missing secrets: ${data.missingSecrets.join(", ")}` +
      `\n  add them in the dashboard: ${DASHBOARD_URL}`;
  }
  return message;
}

/** `af login [key]` — verify a team API key against the platform and store it. */
export async function login(keyArg?: string): Promise<void> {
  let apiKey = keyArg;
  if (!apiKey) {
    apiKey = prompt("Paste a Looped API key (from the dashboard):")?.trim();
  }
  if (!apiKey) fail("no key provided");
  const apiUrl = Deno.env.get("LOOPED_API_URL") ?? DEFAULT_API_URL;
  const creds = { apiKey, apiUrl };
  const res = await api(creds, "/agents");
  if (res.status === 401) fail("that key was rejected — check it and try again");
  if (res.status === 403) {
    fail(await apiError(res, "key is valid but lacks the read:agent scope"));
  }
  if (!res.ok) fail(await apiError(res, "could not verify the key"));
  const { agents } = await res.json() as { agents: PlatformAgent[] };
  const path = credentialsPath();
  await Deno.mkdir(path.slice(0, path.lastIndexOf("/")), { recursive: true });
  await Deno.writeTextFile(path, JSON.stringify({ apiKey, apiUrl }, null, 2) + "\n", {
    mode: 0o600,
  });
  console.log(
    `${ok("logged in")} — team has ${agents.length} agent${agents.length === 1 ? "" : "s"} ` +
      dim(`(key stored in ${path})`),
  );
}

/** `af logout` — delete the stored credential. */
export async function logout(): Promise<void> {
  try {
    await Deno.remove(credentialsPath());
    console.log(ok("logged out"));
  } catch {
    console.log(dim("no stored credentials"));
  }
}

async function git(...args: string[]): Promise<string | undefined> {
  try {
    const out = await new Deno.Command("git", {
      args,
      stdout: "piped",
      stderr: "null",
    }).output();
    if (!out.success) return undefined;
    return new TextDecoder().decode(out.stdout).trim();
  } catch {
    return undefined;
  }
}

/** Parse owner/repo out of an https or ssh GitHub remote URL. */
export function parseGithubRemote(url: string): string | undefined {
  const match = url.match(/github\.com[/:]([^/]+\/[^/]+?)(?:\.git)?$/);
  return match?.[1];
}

interface RepoState {
  fullName: string;
  branch: string | undefined;
  dirty: boolean;
  unpushed: boolean;
}

async function repoState(): Promise<RepoState | undefined> {
  const remote = await git("remote", "get-url", "origin");
  if (!remote) return undefined;
  const fullName = parseGithubRemote(remote);
  if (!fullName) return undefined;
  const branch = await git("rev-parse", "--abbrev-ref", "HEAD");
  const status = await git("status", "--porcelain");
  const ahead = await git("rev-list", "--count", "@{upstream}..HEAD");
  return {
    fullName,
    branch: branch === "HEAD" ? undefined : branch,
    dirty: (status ?? "").length > 0,
    unpushed: ahead !== undefined && ahead !== "0",
  };
}

/** Match the local checkout (and optionally its agent.yaml handle) to a
    hosted agent. Repo + branch is the strongest signal; handle breaks ties
    when several agents deploy from one repo. */
export function matchAgent(
  agents: PlatformAgent[],
  repo: RepoState | undefined,
  handle: string | undefined,
): { agent?: PlatformAgent; reason?: string } {
  const repoBacked = agents.filter((a) => a.sourceType === "github");
  if (repo) {
    const sameRepo = repoBacked.filter((a) => a.repoFullName === repo.fullName);
    if (sameRepo.length === 1) return { agent: sameRepo[0] };
    if (sameRepo.length > 1) {
      const sameBranch = repo.branch ? sameRepo.filter((a) => a.repoBranch === repo.branch) : [];
      if (sameBranch.length === 1) return { agent: sameBranch[0] };
      const byHandle = (sameBranch.length ? sameBranch : sameRepo)
        .filter((a) => a.handle === handle);
      if (byHandle.length === 1) return { agent: byHandle[0] };
      return {
        reason: `${sameRepo.length} hosted agents deploy from ${repo.fullName} — ` +
          `pass the agent handle: af deploy --agent <handle>`,
      };
    }
  }
  const byHandle = repoBacked.filter((a) => a.handle === handle);
  if (byHandle.length === 1) return { agent: byHandle[0] };
  return {
    reason: repo
      ? `no hosted agent deploys from ${repo.fullName}. Connect the repo once in the dashboard (${DASHBOARD_URL}), then af deploy works from here on.`
      : `not inside a GitHub-remoted git repo. v1 deploys repo-connected agents only — connect one in the dashboard (${DASHBOARD_URL}).`,
  };
}

/** `af deploy [agent.yaml] [--agent <handle>]` — deploy the connected
    branch's current head to the platform and watch it go healthy. */
export async function deploy(
  configPath: string,
  handleFlag?: string,
): Promise<void> {
  const creds = await requireCredentials();

  // The handle from the local agent.yaml disambiguates multi-agent repos.
  // A missing/invalid local config is fine — the platform deploys from git,
  // not from this checkout.
  let handle = handleFlag;
  if (!handle) {
    try {
      handle = (await resolveAgentConfig(configPath)).handle;
    } catch {
      handle = undefined;
    }
  }

  const repo = await repoState();
  if (repo?.dirty) {
    console.log(
      warn("! uncommitted changes — the platform deploys the pushed branch, not this working tree"),
    );
  }
  if (repo?.unpushed) {
    console.log(warn("! unpushed commits — push first or this deploy won't include them"));
  }

  const listRes = await api(creds, "/agents");
  if (!listRes.ok) fail(await apiError(listRes, "could not list agents"));
  const { agents } = await listRes.json() as { agents: PlatformAgent[] };

  const { agent, reason } = matchAgent(agents, repo, handle);
  if (!agent) fail(reason ?? "no matching hosted agent");

  console.log(
    `deploying ${accent(agent.handle)} ` +
      dim(`(${agent.repoFullName}@${agent.repoBranch} → branch head)`),
  );
  const deployRes = await api(creds, `/agents/${agent.id}/deploy`, {
    method: "POST",
    body: {},
  });
  if (!deployRes.ok) fail(await apiError(deployRes, "deploy rejected"));
  const { deployment } = await deployRes.json() as { deployment: Deployment };

  const outcome = await waitForDeployment(creds, agent.id, deployment.id);
  if (outcome.status === "healthy") {
    console.log(`${ok("✓ healthy")} ${dim(`${DASHBOARD_URL}/agents/${agent.id}`)}`);
    return;
  }
  fail(
    `deployment ${outcome.status}${outcome.error ? `: ${outcome.error}` : ""}\n` +
      `  details: ${DASHBOARD_URL}/agents/${agent.id}`,
  );
}

async function waitForDeployment(
  creds: Credentials,
  agentId: string,
  deploymentId: string,
): Promise<Deployment> {
  const started = Date.now();
  let lastStatus = "";
  while (true) {
    const res = await api(creds, `/agents/${agentId}/deployments`);
    if (res.ok) {
      const { deployments } = await res.json() as { deployments: Deployment[] };
      const current = deployments.find((d) => d.id === deploymentId);
      if (current) {
        if (current.status !== lastStatus) {
          lastStatus = current.status;
          console.log(dim(`  ${current.status}…`));
        }
        if (current.status === "healthy" || current.status === "failed") {
          return current;
        }
      }
    }
    if (Date.now() - started > POLL_TIMEOUT_MS) {
      return {
        id: deploymentId,
        status: "failed",
        error: "timed out waiting for the deployment — check the dashboard",
      };
    }
    await new Promise((resolve) => setTimeout(resolve, POLL_INTERVAL_MS));
  }
}

/** `af agents` — list the team's hosted agents. */
export async function listHostedAgents(): Promise<void> {
  const creds = await requireCredentials();
  const res = await api(creds, "/agents");
  if (!res.ok) fail(await apiError(res, "could not list agents"));
  const { agents } = await res.json() as { agents: PlatformAgent[] };
  if (agents.length === 0) {
    console.log(dim(`no hosted agents yet — ${DASHBOARD_URL}`));
    return;
  }
  for (const agent of agents) {
    const source = agent.sourceType === "github"
      ? `${agent.repoFullName}@${agent.repoBranch}`
      : "manual";
    console.log(`${accent(agent.handle)}  ${dim(source)}`);
  }
}

/** `af status` — live status of the hosted agent matching this checkout. */
export async function hostedStatus(
  configPath: string,
  handleFlag?: string,
): Promise<void> {
  const creds = await requireCredentials();
  let handle = handleFlag;
  if (!handle) {
    try {
      handle = (await resolveAgentConfig(configPath)).handle;
    } catch {
      handle = undefined;
    }
  }
  const listRes = await api(creds, "/agents");
  if (!listRes.ok) fail(await apiError(listRes, "could not list agents"));
  const { agents } = await listRes.json() as { agents: PlatformAgent[] };
  const { agent, reason } = matchAgent(agents, await repoState(), handle);
  if (!agent) fail(reason ?? "no matching hosted agent");
  const res = await api(creds, `/agents/${agent.id}/status`);
  if (!res.ok) fail(await apiError(res, "could not fetch status"));
  const status = await res.json() as Record<string, unknown>;
  console.log(`${accent(agent.handle)} ${dim(`${DASHBOARD_URL}/agents/${agent.id}`)}`);
  for (const [key, value] of Object.entries(status)) {
    if (value !== null && typeof value !== "object") {
      console.log(`  ${key}: ${value}`);
    }
  }
  if (Object.keys(status).length === 0) console.log(err("  no status returned"));
}
