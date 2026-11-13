/**
 * Planner approval tool — a minimal MCP server (stdio, JSON-RPC 2.0, one
 * message per line) that the bridge hands to each headless run:
 *
 *   claude -p … --mcp-config '{"mcpServers":{"planner":…}}' \
 *              --permission-prompt-tool mcp__planner__approve
 *
 * When a tool call needs permission, Claude Code calls `approve` with
 * `{ tool_name, input }` instead of failing. This forwards the request to the
 * bridge (`POST /internal/permission`), which asks the user in Planner and
 * holds the request until they answer Allow or Deny there. The answer goes
 * back to Claude Code as the text `{"behavior":"allow","updatedInput":…}` or
 * `{"behavior":"deny","message":…}`.
 *
 * Anything that goes wrong — bridge down, bad answer, timeout — is a deny.
 *
 * Env (set by the bridge): PLANNER_BRIDGE_URL, PLANNER_RUN_ID,
 * PLANNER_RUN_TOKEN (this run's token: it can ask, never answer),
 * PLANNER_APPROVAL_TIMEOUT_MS.
 */

type Id = number | string | null;
type Message = { jsonrpc: "2.0"; id?: Id; method?: string; params?: unknown };

const BRIDGE = process.env.PLANNER_BRIDGE_URL ?? "";
const TOKEN = process.env.PLANNER_RUN_TOKEN ?? "";
const RUN_ID = process.env.PLANNER_RUN_ID ?? "";
/** The bridge answers by its own timeout; this only guards against a hung socket. */
const FETCH_TIMEOUT_MS = (Number(process.env.PLANNER_APPROVAL_TIMEOUT_MS) || 600_000) + 60_000;

if (!BRIDGE || !TOKEN || !RUN_ID) {
  console.error(
    "permission-mcp: PLANNER_BRIDGE_URL, PLANNER_RUN_ID and PLANNER_RUN_TOKEN are required.",
  );
  process.exit(1);
}

const TOOL = {
  name: "approve",
  description:
    "Asks the user in Planner to allow or deny a tool call that needs permission, and waits for the answer.",
  inputSchema: {
    type: "object",
    properties: {
      tool_name: { type: "string", description: "The tool that wants to run." },
      input: { type: "object", description: "The tool call's input." },
      tool_use_id: { type: "string" },
    },
    required: ["tool_name", "input"],
  },
};

function write(message: object) {
  process.stdout.write(`${JSON.stringify(message)}\n`);
}

type Decision =
  | { behavior: "allow"; updatedInput: Record<string, unknown> }
  | { behavior: "deny"; message: string };

const deny = (message: string): Decision => ({ behavior: "deny", message });

async function ask(params: { tool_name?: unknown; input?: unknown }): Promise<Decision> {
  const { input, tool_name } = params;
  if (!input || typeof input !== "object" || Array.isArray(input)) {
    return deny("Malformed approval request (input must be an object).");
  }
  try {
    const res = await fetch(`${BRIDGE}/internal/permission`, {
      method: "POST",
      headers: { "Content-Type": "application/json", Authorization: `Bearer ${TOKEN}` },
      body: JSON.stringify({ runId: RUN_ID, tool: String(tool_name ?? "tool"), input }),
      signal: AbortSignal.timeout(FETCH_TIMEOUT_MS),
    });
    const body = (await res.json().catch(() => ({}))) as { allow?: unknown; message?: unknown };
    if (res.ok && body.allow === true) {
      return { behavior: "allow", updatedInput: input as Record<string, unknown> };
    }
    return deny(
      typeof body.message === "string" && body.message
        ? body.message
        : `The user denied this in Planner (HTTP ${res.status}).`,
    );
  } catch (e) {
    return deny(
      `Couldn't ask the user for approval (${e instanceof Error ? e.message : String(e)}).`,
    );
  }
}

async function handle(msg: Message) {
  const { id, method } = msg;
  const reply = (result: unknown) => id !== undefined && write({ jsonrpc: "2.0", id, result });
  const fail = (code: number, message: string) =>
    id !== undefined && write({ jsonrpc: "2.0", id, error: { code, message } });
  switch (method) {
    case "initialize": {
      const asked = (msg.params as { protocolVersion?: unknown } | undefined)?.protocolVersion;
      reply({
        protocolVersion: typeof asked === "string" ? asked : "2025-06-18",
        capabilities: { tools: {} },
        serverInfo: { name: "planner", version: "2.0.0" },
      });
      return;
    }
    case "ping":
      reply({});
      return;
    case "tools/list":
      reply({ tools: [TOOL] });
      return;
    case "tools/call": {
      const p = (msg.params ?? {}) as { name?: unknown; arguments?: unknown };
      if (p.name !== TOOL.name) {
        fail(-32602, `Unknown tool ${String(p.name)}`);
        return;
      }
      const args = p.arguments && typeof p.arguments === "object" ? p.arguments : {};
      const decision = await ask(args as { tool_name?: unknown; input?: unknown });
      reply({ content: [{ type: "text", text: JSON.stringify(decision) }] });
      return;
    }
    default:
      // Notifications (no id) need no answer.
      fail(-32601, `Unknown method ${String(method)}`);
  }
}

function onLine(line: string) {
  if (!line.trim()) {
    return;
  }
  let msg: Message;
  try {
    msg = JSON.parse(line) as Message;
  } catch {
    write({ jsonrpc: "2.0", id: null, error: { code: -32700, message: "Parse error" } });
    return;
  }
  // `handle` must never take the server down: one bad call is one error reply.
  handle(msg).catch((e: unknown) => {
    if (msg.id !== undefined) {
      write({
        jsonrpc: "2.0",
        id: msg.id,
        error: { code: -32603, message: e instanceof Error ? e.message : "Internal error" },
      });
    }
  });
}

let buffer = "";
const decoder = new TextDecoder();
for await (const chunk of Bun.stdin.stream()) {
  buffer += decoder.decode(chunk, { stream: true });
  const lines = buffer.split("\n");
  buffer = lines.pop() ?? "";
  for (const line of lines) {
    onLine(line);
  }
}
onLine(buffer + decoder.decode());

export {};
