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
import { createMemoryTools, type MemoryEvent, memoryPromptSection } from "../tools/memory.ts";
import {
  connectMcpServers,
  type McpCallRecord,
  type McpConnections,
  withMcpAudit,
} from "../tools/mcp.ts";
import { SEARCH_AUTO_THRESHOLD, ToolRegistry } from "../tools/registry.ts";

/** An event from the outside world, normalized by a trigger. */
export interface AgentEvent {
  /** Unique event id, for logs and correlation. */
  id: string;
  /** Which trigger produced it: "webhook", "cron", "cli", "discord", ... */
  trigger: string;
  /** The text the agent is asked to act on. */
  input: string;
  /** Session identity (e.g. a thread id). Absent → the run has no history. */
  conversationKey?: string;
}

/** A trigger connects outward, emits events, and carries replies back. */
export interface Trigger {
  /** Trigger name, e.g. "discord" or "cron". */
  readonly name: string;
  /** Connect and begin emitting events; `emit` runs the agent and resolves with the result. */
  start(emit: (event: AgentEvent) => Promise<RunResult>): Promise<void>;
  /** Disconnect and stop emitting. */
  stop(): Promise<void>;
}

/** Options for constructing an {@linkcode AgentService}. */
export interface AgentServiceOptions {
  /** The agent's parsed config. */
  config: AgentConfig;
  /** Defaults to createProvider(config.model); injectable for tests. */
  provider?: Provider;
  /** Where the SQLite file lives. Defaults to ./.looped */
  dataDir?: string;
  /** Base for resolving relative paths in the config (skills). Defaults to cwd. */
  baseDir?: string;
  /** Extra tools beyond the natives. */
  extraTools?: NativeTool[];
  /** Injectable store; `af test` passes an in-memory one so /data stays untouched. */
  store?: Store;
  /** Skip the naming ritual with a fixed identity (eval runs shouldn't spend a call on it). */
  identity?: AgentIdentity;
  /** Applied to every tool before the run sees it; `af test` swaps execute for mocks. */
  wrapTool?: (tool: NativeTool) => NativeTool;
}

/**
 * The outer loop: waits for trigger events, assembles context, runs the
 * inner loop, delivers the result, records everything. One instance per
 * agent — one agent per container.
 */
export class AgentService {
  /** The agent's config, as passed in. */
  readonly config: AgentConfig;
  /** The agent's SQLite store: sessions, runs, audit, identity. */
  readonly store: Store;
  #provider: Provider;
  #env: Record<string, string>;
  #extraTools: NativeTool[];
  #triggers: Trigger[] = [];
  #identity?: AgentIdentity;
  #baseDir: string;
  #skills?: Skill[];
  #mcp?: McpConnections;
  #wrapTool: (tool: NativeTool) => NativeTool;

  /** Resolves env references, opens the store, and builds the provider. */
  constructor(opts: AgentServiceOptions) {
    this.config = opts.config;
    this.#provider = opts.provider ?? createProvider(opts.config.model);
    // Resolve env references at startup — a missing secret fails here,
    // not mid-run in front of the model.
    this.#env = resolveEnv(opts.config.env);
    this.#extraTools = opts.extraTools ?? [];
    this.#baseDir = opts.baseDir ?? Deno.cwd();
    this.#identity = opts.identity;
    this.#wrapTool = opts.wrapTool ?? ((tool) => tool);
    if (opts.store) {
      this.store = opts.store;
    } else {
      const dataDir = opts.dataDir ?? Deno.env.get("AF_DATA_DIR") ?? ".looped";
      Deno.mkdirSync(dataDir, { recursive: true });
      this.store = new Store(`${dataDir}/${opts.config.handle}.db`);
    }
  }

  /**
   * Tools follow the permissions (minimalism: a tool the agent can't use
   * doesn't exist for it — no dead schemas burning a small model's context).
   */
  #buildTools(
    engine: PermissionEngine,
    onMemoryEvent: (event: MemoryEvent) => void,
    onMcpCall: (call: McpCallRecord) => void,
  ): () => NativeTool[] {
    const always: NativeTool[] = [currentTimeTool, ...this.#extraTools];
    if (this.#skills?.length) always.push(createSkillTool(this.#skills));
    if (this.config.memory?.persistent) {
      always.push(...createMemoryTools(this.store, onMemoryEvent));
    }
    if (this.config.permissions?.run?.length) {
      always.push(createRunBashTool({ permissions: engine, env: this.#env }));
    }
    if (this.config.permissions?.net?.length) {
      always.push(createHttpRequestTool({ permissions: engine }));
    }
    if (this.config.permissions?.read?.length) always.push(createReadFileTool(engine));
    if (this.config.permissions?.write?.length) always.push(createWriteFileTool(engine));

    // Natives and skills stay in context (small, framework-owned); MCP tools
    // defer behind search_tools when the toolset gets big (tools.search).
    // Every MCP call is reported for the run's audit trail.
    const wrapped = always.map(this.#wrapTool);
    const mcp = withMcpAudit(this.#mcp?.tools ?? [], onMcpCall).map(this.#wrapTool);
    const mode = this.config.tools?.search ?? "auto";
    const defer = mcp.length > 0 && (
      mode === "on" ||
      (mode === "auto" && always.length + mcp.length > SEARCH_AUTO_THRESHOLD)
    );
    if (!defer) {
      const all = [...wrapped, ...mcp];
      return () => all;
    }
    const registry = new ToolRegistry(wrapped, mcp);
    return () => registry.active();
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
    const mcpCalls: McpCallRecord[] = [];
    const engine = new PermissionEngine(this.config.permissions, (e) => {
      decisions.push(e.decision);
    });
    const memoryEvents: MemoryEvent[] = [];

    const useSessions = this.config.memory?.scope === "thread" && event.conversationKey;
    const sessionId = useSessions ? this.store.sessionFor(event.conversationKey!) : undefined;
    const history = sessionId !== undefined ? this.store.loadMessages(sessionId) : [];
    const memories = this.config.memory?.persistent ? this.store.listMemories() : [];

    const result = await runAgent({
      config: {
        ...this.config,
        purpose: this.config.purpose +
          skillsPromptSection(this.#skills ?? []) +
          memoryPromptSection(memories) +
          identityNote(this.config, identity.name),
      },
      provider: this.#provider,
      tools: this.#buildTools(engine, (e) => memoryEvents.push(e), (call) => mcpCalls.push(call)),
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
      startedAt,
    });
    for (const decision of decisions) {
      this.store.recordAudit({ runId, kind: "permission", detail: decision });
    }
    for (const memoryEvent of memoryEvents) {
      this.store.recordAudit({ runId, kind: "memory", detail: memoryEvent });
    }
    for (const call of mcpCalls) {
      this.store.recordAudit({ runId, kind: "mcp", detail: call });
    }
    return result;
  }

  /** Start every trigger, routing its events through {@linkcode AgentService.handle}. */
  async start(triggers: Trigger[]) {
    this.#triggers = triggers;
    for (const trigger of triggers) {
      await trigger.start((event) => this.handle(event));
    }
  }

  /** Stop triggers, close MCP connections, and close the store. */
  async stop() {
    for (const trigger of this.#triggers) await trigger.stop();
    await this.#mcp?.close();
    this.store.close();
  }
}
