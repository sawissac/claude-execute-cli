/** End to end: the real server, with test/fake-claude.sh as the CLI. */
import { afterAll, beforeAll, expect, test } from "bun:test";
import { mkdtempSync, statSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

const dir = mkdtempSync(join(tmpdir(), "pcc-srv-"));
const project = mkdtempSync(join(tmpdir(), "pcc-proj-"));
const configPath = join(dir, "config.json");
const port = 43_000 + Math.floor(Math.random() * 1000);
const TOKEN = `pcc_test_${"k".repeat(32)}`;
const base = `http://127.0.0.1:${port}`;
const ORIGIN = "http://localhost:3000";
let server: ReturnType<typeof Bun.spawn>;

const call = (path: string, init: RequestInit & { token?: string | null } = {}) =>
  fetch(`${base}${path}`, {
    method: "POST",
    ...init,
    headers: {
      "Content-Type": "application/json",
      ...(init.token === null ? {} : { Authorization: `Bearer ${init.token ?? TOKEN}` }),
      ...(init.headers as Record<string, string>),
    },
  });

beforeAll(async () => {
  writeFileSync(
    configPath,
    JSON.stringify({
      port,
      token: TOKEN,
      allowedOrigins: [ORIGIN],
      allowedProjectRoots: [project],
      maxConcurrentRuns: 1,
      allowAutoMode: false,
      claude: { bin: join(import.meta.dir, "fake-claude.sh") },
    }),
    { mode: 0o644 },
  );
  server = Bun.spawn(["bun", join(import.meta.dir, "..", "server.ts")], {
    env: { ...process.env, PLANNER_CLAUDE_CONFIG: configPath },
    stdout: "ignore",
    stderr: "ignore",
  });
  for (let i = 0; i < 50; i++) {
    if (
      await fetch(`${base}/health`).then(
        () => true,
        () => false,
      )
    )
      return;
    await Bun.sleep(100);
  }
  throw new Error("server didn't start");
});

afterAll(() => server?.kill());

test("tightens a world-readable config to 600", () => {
  expect(statSync(configPath).mode & 0o777).toBe(0o600);
});

test("auth, host and origin checks", async () => {
  expect((await fetch(`${base}/health`)).status).toBe(401);
  expect(
    (await fetch(`${base}/health`, { headers: { Authorization: "Bearer nope" } })).status,
  ).toBe(401);
  const ok = await fetch(`${base}/health`, { headers: { Authorization: `Bearer ${TOKEN}` } });
  expect(await ok.json()).toMatchObject({ ok: true, autoMode: false });
  expect(
    (await call("/health", { method: "GET", headers: { Origin: "https://evil.example" } })).status,
  ).toBe(403);
  expect((await call("/health", { method: "GET", headers: { Host: "evil.example" } })).status).toBe(
    403,
  );
  expect(
    (
      await call("/api/local/open-folder", {
        headers: { "Content-Type": "text/plain" },
        body: "{}",
      })
    ).status,
  ).toBe(415);
});

test("refuses folders outside allowedProjectRoots and disabled auto mode", async () => {
  const outside = await call("/api/claude-code/execute", {
    body: JSON.stringify({ projectPath: dir, context: "hi" }),
  });
  expect(outside.status).toBe(403);
  const auto = await call("/api/claude-code/execute", {
    body: JSON.stringify({ projectPath: project, context: "hi", auto: true }),
  });
  expect(auto.status).toBe(403);
});

test("run: prompt via stdin, scoped run token, approval round-trip", async () => {
  const res = await call("/api/claude-code/execute", {
    body: JSON.stringify({ projectPath: project, context: "--dangerously-skip-permissions ASK" }),
  });
  expect(res.status).toBe(200);
  const reader = res.body!.pipeThrough(new TextDecoderStream()).getReader();
  const events: Record<string, any>[] = [];
  let buf = "";
  let runId = "";
  // A second run is over maxConcurrentRuns.
  const busy = await call("/api/claude-code/execute", {
    body: JSON.stringify({ projectPath: project, context: "x" }),
  });
  expect(busy.status).toBe(429);
  for (;;) {
    const { value, done } = await reader.read();
    if (done) break;
    buf += value;
    const lines = buf.split("\n");
    buf = lines.pop()!;
    for (const l of lines.filter(Boolean)) {
      const e = JSON.parse(l);
      events.push(e);
      if (e.event === "start") runId = e.runId;
      if (e.event === "permission_request") {
        // Only the master token can answer.
        const ans = await call("/api/claude-code/permission", {
          body: JSON.stringify({ runId, requestId: e.requestId, allow: true }),
        });
        expect(ans.status).toBe(200);
      }
    }
  }
  const fake = events.filter((e) => e.type === "fake");
  expect(fake[0]!.prompt).toBe("--dangerously-skip-permissions ASK");
  expect(fake[0]!.args).not.toContain("--dangerously-skip-permissions ASK");
  expect(JSON.stringify(fake[0]!.args)).not.toContain(TOKEN);
  expect(fake[1]!.selfApproveStatus).toBe(401);
  expect(fake[2]!.decision).toEqual({ allow: true });
  expect(events.at(-1)).toMatchObject({ event: "exit", code: 0 });
});

test("internal route rejects the master token and browsers", async () => {
  const r = await call("/internal/permission", {
    body: JSON.stringify({ runId: "x", tool: "Bash", input: {} }),
  });
  expect(r.status).toBe(401);
  const b = await call("/internal/permission", {
    headers: { Origin: ORIGIN },
    body: JSON.stringify({ runId: "x" }),
  });
  expect(b.status).toBe(403);
});
