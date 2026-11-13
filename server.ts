/**
 * Planner → Claude Code bridge.
 *
 *   bun run server.ts            # or: bun start
 *
 * A tiny local HTTP server that Planner's "Run agent → Claude Code" calls.
 * It runs the `claude` CLI headless (`claude -p`) inside the project folder
 * the user picked and streams Claude's `stream-json` events back as NDJSON,
 * one JSON object per line. The stream is the run's lifeline: closing it
 * stops the agent.
 *
 * Routes (master token = `token` in config.json):
 *   GET  /health                     → { ok, name, version, autoMode }   master token
 *   POST /api/claude-code/execute    → NDJSON stream                     master token
 *        body: { projectPath, context, extraContext?, auto? }
 *   POST /api/claude-code/permission → { ok }                            master token
 *        body: { runId, requestId, allow }
 *   POST /api/local/pick-folder      → { path | null }                   master token
 *   POST /api/local/open-folder      → 204                               master token
 *        body: { path }
 *   POST /internal/permission        → { allow, message? }               that run's token
 *        body: { runId, tool, input } — from permission-mcp.ts only
 *
 * Defence in depth, because it runs an agent that can edit files here:
 *   - binds to loopback only, and checks the Host header (DNS rebinding);
 *   - browser requests must come from `allowedOrigins` (CORS) and every POST
 *     must be `application/json` (forces a preflight; no form-post CSRF);
 *   - bearer token, compared in constant time; bodies capped at 1 MB;
 *   - the agent's approval tool gets a per-run token that can only ask,
 *     never answer — so a prompt-injected agent can't approve itself;
 *   - the prompt goes in on stdin, never argv (no flag injection);
 *   - optional `allowedProjectRoots`, `maxConcurrentRuns`, `allowAutoMode`.
 */
import { loadConfig } from "./config.ts";
import { isPicking, openFolder, pickFolder } from "./local.ts";
import { type ExecutePayload, parsePayload, RunManager } from "./run.ts";
import { bearer, checkFolder, corsHeaders, hostIsLoopback, secretEquals } from "./security.ts";

const VERSION = "2.0.0";
const MAX_BODY_BYTES = 1024 * 1024;

const config = loadConfig();
const runs = new RunManager(config);

const BASE_HEADERS = { "X-Content-Type-Options": "nosniff", "Cache-Control": "no-store" };

function json(body: unknown, status: number, cors: Record<string, string>): Response {
  return Response.json(body, { status, headers: { ...BASE_HEADERS, ...cors } });
}

/** Parse a JSON body; `undefined` when it isn't JSON (the caller answers 400/415). */
async function readJson(request: Request): Promise<unknown> {
  const type = request.headers.get("content-type") ?? "";
  if (!/^application\/json\b/i.test(type)) {
    return undefined;
  }
  return request.json().catch(() => undefined);
}

type Handler = (request: Request, cors: Record<string, string>) => Promise<Response> | Response;

const routes: Record<string, Handler> = {
  "GET /health": (_req, cors) =>
    json(
      { ok: true, name: "planner-claude-code", version: VERSION, autoMode: config.allowAutoMode },
      200,
      cors,
    ),

  "POST /api/claude-code/execute": async (request, cors) => {
    const parsed = parsePayload(await readJson(request));
    if (typeof parsed === "string") {
      return json({ error: parsed }, 400, cors);
    }
    if (parsed.auto && !config.allowAutoMode) {
      return json({ error: "Auto mode is turned off on this server (allowAutoMode)." }, 403, cors);
    }
    const folder = checkFolder(parsed.projectPath, config.allowedProjectRoots);
    if (!folder.ok) {
      return json({ error: folder.error }, folder.status === 404 ? 400 : folder.status, cors);
    }
    if (runs.size >= config.maxConcurrentRuns) {
      return json(
        { error: `Already running ${runs.size} agents (maxConcurrentRuns). Stop one first.` },
        429,
        cors,
      );
    }
    const payload: ExecutePayload = { ...parsed, projectPath: folder.path };
    return runs.execute(payload, request.signal, { ...BASE_HEADERS, ...cors });
  },

  "POST /api/claude-code/permission": async (request, cors) => {
    const body = (await readJson(request)) as
      { runId?: unknown; requestId?: unknown; allow?: unknown } | undefined;
    const answered =
      typeof body?.runId === "string" &&
      typeof body.requestId === "string" &&
      runs.answer(body.runId, body.requestId, body.allow === true);
    if (!answered) {
      return json(
        { error: "That request is no longer waiting (answered, timed out or the run ended)." },
        404,
        cors,
      );
    }
    return json({ ok: true }, 200, cors);
  },

  "POST /api/local/pick-folder": async (_req, cors) => {
    if (isPicking()) {
      return json({ error: "A folder picker is already open on this computer." }, 409, cors);
    }
    return json({ path: await pickFolder() }, 200, cors);
  },

  "POST /api/local/open-folder": async (request, cors) => {
    const body = (await readJson(request)) as { path?: unknown } | undefined;
    const folder = checkFolder(body?.path, []);
    if (!folder.ok) {
      return json({ error: folder.error }, folder.status, cors);
    }
    openFolder(folder.path);
    return new Response(null, { status: 204, headers: { ...BASE_HEADERS, ...cors } });
  },
};

/**
 * From permission-mcp.ts: held open until the user answers. Authenticated by
 * the run's own token, not the master token; never from a browser.
 */
async function internalPermission(request: Request): Promise<Response> {
  if (request.headers.get("origin")) {
    return json({ allow: false, message: "Not for browsers." }, 403, {});
  }
  const body = (await readJson(request)) as
    { runId?: unknown; tool?: unknown; input?: unknown } | undefined;
  if (typeof body?.runId !== "string" || !runs.runTokenOk(body.runId, bearer(request))) {
    return json({ allow: false, message: "Unknown run or wrong run token." }, 401, {});
  }
  const input =
    body.input && typeof body.input === "object" && !Array.isArray(body.input)
      ? (body.input as Record<string, unknown>)
      : {};
  const tool = typeof body.tool === "string" ? body.tool.slice(0, 200) : "tool";
  return json(await runs.requestPermission(body.runId, tool, input), 200, {});
}

const server = Bun.serve({
  hostname: config.host,
  port: config.port,
  // A run streams for minutes; don't drop quiet connections.
  idleTimeout: 0,
  maxRequestBodySize: MAX_BODY_BYTES,
  async fetch(request) {
    const url = new URL(request.url);
    const origin = request.headers.get("origin");
    const cors = corsHeaders(origin, config.allowedOrigins);

    if (!hostIsLoopback(request.headers.get("host"))) {
      return json({ error: "Bad host." }, 403, {});
    }
    if (origin && !cors["Access-Control-Allow-Origin"]) {
      return json({ error: `Origin ${origin} is not in allowedOrigins.` }, 403, {});
    }
    if (request.method === "OPTIONS") {
      return new Response(null, { status: 204, headers: cors });
    }
    if (url.pathname === "/internal/permission" && request.method === "POST") {
      return internalPermission(request);
    }
    if (!secretEquals(bearer(request), config.token)) {
      return json({ error: "Missing or wrong token." }, 401, cors);
    }
    const handler = routes[`${request.method} ${url.pathname}`];
    if (!handler) {
      return json({ error: "Not found." }, 404, cors);
    }
    if (
      request.method === "POST" &&
      !/^application\/json\b/i.test(request.headers.get("content-type") ?? "")
    ) {
      return json({ error: "Content-Type must be application/json." }, 415, cors);
    }
    return handler(request, cors);
  },
  error(error) {
    console.error("[planner-claude] request failed:", error);
    return json({ error: "Internal error." }, 500, {});
  },
});

console.log(`[planner-claude] v${VERSION} listening on http://${server.hostname}:${server.port}`);
console.log(`[planner-claude] allowed origins: ${config.allowedOrigins.join(", ")}`);
if (config.allowedProjectRoots.length) {
  console.log(`[planner-claude] project roots: ${config.allowedProjectRoots.join(", ")}`);
}

for (const sig of ["SIGINT", "SIGTERM"] as const) {
  process.on(sig, () => {
    runs.killAll();
    void server.stop(true);
    // Give the CLIs a moment to exit on SIGTERM, then make sure none outlive us.
    setTimeout(() => {
      runs.killAll(true);
      process.exit(0);
    }, 2_000).unref();
  });
}
