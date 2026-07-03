import type { AgentConfig } from "../config/schema.ts";
import { resolveEnv } from "../config/env.ts";
import type { Provider } from "../providers/types.ts";
import { createProvider } from "../providers/mod.ts";
import { type PermissionDecision, PermissionEngine } from "../permissions/engine.ts";
import type { NativeTool } from "../tools/types.ts";
import { currentTimeTool } from "../tools/time.ts";
import { createRunBashTool } from "../tools/bash.ts";
import { createHttpRequestTool } from "../tools/http.ts";
import { createReadFileTool, createWriteFileTool } from "../tools/files.ts";
import { runAgent, type RunResult } from "../loop/loop.ts";
import { Store } from "../store/store.ts";
import { type AgentIdentity, ensureIdentity, identityNote } from "./identity.ts";
import { createSkillTool, loadSkills, type Skill, skillsPromptSection } from "../skills/skills.ts";
import { connectMcpServers, type McpConnections } from "../tools/mcp.ts";

/** An event from the outside world, normalized by a trigger. */
export interface AgentEvent {
  id: string;
  /** Which trigger produced it: "webhook", "cron", "cli", "discord", ... */
  trigger: string;
  input: string;
  /** Session identity (e.g. a thread id). Absent → the run has no history. */
  conversationKey?: string;
}

/** A trigger connects outward, emits events, and carries replies back. */
export interface Trigger {
  readonly name: string;
  start(emit: (event: AgentEvent) => Promise<RunResult>): Promise<void>;
  stop(): Promise<void>;
}

export interface AgentServiceOptions {
  config: AgentConfig;
  /** Defaults to createProvider(config.model); injectable for tests. */
  provider?: Provider;
  /** Where the SQLite file lives. Defaults to ./.looped */
  dataDir?: string;
  /** Base for resolving relative paths in the config (skills). Defaults to cwd. */
  baseDir?: string;
  /** Extra tools beyond the natives. */
  extraTools?: NativeTool[];
}

/**
 * The outer loop: waits for trigger events, assembles context, runs the
 * inner loop, delivers the result, records everything. One instance per
 * agent — one agent per container.
 */
export class AgentService {
  readonly config: AgentConfig;
  readonly store: Store;
  #provider: Provider;
  #env: Record<string, string>;
  #extraTools: NativeTool[];
  #triggers: Trigger[] = [];
  #identity?: AgentIdentity;
  #baseDir: string;
  #skills?: Skill[];
  #mcp?: McpConnections;

  constructor(opts: AgentServiceOptions) {
    this.config = opts.config;
    this.#provider = opts.provider ?? createProvider(opts.config.model);
    // Resolve env references at startup — a missing secret fails here,
    // not mid-run in front of the model.
    this.#env = resolveEnv(opts.config.env);
    this.#extraTools = opts.extraTools ?? [];
    this.#baseDir = opts.baseDir ?? Deno.cwd();
    const dataDir = opts.dataDir ?? Deno.env.get("LOOPED_DATA_DIR") ?? ".looped";
    Deno.mkdirSync(dataDir, { recursive: true });
    this.store = new Store(`${dataDir}/${opts.config.nickname}.db`);
  }

  /**
   * Tools follow the permissions (minimalism: a tool the agent can't use
   * doesn't exist for it — no dead schemas burning a small model's context).
   */
  #buildTools(engine: PermissionEngine): NativeTool[] {
    const tools: NativeTool[] = [currentTimeTool, ...this.#extraTools, ...this.#mcp?.tools ?? []];
    if (this.#skills?.length) tools.push(createSkillTool(this.#skills));
    if (this.config.permissions?.run?.length) {
      tools.push(createRunBashTool({ permissions: engine, env: this.#env }));
    }
    if (this.config.permissions?.net?.length) {
      tools.push(createHttpRequestTool({ permissions: engine }));
    }
    if (this.config.permissions?.read?.length) tools.push(createReadFileTool(engine));
    if (this.config.permissions?.write?.length) tools.push(createWriteFileTool(engine));
    return tools;
  }

  /**
   * The naming ritual (idempotent): on first boot the agent chooses its own
   * name, persisted for life. Returns the identity; `isNew` marks the birth.
   */
  async init(): Promise<AgentIdentity> {
    this.#skills ??= this.config.skills?.length
      ? await loadSkills(this.config.skills, this.#baseDir)
      : [];
    this.#mcp ??= this.config.tools?.mcp?.length
      ? await connectMcpServers(this.config)
      : { tools: [], close: () => Promise.resolve() };
    this.#identity ??= await ensureIdentity(this.config, this.#provider, this.store);
    return this.#identity;
  }

  /** Handle one event end to end: context → inner loop → persist + audit. */
  async handle(event: AgentEvent): Promise<RunResult> {
    const identity = await this.init();
    const startedAt = new Date().toISOString();
    const decisions: PermissionDecision[] = [];
    const engine = new PermissionEngine(this.config.permissions, (e) => {
      decisions.push(e.decision);
    });

    const useSessions = this.config.memory?.scope === "thread" && event.conversationKey;
    const sessionId = useSessions ? this.store.sessionFor(event.conversationKey!) : undefined;
    const history = sessionId !== undefined ? this.store.loadMessages(sessionId) : [];

    const result = await runAgent({
      config: {
        ...this.config,
        purpose: this.config.purpose +
          skillsPromptSection(this.#skills ?? []) +
          identityNote(this.config, identity.name),
      },
      provider: this.#provider,
      tools: this.#buildTools(engine),
      input: event.input,
      history,
    });

    if (sessionId !== undefined) this.store.saveMessages(sessionId, result.messages);
    const runId = this.store.recordRun({
      sessionId,
      trigger: event.trigger,
      input: event.input,
      status: result.status,
      reply: result.reply,
      steps: result.steps,
      usage: result.usage,
      costUsd: result.costUsd,
      startedAt,
    });
    for (const decision of decisions) {
      this.store.recordAudit({ runId, kind: "permission", detail: decision });
    }
    return result;
  }

  async start(triggers: Trigger[]) {
    this.#triggers = triggers;
    for (const trigger of triggers) {
      await trigger.start((event) => this.handle(event));
    }
  }

  async stop() {
    for (const trigger of this.#triggers) await trigger.stop();
    await this.#mcp?.close();
    this.store.close();
  }
}
