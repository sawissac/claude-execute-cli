/**
 * One headless `claude -p` run per execute request, and the approvals it is
 * waiting on.
 *
 * Each run gets its own random `runToken`. The approval MCP server
 * (permission-mcp.ts) uses that token — never the master token — to reach
 * `/internal/permission`. The agent can see its MCP server's argv and env
 * (`ps`), so whatever is there must be harmless in its hands: the run token
 * can only *ask* the user, for that run; it cannot answer, start runs or
 * call any other route.
 */
import { randomBytes, randomUUID } from "node:crypto";
import { existsSync } from "node:fs";
import { join } from "node:path";
import { type Config, HERE } from "./config.ts";
import { secretEquals } from "./security.ts";

export type ExecutePayload = {
  projectPath: string;
  context: string;
  extraContext?: string;
  auto: boolean;
};

export type Decision = { allow: boolean; message?: string };

type Run = {
  id: string;
  token: string;
  send: (o: unknown) => void;
  pending: Map<string, (d: Decision) => void>;
  kill: (force?: boolean) => void;
};

export const MAX_PROMPT_CHARS = 200_000;
/** A run spamming approval requests can't pile up unbounded state. */
const MAX_PENDING_PER_RUN = 16;
/** SIGTERM first; SIGKILL if the CLI hasn't exited this long after. */
const KILL_GRACE_MS = 5_000;
/** Keep only the tail of stderr; a chatty CLI can't grow memory without bound. */
const STDERR_TAIL_BYTES = 16_384;
const APPROVE_TOOL = "mcp__planner__approve";
const PLANNER_SCRIPT = ".claude/skills/planner-for-claude-code/scripts/planner.sh";

const HOME = process.env.HOME ?? process.env.USERPROFILE ?? "";
/** The skill installed globally (`~/.claude/skills`), as Planner's README sets it up. */
const GLOBAL_SCRIPT = HOME ? join(HOME, PLANNER_SCRIPT) : "";

/**
 * Session markers a parent Claude Code sets in its terminal. Started from
 * one (e.g. VS Code's integrated terminal), the child `claude` would think it
 * is a nested session of that window; drop them so each run starts fresh.
 */
const PARENT_SESSION_ENV = [
  "CLAUDECODE",
  "CLAUDE_PID",
  "CLAUDE_AGENT_SDK_VERSION",
  "CLAUDE_CODE_ENTRYPOINT",
  "CLAUDE_CODE_EXECPATH",
  "CLAUDE_CODE_SESSION_ID",
  "CLAUDE_CODE_CHILD_SESSION",
  "CLAUDE_CODE_SESSION_ATTENDED",
  "CLAUDE_CODE_MESSAGING_SOCKET",
  "CLAUDE_CODE_MESSAGING_TOKEN",
];

/** Also never hand the bridge's own settings to the agent. */
const BRIDGE_ENV = ["PLANNER_CLAUDE_CONFIG"];

export function parsePayload(raw: unknown):
  | (Omit<ExecutePayload, "projectPath"> & {
      projectPath: unknown;
    })
  | string {
  if (!raw || typeof raw !== "object" || Array.isArray(raw)) {
    return "Body must be a JSON object.";
  }
  const { projectPath, context, extraContext, auto } = raw as Record<string, unknown>;
  if (typeof context !== "string" || !context.trim()) {
    return "context is required.";
  }
  if (extraContext !== undefined && typeof extraContext !== "string") {
    return "extraContext must be a string.";
  }
  if (auto !== undefined && typeof auto !== "boolean") {
    return "auto must be a boolean.";
  }
  if (context.length + (extraContext?.length ?? 0) > MAX_PROMPT_CHARS) {
    return "context is too long.";
  }
  return { projectPath, context, extraContext, auto: auto === true };
}

/** 1. Copy context text, 2. Extra context — the order the Run agent dialog shows. */
export function buildPrompt({
  context,
  extraContext,
}: Pick<ExecutePayload, "context" | "extraContext">) {
  const extra = extraContext?.trim();
  return extra ? `${context.trim()}\n\nExtra context:\n${extra}` : context.trim();
}

/**
 * `planner.sh` is how the skill reaches the task and reports progress, so it
 * runs without asking. Only the globally installed copy is trusted by
 * default: a project folder is whatever the user cloned, and auto-allowing a
 * script at a fixed path inside it would let a repo run code unasked.
 */
export function plannerRules(projectPath: string, trustProjectScript: boolean): string[] {
  const paths: string[] = [];
  if (GLOBAL_SCRIPT) {
    paths.push(GLOBAL_SCRIPT, `~/${PLANNER_SCRIPT}`, `$HOME/${PLANNER_SCRIPT}`);
  }
  if (trustProjectScript) {
    paths.push(PLANNER_SCRIPT, `./${PLANNER_SCRIPT}`, join(projectPath, PLANNER_SCRIPT));
  }
  return paths.map((p) => `Bash(${p}:*)`);
}

/** What a headless run must know that the skill alone doesn't say. */
function systemPrompt(projectPath: string, auto: boolean, trustProjectScript: boolean): string {
  const lines = [
    "This run was started from Planner's Run agent dialog, in the project folder the user picked:",
    `  ${projectPath}`,
    "Work in that folder. Use the planner-for-claude-code skill for the task link, and report live",
    "progress with its `event` command (start, a step per milestone, then done or fail): the user",
    "watches it in Planner.",
    auto
      ? "Auto mode is on: routine tool calls are approved for you, risky ones may be blocked, and " +
        "the rest are sent to the user in Planner to Allow or Deny. If a call is blocked, find a " +
        "safer way rather than retrying it."
      : "Tool calls that need permission are sent to the user in Planner to Allow or Deny; just " +
        "make the call and wait.",
    "Nobody can answer a free-form question: if you are blocked or denied, say what you need in",
    "the completion comment and report `fail`.",
    "Never curl or WebFetch the Plan API link yourself: the skill's script adds the key.",
    "Never call the local Planner bridge (127.0.0.1) or read its config: approvals come only from the user.",
  ];
  const projectScript = trustProjectScript && existsSync(join(projectPath, PLANNER_SCRIPT));
  if (!projectScript && GLOBAL_SCRIPT) {
    lines.push(`The skill's script: ${GLOBAL_SCRIPT} (call it by that absolute path).`);
  }
  return lines.join("\n");
}

/** The approval tool, as an MCP server Claude Code starts for this run only. */
function mcpConfig(run: Pick<Run, "id" | "token">, config: Config): string {
  return JSON.stringify({
    mcpServers: {
      planner: {
        type: "stdio",
        command: process.execPath,
        args: ["run", join(HERE, "permission-mcp.ts")],
        env: {
          PLANNER_BRIDGE_URL: `http://127.0.0.1:${config.port}`,
          PLANNER_RUN_ID: run.id,
          PLANNER_RUN_TOKEN: run.token,
          PLANNER_APPROVAL_TIMEOUT_MS: String(config.approvalTimeoutMinutes * 60_000),
        },
      },
    },
  });
}

/**
 * CLI flags. The prompt is *not* among them: it goes in on stdin, so text
 * from the request can never be parsed as a flag (a context of
 * `--dangerously-skip-permissions` would otherwise be one), doesn't show in
 * `ps`, and isn't capped by the OS command-line limit (32K chars on Windows).
 */
export function claudeArgs(
  payload: ExecutePayload,
  run: Pick<Run, "id" | "token">,
  config: Config,
): string[] {
  const c = config.claude;
  const { projectPath, auto } = payload;
  const args = ["-p", "--output-format", "stream-json", "--verbose"];
  const mode = auto ? "auto" : c.permissionMode;
  if (mode) {
    args.push("--permission-mode", mode);
  }
  if (c.model) {
    args.push("--model", c.model);
  }
  args.push(
    "--append-system-prompt",
    systemPrompt(projectPath, auto, config.trustProjectPlannerScript),
  );
  args.push("--mcp-config", mcpConfig(run, config), "--permission-prompt-tool", APPROVE_TOOL);
  const allowed = [
    ...plannerRules(projectPath, config.trustProjectPlannerScript),
    APPROVE_TOOL,
    ...c.allowedTools,
  ];
  args.push("--allowedTools", allowed.join(","));
  return [...args, ...c.extraArgs];
}

function childEnv(): Record<string, string | undefined> {
  const env = { ...process.env };
  for (const key of [...PARENT_SESSION_ENV, ...BRIDGE_ENV]) {
    delete env[key];
  }
  return env;
}

/** The most telling field of a tool call's input, for the approval prompt. */
export function toolDetail(input: Record<string, unknown>): string {
  const pick =
    input.command ??
    input.file_path ??
    input.notebook_path ??
    input.pattern ??
    input.path ??
    input.url;
  return typeof pick === "string" ? pick.slice(0, 2000) : JSON.stringify(input).slice(0, 500);
}

/** Collect a stream, keeping only its last `max` bytes. */
async function tail(stream: ReadableStream<Uint8Array>, max: number): Promise<string> {
  let kept = new Uint8Array(0);
  for await (const chunk of stream) {
    const merged = new Uint8Array(kept.length + chunk.length);
    merged.set(kept);
    merged.set(chunk, kept.length);
    kept = merged.length > max ? merged.slice(merged.length - max) : merged;
  }
  return new TextDecoder().decode(kept);
}

export class RunManager {
  readonly #runs = new Map<string, Run>();

  constructor(private readonly config: Config) {}

  get size(): number {
    return this.#runs.size;
  }

  /** Is `token` this run's own token? (Used by `/internal/permission`.) */
  runTokenOk(runId: string, token: string): boolean {
    const run = this.#runs.get(runId);
    return !!run && secretEquals(token, run.token);
  }

  /** Ask the user (through the run's stream) and wait for Allow / Deny. */
  requestPermission(
    runId: string,
    tool: string,
    input: Record<string, unknown>,
  ): Promise<Decision> {
    const run = this.#runs.get(runId);
    if (!run) {
      return Promise.resolve({ allow: false, message: "This run is no longer live." });
    }
    if (run.pending.size >= MAX_PENDING_PER_RUN) {
      return Promise.resolve({ allow: false, message: "Too many approvals already waiting." });
    }
    const requestId = randomUUID();
    const minutes = this.config.approvalTimeoutMinutes;
    return new Promise<Decision>((resolve) => {
      const timer = setTimeout(
        () => finish({ allow: false, message: `No answer in Planner within ${minutes} minutes.` }),
        minutes * 60_000,
      );
      function finish(d: Decision) {
        clearTimeout(timer);
        if (!run?.pending.delete(requestId)) {
          return;
        }
        run.send({ type: "planner", event: "permission_resolved", requestId, ...d });
        resolve(d);
      }
      run.pending.set(requestId, finish);
      run.send({
        type: "planner",
        event: "permission_request",
        requestId,
        tool,
        detail: toolDetail(input),
      });
      // Tool name only: commands and paths can hold secrets; keep them out of logs.
      console.log(`[planner-claude] run ${runId} asks to use ${tool}`);
    });
  }

  /** Answer a waiting approval. False when it is no longer waiting. */
  answer(runId: string, requestId: string, allow: boolean): boolean {
    const finish = this.#runs.get(runId)?.pending.get(requestId);
    if (!finish) {
      return false;
    }
    finish(allow ? { allow: true } : { allow: false, message: "The user denied this in Planner." });
    return true;
  }

  /** SIGTERM every run (SIGKILL with `force`). */
  killAll(force = false): void {
    for (const run of this.#runs.values()) {
      run.kill(force);
    }
  }

  /** Start `claude -p` and stream its events (framed by ours) as NDJSON. */
  execute(payload: ExecutePayload, signal: AbortSignal, headers: Record<string, string>): Response {
    const { config } = this;
    const id = randomUUID();
    const token = randomBytes(32).toString("base64url");
    const proc = Bun.spawn([config.claude.bin, ...claudeArgs(payload, { id, token }, config)], {
      cwd: payload.projectPath,
      env: childEnv(),
      stdin: new Blob([buildPrompt(payload)]),
      stdout: "pipe",
      stderr: "pipe",
    });

    let killTimer: ReturnType<typeof setTimeout> | undefined;
    const kill = (force = false) => {
      if (proc.exitCode !== null || proc.signalCode !== null) {
        return;
      }
      if (force) {
        proc.kill("SIGKILL");
        return;
      }
      if (killTimer) {
        return;
      }
      proc.kill("SIGTERM");
      killTimer = setTimeout(() => proc.kill("SIGKILL"), KILL_GRACE_MS);
    };
    const runTimer = setTimeout(() => kill(), config.timeoutMinutes * 60_000);
    signal.addEventListener("abort", () => kill(), { once: true });
    console.log(
      `[planner-claude] run ${id} pid ${proc.pid} in ${payload.projectPath}${payload.auto ? " (auto mode)" : ""}`,
    );

    const encoder = new TextEncoder();
    const line = (o: unknown) => encoder.encode(`${JSON.stringify(o)}\n`);
    const runs = this.#runs;

    const stream = new ReadableStream<Uint8Array>({
      async start(controller) {
        const send = (chunk: Uint8Array) => {
          try {
            controller.enqueue(chunk);
          } catch {
            // Client went away; the abort listener kills the process.
          }
        };
        const pending = new Map<string, (d: Decision) => void>();
        runs.set(id, { id, token, send: (o) => send(line(o)), pending, kill });
        send(
          line({
            type: "planner",
            event: "start",
            runId: id,
            pid: proc.pid,
            cwd: payload.projectPath,
            auto: payload.auto,
          }),
        );
        const stderr = tail(proc.stderr, STDERR_TAIL_BYTES);
        try {
          // Claude already writes one JSON object per line: pass it through.
          for await (const chunk of proc.stdout) {
            send(chunk);
          }
        } finally {
          const code = await proc.exited;
          clearTimeout(runTimer);
          clearTimeout(killTimer);
          for (const finish of [...pending.values()]) {
            finish({ allow: false, message: "The run ended." });
          }
          runs.delete(id);
          const err = (await stderr.catch(() => "")).trim();
          send(
            line({
              type: "planner",
              event: "exit",
              code,
              ...(err ? { stderr: err.slice(-4000) } : {}),
            }),
          );
          console.log(`[planner-claude] run ${id} exited ${code}`);
          try {
            controller.close();
          } catch {
            /* already closed */
          }
        }
      },
      cancel() {
        kill();
      },
    });

    return new Response(stream, {
      headers: { ...headers, "Content-Type": "application/x-ndjson", "Cache-Control": "no-store" },
    });
  }
}
