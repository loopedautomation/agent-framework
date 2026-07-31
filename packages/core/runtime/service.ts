import type { AgentConfig } from "../config/schema.ts";
import type { ImageContent } from "../providers/types.ts";
import { expandEnvRefs, resolveEnv } from "../config/env.ts";
import { type Redactor, redactorForConfig, setDefaultRedactor } from "../redact/redact.ts";
import { logError, logInfo } from "./log.ts";
import type { Provider } from "../providers/types.ts";
import { createProvider } from "../providers/mod.ts";
import { PermissionEngine } from "../permissions/engine.ts";
import type { NativeTool } from "../tools/types.ts";
import { currentTimeTool } from "../tools/time.ts";
import { createRunBashTool } from "../tools/bash.ts";
import { createHttpRequestTool, type HttpCredential } from "../tools/http.ts";
import { createReadFileTool, createWriteFileTool } from "../tools/files.ts";
import { runAgent, type RunEvent, type RunResult } from "../loop/loop.ts";
import { formatCost, priceFor } from "../providers/pricing.ts";
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
import {
  createScheduleTools,
  type ScheduleEvent,
  schedulesPromptSection,
} from "../tools/schedule.ts";
import { ScheduleRunner } from "./schedules.ts";
import type { ScheduleRecord } from "../store/store.ts";
import { compactTranscript, isNothingToCompact } from "../loop/compact.ts";
import { ProviderError } from "../providers/types.ts";
import {
  BUILTIN_COMMANDS,
  commandSpecs,
  helpText,
  parseCommand,
  type ParsedCommand,
  substituteArgs,
} from "./commands.ts";
import { QueueFullError, RunScheduler } from "./scheduler.ts";

/** An event from the outside world, normalized by a trigger. */
export interface AgentEvent {
  /** Unique event id, for logs and correlation. */
  id: string;
  /** Which trigger produced it: "webhook", "cron", "cli", "discord", ... */
  trigger: string;
  /** The text the agent is asked to act on. */
  input: string;
  /**
   * Images that arrived with the event, already resolved to bytes by the
   * trigger. Anything the agent cannot look at — a PDF, an oversized image —
   * is named in `input` instead, so a run never silently sees less than what
   * the user sent (Plan 14).
   */
  images?: ImageContent[];
  /** Session identity (e.g. a thread id). Absent → the run has no history. */
  conversationKey?: string;
  /**
   * Serialization lane for events with no conversation: events sharing a
   * serialKey run one at a time in arrival order, with at most one waiting —
   * further events are refused while both slots are full. Cron uses this so
   * a schedule never overlaps itself. Ignored when conversationKey is set.
   */
  serialKey?: string;
}

/** Per-call options for {@linkcode AgentService.handle}. */
export interface HandleOptions {
  /** Observes inner-loop progress live — for interactive surfaces like the REPL. */
  onEvent?: (event: RunEvent) => void;
}

/** Render seconds as "2d 3h 4m 5s", dropping leading zero units. */
function formatUptime(totalSeconds: number): string {
  const d = Math.floor(totalSeconds / 86_400);
  const h = Math.floor((totalSeconds % 86_400) / 3_600);
  const m = Math.floor((totalSeconds % 3_600) / 60);
  const s = totalSeconds % 60;
  const parts = [[d, "d"], [h, "h"], [m, "m"], [s, "s"]] as const;
  const first = parts.findIndex(([n]) => n > 0);
  if (first === -1) return "0s";
  return parts.slice(first).map(([n, unit]) => `${n}${unit}`).join(" ");
}

/** A trigger connects outward, emits events, and carries replies back. */
export interface Trigger {
  /** Trigger name, e.g. "discord" or "cron". */
  readonly name: string;
  /**
   * Connect and begin emitting events; `emit` runs the agent and resolves
   * with the result. Interactive triggers pass `opts.onEvent` to stream the
   * run's inner-loop progress to their surface. `stop(conversationKey)` aborts
   * the in-flight run on that lane — the same signal /stop fires — for triggers
   * that expose an out-of-band cancel while a run holds the connection.
   */
  start(
    emit: (event: AgentEvent, opts?: HandleOptions) => Promise<RunResult>,
    stop: (conversationKey: string) => boolean,
  ): Promise<void>;
  /** Disconnect and stop emitting. */
  stop(): Promise<void>;
  /**
   * Proactively send a message to a conversation this trigger owns — the
   * delivery path for agent-created schedules. Resolves true when the key
   * is this trigger's and the send happened; false hands the key to the
   * next trigger. Optional: triggers without an outbound surface (webhook)
   * simply don't implement it.
   */
  deliver?(conversationKey: string, text: string): Promise<boolean>;
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
  /** Injectable redactor; defaults to one built from the config's secrets. */
  redactor?: Redactor;
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
  /** Scrubs the agent's secrets from every surface they could reach. */
  readonly redactor: Redactor;
  #provider: Provider;
  #env: Record<string, string>;
  #credentials: HttpCredential[];
  #extraTools: NativeTool[];
  #triggers: Trigger[] = [];
  #identity?: AgentIdentity;
  #baseDir: string;
  #skills?: Skill[];
  #mcp?: McpConnections;
  #wrapTool: (tool: NativeTool) => NativeTool;
  #startedAtMs = Date.now();
  #scheduler: RunScheduler;
  #scheduleRunner?: ScheduleRunner;
  /** The in-flight run's abort controller, per scheduler lane — what /stop fires. */
  #aborts = new Map<string, AbortController>();

  /** Resolves env references, opens the store, and builds the provider. */
  constructor(opts: AgentServiceOptions) {
    // Purpose may carry ${VAR} references for non-secret configuration — a
    // project id, a hostname — resolved at startup like an env block's. The
    // expanded text becomes the system prompt, so it is model-visible and
    // never redacted: don't put credentials here.
    this.config = /\$\{[A-Za-z_][A-Za-z0-9_]*\}/.test(opts.config.purpose)
      ? { ...opts.config, purpose: expandEnvRefs(opts.config.purpose, "purpose") }
      : opts.config;
    this.#provider = opts.provider ?? createProvider(opts.config.model);
    // Resolve env references at startup — a missing secret fails here,
    // not mid-run in front of the model.
    // Both blocks scope into subprocesses identically; the only difference is
    // that `public` never reaches the redactor. `env` wins a collision, so a
    // name that is a secret anywhere stays a secret.
    this.#env = { ...resolveEnv(opts.config.public), ...resolveEnv(opts.config.env) };
    // Credentials the runtime attaches to outbound requests itself, so an
    // authenticated API needs no secret in a model-visible header.
    this.#credentials = (opts.config.http?.auth ?? []).map((auth) => ({
      url: auth.url,
      header: auth.header,
      value: expandEnvRefs(auth.value, `http.auth ${auth.url}`),
    }));
    // Every secret the config references, resolved. Scoped env keeps these out
    // of the model's initial context; the redactor keeps them out of the tool
    // results, transcripts, records, logs and traces that come back.
    this.redactor = opts.redactor ?? redactorForConfig(opts.config);
    // The process is one agent, so surfaces with no seam of their own —
    // provider error bodies, the log path — can reach it here.
    setDefaultRedactor(this.redactor);
    this.#extraTools = opts.extraTools ?? [];
    this.#baseDir = opts.baseDir ?? Deno.cwd();
    this.#identity = opts.identity;
    // Redaction wraps outermost: whatever a tool (or a test's mock of one)
    // returns is scrubbed before the loop, the model, or the store see it.
    const wrap = opts.wrapTool ?? ((tool: NativeTool) => tool);
    this.#wrapTool = (tool) => this.#redactTool(wrap(tool));
    if (opts.store) {
      this.store = opts.store;
    } else {
      const dataDir = opts.dataDir ?? Deno.env.get("AF_DATA_DIR") ?? ".looped";
      Deno.mkdirSync(dataDir, { recursive: true });
      this.store = new Store(`${dataDir}/${opts.config.handle}.db`, { redactor: this.redactor });
    }
    this.#scheduler = new RunScheduler({
      concurrentRuns: opts.config.limits.concurrent_runs,
      queueDepth: opts.config.limits.queue_depth,
    });
  }

  /**
   * Scrub a tool's result before anything downstream sees it. A permitted CLI
   * or MCP server can echo a credential — `env | grep`, an error quoting the
   * key it just used — and the result is the model's next message.
   */
  #redactTool(tool: NativeTool): NativeTool {
    return {
      def: tool.def,
      execute: async (rawArgs: string) => this.redactor.jsonText(await tool.execute(rawArgs)),
    };
  }

  /**
   * Tools follow the permissions (minimalism: a tool the agent can't use
   * doesn't exist for it — no dead schemas burning a small model's context).
   */
  #buildTools(
    engine: PermissionEngine,
    onMemoryEvent: (event: MemoryEvent) => void,
    onMcpCall: (call: McpCallRecord) => void,
    conversationKey?: string,
    onScheduleEvent?: (event: ScheduleEvent) => void,
  ): () => NativeTool[] {
    const always: NativeTool[] = [currentTimeTool, ...this.#extraTools];
    if (this.#skills?.length) always.push(createSkillTool(this.#skills));
    if (this.config.memory?.persistent) {
      always.push(...createMemoryTools(this.store, onMemoryEvent));
    }
    if (this.config.schedules) {
      always.push(...createScheduleTools({
        store: this.store,
        max: this.config.schedules.max,
        conversationKey,
        onEvent: onScheduleEvent,
      }));
    }
    if (this.config.permissions?.run?.length) {
      always.push(createRunBashTool({ permissions: engine, env: this.#env }));
    }
    if (this.config.permissions?.net?.length) {
      always.push(createHttpRequestTool({ permissions: engine, credentials: this.#credentials }));
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
    this.#startSchedules();
    return this.#identity;
  }

  /**
   * Arm every persisted schedule (idempotent; init runs before every event).
   * Lives in init rather than start so trigger-less surfaces like the REPL
   * run schedules too. A one-shot that came due while the agent was down
   * fires immediately: for a reminder, late beats never.
   */
  #startSchedules() {
    if (!this.config.schedules || this.#scheduleRunner) return;
    this.#scheduleRunner = new ScheduleRunner((s) => void this.#fireSchedule(s));
    for (const schedule of this.store.listSchedules()) {
      if (schedule.at !== undefined && new Date(schedule.at).getTime() <= Date.now()) {
        void this.#fireSchedule(schedule);
      } else {
        this.#scheduleRunner.add(schedule);
      }
    }
  }

  /**
   * One schedule firing: run the prompt through the normal event path, then
   * deliver the reply to the conversation that created the schedule. A
   * keyed firing joins its conversation's lane (ordered with the chat); a
   * keyless one gets a per-schedule serial lane so it never overlaps itself.
   * One-shots retire after the run completes, so a crash mid-run replays
   * the reminder on restart instead of losing it.
   */
  async #fireSchedule(schedule: ScheduleRecord): Promise<void> {
    try {
      const result = await this.handle({
        id: crypto.randomUUID(),
        trigger: "schedule",
        input: schedule.prompt,
        conversationKey: schedule.conversationKey,
        serialKey: schedule.conversationKey === undefined ? `schedule:${schedule.id}` : undefined,
      });
      if (schedule.at !== undefined) {
        this.store.deleteSchedule(schedule.id);
        this.#scheduleRunner?.remove(schedule.id);
      }
      await this.#deliver(schedule, result);
    } catch (err) {
      logError(`schedule #${schedule.id}: run failed: ${(err as Error).message}`);
    }
  }

  /** Route a schedule's reply to its conversation; the log is the fallback. */
  async #deliver(schedule: ScheduleRecord, result: RunResult): Promise<void> {
    const text = (result.reply ?? "").trim();
    if (schedule.conversationKey !== undefined && result.status === "ok" && text) {
      for (const trigger of this.#triggers) {
        try {
          if (await trigger.deliver?.(schedule.conversationKey, text)) return;
        } catch (err) {
          logError(
            `schedule #${schedule.id}: delivery via ${trigger.name} failed: ` +
              `${(err as Error).message}`,
          );
        }
      }
    }
    logInfo(`schedule #${schedule.id}: ${result.status} — ${text.slice(0, 200)}`);
  }

  /**
   * A built-in command's synthetic result rides the normal reply path.
   * help/status/reset/new answer deterministically with zero provider
   * calls; /compact is the one built-in that spends a model call.
   */
  async #runBuiltin(
    command: ParsedCommand,
    event: AgentEvent,
    identityName: string,
    onEvent?: (event: RunEvent) => void,
  ): Promise<RunResult> {
    let reply: string;
    switch (command.name) {
      case "help":
        reply = helpText(commandSpecs(this.config.commands));
        break;
      case "status": {
        const stats = this.store.runStats();
        const uptimeS = Math.floor((Date.now() - this.#startedAtMs) / 1000);
        reply = [
          `${identityName} (${this.config.handle})`,
          `model: ${this.config.model.provider}/${this.config.model.id}`,
          `uptime: ${formatUptime(uptimeS)}`,
          `runs: ${stats.runs} (${stats.inputTokens} in / ${stats.outputTokens} out tokens)`,
          // Only priced runs contribute, and saying how many keeps the number
          // honest when some runs ran on a model with no known price.
          stats.pricedRuns > 0
            ? `spend: ${formatCost(stats.cost)} over ${stats.pricedRuns} priced run` +
              `${stats.pricedRuns === 1 ? "" : "s"}`
            : "spend: not tracked (no price known for this model)",
        ].join("\n");
        break;
      }
      case "reset": {
        const canReset = this.config.memory?.scope === "thread" && event.conversationKey;
        if (!canReset) {
          reply = "Nothing to reset — this agent keeps no conversation history.";
        } else {
          const cleared = this.store.clearSession(event.conversationKey!);
          reply = cleared
            ? "Conversation history cleared. Persistent memories are untouched."
            : "This conversation had no history to clear.";
        }
        break;
      }
      case "new": {
        // Archive rather than delete: the old thread stays queryable under
        // its session id, and the caller's recordRun re-resolves the key
        // after this, so the command's row lands in the fresh session.
        const canNew = this.config.memory?.scope === "thread" && event.conversationKey;
        if (!canNew) {
          reply = "Nothing to start over — this agent keeps no conversation history.";
        } else {
          reply = this.store.archiveSession(event.conversationKey!)
            ? "Fresh conversation started. The old thread is archived; persistent memories are untouched."
            : "Already a fresh conversation — nothing to archive.";
        }
        break;
      }
      case "compact":
        return await this.#compactCommand(event, onEvent);
      default:
        // Unreachable: parseCommand only matches known names.
        reply = `Unknown command /${command.name}.`;
    }
    return {
      status: "ok",
      reply,
      steps: 0,
      usage: { inputTokens: 0, outputTokens: 0 },
      messages: [],
    };
  }

  /**
   * Handle one event: enqueue, then run end to end. Events sharing a
   * conversationKey (or serialKey) run serially in arrival order, so each
   * run sees what its predecessors persisted; across keys, runs are parallel
   * up to `limits.concurrent_runs`. An event past a full queue is refused
   * immediately — the trigger delivers the refusal through its normal reply
   * path, and the refusal lands in the audit trail.
   */
  async handle(event: AgentEvent, opts?: HandleOptions): Promise<RunResult> {
    const lane = event.conversationKey ?? event.serialKey;
    // /stop is the one command intercepted before the queue: submitted like
    // any other event it would wait behind the very run it is meant to stop.
    if (parseCommand(event.input, ["stop"])) return this.#stopCommand(event, lane);
    // Conversations queue up to limits.queue_depth events; serial lanes hold
    // at most one waiting event (cron's no-overlap promise).
    const queueDepth = event.conversationKey ? this.config.limits.queue_depth : 1;
    try {
      return await this.#scheduler.submit(lane, () => this.#run(event, opts), { queueDepth });
    } catch (err) {
      if (err instanceof QueueFullError) return this.#refuse(event, lane!, err);
      throw err;
    }
  }

  /**
   * The /compact command: one summarize call on model.small (its first
   * consumer), then the transcript is replaced by the marker + summary pair
   * plus the most recent turns. Guards reply without spending a call.
   */
  async #compactCommand(
    event: AgentEvent,
    onEvent?: (event: RunEvent) => void,
  ): Promise<RunResult> {
    const zero = { inputTokens: 0, outputTokens: 0 };
    const done = (reply: string, steps = 0, usage = zero): RunResult => ({
      status: "ok",
      reply,
      steps,
      usage,
      messages: [],
    });
    const key = this.config.memory?.scope === "thread" ? event.conversationKey : undefined;
    if (!key) return done("Nothing to compact — this agent keeps no conversation history.");
    const sessionId = this.store.sessionFor(key);
    const history = this.store.loadMessages(sessionId);
    if (history.length === 0) return done("This conversation has no history to compact.");
    if (isNothingToCompact(history)) {
      return done("Nothing new to compact — the recent history is already as small as it gets.");
    }
    try {
      const compacted = await compactTranscript({
        provider: this.#provider,
        model: this.config.model.small ?? this.config.model.id,
        system: this.config.purpose,
        history,
        onEvent,
      });
      if (!compacted) return done("Compaction produced no summary; history is unchanged.", 1);
      this.store.saveMessages(sessionId, compacted.messages);
      return done(
        `Compacted ${history.length} messages into a summary plus the last few turns. ` +
          "The conversation continues from there; persistent memories are untouched.",
        1,
        compacted.usage,
      );
    } catch (err) {
      if (err instanceof ProviderError) {
        return {
          status: "error_provider",
          reply: `Compaction failed (${err.kind}): ${err.message}. History is unchanged.`,
          steps: 1,
          usage: zero,
          messages: [],
        };
      }
      throw err;
    }
  }

  /**
   * Reactive auto-compaction: runs after a persisted run crossed
   * memory.compact_at_tokens, inside the same scheduler lane, so nothing
   * races the transcript. Records its own run row — the runs table is the
   * spend ledger and this call costs real tokens. A provider failure is
   * audited and swallowed; it must never disturb the conversation.
   */
  async #autoCompact(sessionId: number, onEvent?: (event: RunEvent) => void): Promise<void> {
    const startedAt = new Date().toISOString();
    const history = this.store.loadMessages(sessionId);
    if (isNothingToCompact(history)) return;
    try {
      const compacted = await compactTranscript({
        provider: this.#provider,
        model: this.config.model.small ?? this.config.model.id,
        system: this.config.purpose,
        history,
        onEvent,
      });
      if (!compacted) return;
      this.store.saveMessages(sessionId, compacted.messages);
      const runId = this.store.recordRun({
        sessionId,
        trigger: "compaction",
        input: "(auto-compaction)",
        status: "ok",
        reply: compacted.messages[1].content,
        steps: 1,
        usage: compacted.usage,
        startedAt,
      });
      this.store.recordAudit({
        runId,
        kind: "compaction",
        detail: { trigger: "auto", beforeMessages: history.length },
      });
    } catch (err) {
      if (!(err instanceof ProviderError)) throw err;
      this.store.recordAudit({
        kind: "compaction",
        detail: { trigger: "auto", error: `${err.kind}: ${err.message}` },
      });
    }
  }

  /** The queue-full refusal: an immediate reply plus an audit row, no run. */
  #refuse(event: AgentEvent, lane: string, err: QueueFullError): RunResult {
    this.store.recordAudit({
      kind: "queue",
      detail: { eventId: event.id, trigger: event.trigger, lane, held: err.held },
    });
    const reply = event.conversationKey
      ? "This conversation's queue is full — try again once the current work finishes."
      : "Skipped: an earlier firing is still running and one is already waiting.";
    return {
      status: "rejected",
      reply,
      steps: 0,
      usage: { inputTokens: 0, outputTokens: 0 },
      messages: [],
    };
  }

  /**
   * The /stop command: fire the lane's abort controller, if a run holds one.
   * The stopped run halts at its next step boundary and replies through its
   * own event, so /stop answers immediately with what it did. Queued events
   * are untouched — each one still runs when its turn comes.
   */
  #stopCommand(event: AgentEvent, lane: string | undefined): RunResult {
    const controller = lane ? this.#aborts.get(lane) : undefined;
    let reply: string;
    if (controller) {
      controller.abort();
      reply = "Stopping — the current run will halt at its next step.";
    } else {
      reply = "Nothing is running in this conversation.";
    }
    const useSession = this.config.memory?.scope === "thread" && event.conversationKey;
    const runId = this.store.recordRun({
      sessionId: useSession ? this.store.sessionFor(event.conversationKey!) : undefined,
      trigger: event.trigger,
      input: event.input,
      status: "ok",
      reply,
      steps: 0,
      usage: { inputTokens: 0, outputTokens: 0 },
      startedAt: new Date().toISOString(),
    });
    this.store.recordAudit({
      runId,
      kind: "command",
      detail: { name: "stop", args: "", builtin: true, stopped: controller !== undefined },
    });
    return {
      status: "ok",
      reply,
      steps: 0,
      usage: { inputTokens: 0, outputTokens: 0 },
      messages: [],
    };
  }

  /** Run one event end to end: context → inner loop → persist + audit. */
  async #run(event: AgentEvent, opts?: HandleOptions): Promise<RunResult> {
    const identity = await this.init();
    const startedAt = new Date().toISOString();

    // Slash commands are intercepted before the session loads and before any
    // provider call — a deterministic path that works identically on every
    // trigger (Plan 10). Unrecognized input falls through to the model.
    const command = parseCommand(
      event.input,
      commandSpecs(this.config.commands).map((c) => c.name),
    );
    if (command && BUILTIN_COMMANDS.some((c) => c.name === command.name)) {
      const result = await this.#runBuiltin(command, event, identity.name, opts?.onEvent);
      const useSession = this.config.memory?.scope === "thread" && event.conversationKey;
      const runId = this.store.recordRun({
        sessionId: useSession ? this.store.sessionFor(event.conversationKey!) : undefined,
        trigger: event.trigger,
        input: event.input,
        status: result.status,
        reply: result.reply,
        steps: result.steps,
        usage: result.usage,
        startedAt,
      });
      this.store.recordAudit({
        runId,
        kind: "command",
        detail: { name: command.name, args: command.args, builtin: true },
      });
      return result;
    }
    if (command) {
      // A config-defined command is a named, repeatable prompt: substitute
      // the arguments and run the normal loop with it as the input.
      const config = this.config.commands!.find((c) => c.name === command.name)!;
      event = { ...event, input: substituteArgs(config.prompt, command.args) };
    }
    const useSessions = this.config.memory?.scope === "thread" && event.conversationKey;
    const sessionId = useSessions ? this.store.sessionFor(event.conversationKey!) : undefined;
    const history = sessionId !== undefined ? this.store.loadMessages(sessionId) : [];
    const memories = this.config.memory?.persistent ? this.store.listMemories() : [];

    // The run row opens before any work happens, so audit events have an id to
    // hang from as they occur and a run the container dies inside still leaves
    // a trace. Every exit path below closes it, including the throwing one.
    const runId = this.store.openRun({
      sessionId,
      trigger: event.trigger,
      input: event.input,
      startedAt,
    });
    const engine = new PermissionEngine(this.config.permissions, (e) => {
      this.store.recordAudit({ runId, kind: "permission", detail: e.decision });
    });
    const onScheduleEvent = (e: ScheduleEvent) => {
      this.store.recordAudit({
        runId,
        kind: "schedule",
        detail: {
          action: e.action,
          id: e.schedule.id,
          when: e.schedule.cron ?? e.schedule.at,
          prompt: e.schedule.prompt,
        },
      });
      // Arm or disarm the live job now — the row is already persisted.
      if (e.action === "create") this.#scheduleRunner?.add(e.schedule);
      else this.#scheduleRunner?.remove(e.schedule.id);
    };
    if (command) {
      this.store.recordAudit({
        runId,
        kind: "command",
        detail: { name: command.name, args: command.args, builtin: false },
      });
    }

    // Register the abort controller under this event's lane so a /stop
    // arriving mid-run (it skips the queue) can reach into this one.
    const lane = event.conversationKey ?? event.serialKey;
    const controller = new AbortController();
    if (lane) this.#aborts.set(lane, controller);

    let result: RunResult;
    try {
      result = await runAgent({
        signal: controller.signal,
        config: {
          ...this.config,
          purpose: this.config.purpose +
            skillsPromptSection(this.#skills ?? []) +
            memoryPromptSection(memories) +
            (this.config.schedules
              ? schedulesPromptSection(this.store.countSchedules(), this.config.schedules.max)
              : "") +
            identityNote(this.config, identity),
        },
        provider: this.#provider,
        tools: this.#buildTools(
          engine,
          (e) => this.store.recordAudit({ runId, kind: "memory", detail: e }),
          (call) => this.store.recordAudit({ runId, kind: "mcp", detail: call }),
          event.conversationKey,
          onScheduleEvent,
        ),
        input: event.input,
        images: event.images,
        history,
        onEvent: opts?.onEvent,
        onPersist: sessionId !== undefined
          ? (appended) => this.store.appendMessages(sessionId, appended)
          : undefined,
        redact: (text) => this.redactor.text(text),
      });
    } catch (err) {
      // The loop threw rather than returning a typed failure, so nothing
      // downstream will close the row. Do it here instead of leaving a run
      // that looks in-flight until the next restart sweeps it.
      this.store.closeRun(runId, {
        status: "error_provider",
        reply: `run failed: ${err instanceof Error ? err.message : String(err)}`,
        steps: 0,
        usage: { inputTokens: 0, outputTokens: 0 },
      });
      throw err;
    } finally {
      if (lane && this.#aborts.get(lane) === controller) this.#aborts.delete(lane);
    }

    // The incremental appends above already put this run's messages on disk;
    // this rewrite is the authority on the final shape (the loop may have
    // dropped the wrap-up prompt, and compaction rewrites wholesale).
    if (sessionId !== undefined) this.store.saveMessages(sessionId, result.messages);
    this.store.closeRun(runId, {
      status: result.status,
      reply: result.reply,
      steps: result.steps,
      usage: result.usage,
      cost: result.cost,
    });

    // Reactive auto-compaction: the context size the provider just reported
    // decides, so the check costs nothing until the threshold is crossed.
    const threshold = this.config.memory?.compact_at_tokens;
    if (
      sessionId !== undefined && threshold !== undefined && threshold !== false &&
      result.contextTokens !== undefined && result.contextTokens >= threshold
    ) {
      await this.#autoCompact(sessionId, opts?.onEvent);
    }
    return result;
  }

  /** Start every trigger, routing its events through {@linkcode AgentService.handle}. */
  async start(triggers: Trigger[]) {
    // A budget that cannot be computed is a budget that silently does nothing,
    // so say it at startup rather than letting the agent file imply a ceiling
    // the runtime will never apply.
    if (this.config.limits.max_cost > 0 && !this.config.model.pricing) {
      if (!priceFor(this.config.model.id)) {
        logInfo(
          `limits.max_cost is set to ${formatCost(this.config.limits.max_cost)} but no price is ` +
            `known for model "${this.config.model.id}", so the cap cannot be enforced and run ` +
            `costs will not be recorded. Set model.pricing to fix this.`,
        );
      }
    }

    // Any run still open belongs to a previous process that died holding it.
    // Reconcile before accepting new work, so `af runs` distinguishes a run
    // that crashed from one that is happening now.
    const crashed = this.store.recoverOpenRuns();
    if (crashed > 0) {
      logInfo(
        `recovered ${crashed} run${crashed === 1 ? "" : "s"} left open by a previous start`,
      );
    }
    this.#triggers = triggers;
    for (const trigger of triggers) {
      await trigger.start(
        (event, opts) => this.handle(event, opts),
        (conversationKey) => this.stopRun(conversationKey),
      );
    }
  }

  /**
   * Abort the in-flight run on a conversation's lane — the same signal the
   * /stop command fires. Returns whether a run was actually aborted (false
   * when the lane holds nothing). The run halts at its next step boundary and
   * resolves with status "aborted" through its own event; queued events are
   * left alone.
   *
   * Unlike /stop this records nothing of its own: the aborted run is what shows
   * up in the history. It's the seam an interactive trigger uses to expose a
   * cancel while a run holds the connection (the tty cancel frame), without
   * routing a synthetic command through the queue.
   */
  stopRun(conversationKey: string): boolean {
    const controller = this.#aborts.get(conversationKey);
    if (!controller) return false;
    controller.abort();
    return true;
  }

  /** Stop triggers and schedules, close MCP connections, and close the store. */
  async stop() {
    this.#scheduleRunner?.stop();
    for (const trigger of this.#triggers) await trigger.stop();
    await this.#mcp?.close();
    this.store.close();
  }
}
