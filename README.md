# execute-cli/claude

Local bridge between Planner's **Run agent → Claude Code** and the `claude`
CLI on your computer. Planner posts a task to it; it runs `claude -p` in the
project folder you picked and keeps the run alive while it streams. What the
agent is doing shows live under the task's comments: the
`planner-for-claude-code` skill reports it with `planner.sh event`, the same
live progress a pasted **Copy context** link gets.

## Run

```bash
cd execute-cli/claude
bun install        # once, editor types + tests
bun start          # or: bun run dev (restarts on change)
bun test           # unit + end-to-end tests (uses a fake claude CLI)
```

On first start it copies the defaults from `config.example.json` into
`config.json` (git-ignored, mode 600) with a new random `token`, and prints
the URL it listens on (default `http://127.0.0.1:4319`).

Then in Planner: **Settings → API keys → Claude Code server**, paste the URL
and the `token` from `config.json`, **Save**, then **Test**.

The agent needs the skill installed globally (see
[`skills/README.md`](../../skills/README.md)):

```bash
cp -R skills/planner-for-claude-code ~/.claude/skills/
```

and your Plan API key saved with `planner.sh login --clipboard`
(`~/.claude/planner-token`).

## Config (`config.json`)

| Key                         | Default                                   | What it does                                                                                                      |
| --------------------------- | ----------------------------------------- | ----------------------------------------------------------------------------------------------------------------- |
| `host`                      | `127.0.0.1`                               | Bind address. Loopback only; anything else is refused.                                                            |
| `port`                      | `4319`                                    |                                                                                                                   |
| `token`                     | generated                                 | Bearer token Planner must send (min. 32 chars). Rotate by clearing it and restarting.                             |
| `allowedOrigins`            | `localhost:3000` and the deployed Planner | Planner origins allowed to call the server (CORS). Add yours if you deploy elsewhere.                             |
| `allowedProjectRoots`       | `[]`                                      | Folders a run may start in (or below). Empty = any folder. Symlinks are resolved first.                           |
| `maxConcurrentRuns`         | `4`                                       | More runs at once get `429`.                                                                                      |
| `allowAutoMode`             | `true`                                    | `false` refuses requests with `auto: true` (`403`); `/health` reports it as `autoMode`.                           |
| `trustProjectPlannerScript` | `false`                                   | Also auto-allow a `planner.sh` inside the project's own `.claude/skills/`. Off: a cloned repo could ship one.     |
| `approvalTimeoutMinutes`    | `10`                                      | How long a paused tool call waits for Allow / Deny in Planner before it is denied.                                |
| `timeoutMinutes`            | `30`                                      | A run is killed after this long.                                                                                  |
| `claude.bin`                | `claude`                                  | Path to the Claude Code CLI.                                                                                      |
| `claude.permissionMode`     | `acceptEdits`                             | `--permission-mode` (`acceptEdits`, `auto`, `bypassPermissions`, …). A run with Auto mode on uses `auto` instead. |
| `claude.model`              | `""`                                      | `--model`, empty for your default.                                                                                |
| `claude.allowedTools`       | `[]`                                      | `--allowedTools`, e.g. `["Bash(pnpm:*)", "Bash(git:*)"]`.                                                         |
| `claude.extraArgs`          | `[]`                                      | Any other CLI flags, appended as-is.                                                                              |

The globally installed `planner.sh` (`~/.claude/skills/…`) is always
allowed, so the agent can read the task, report its progress and post its
completion comment. A copy inside the project folder is only auto-allowed
with `trustProjectPlannerScript: true`; otherwise its calls ask in Planner.

## Security model

The bridge runs an agent that can change files on this machine, so:

- It binds to loopback only and refuses any `Host` that isn't loopback (DNS rebinding).
- Browser requests must come from `allowedOrigins`; every `POST` must be
  `application/json`, which forces a CORS preflight (no form-post CSRF).
- The master `token` is compared in constant time; request bodies are capped at 1 MB.
- `config.json` is kept at mode `600` (fixed and warned about at start if looser).
- **The agent never sees the master token.** Its approval tool gets a random
  per-run token that is only accepted by `/internal/permission` for that run:
  it can _ask_ the user, never _answer_. A prompt-injected agent that reads
  its MCP server's argv/env (`ps`) still can't approve itself or start runs.
- The prompt is written to `claude`'s stdin, never put in argv, so request
  text can't be parsed as a CLI flag and doesn't show in `ps`.
- Runs past `timeoutMinutes`, stopped from Planner, or alive at shutdown get
  `SIGTERM`, then `SIGKILL` after 5 s.

Residual risk: the agent runs as you. With `bypassPermissions`, an
over-broad `allowedTools`, or a project `.claude/settings.json` that allows
everything, it can read `config.json` like any other file you own. Use
`allowedProjectRoots` and keep `permissionMode` at `acceptEdits` / `auto` for
code you didn't write.

## Approvals

Anything else that needs permission — running `node`, `pnpm`, `git`, a write
outside the folder — is **asked in Planner**. Each run gets
`permission-mcp.ts` as its `--permission-prompt-tool`: the tool call pauses,
the live panel under the task's comments shows what it wants to run with
**Allow** / **Deny**, and the agent continues with your answer. Answer from
the computer running the bridge (the buttons call it directly). No answer in
`approvalTimeoutMinutes` denies it; stopping or ending the run denies what is
still waiting.

To skip asking for things you always allow, list them in `allowedTools`
(`["Bash(pnpm:*)", "Bash(node:*)"]`), the project's `.claude/settings.json`,
or use `"permissionMode": "bypassPermissions"` for a trusted project.

### Auto mode

Turn on **Auto mode** in the Run agent dialog (Planner remembers it per
browser) to run that task with `--permission-mode auto` instead of
`claude.permissionMode`. Claude Code's safety classifier then approves
routine tool calls itself and blocks risky ones (force pushes, deleting
outside the project, piping downloads into a shell…); only what it can't
settle still comes to Planner as Allow / Deny. It needs a Claude Code
version and plan that support auto mode: if yours doesn't, the run fails at
start and the CLI's error shows on the task. Set
`"permissionMode": "auto"` in `config.json` to make it the default for
every run.

Your normal Claude Code setup still applies: the CLI's login, `~/.claude`
settings and skills, and the project's own `.claude/settings.json` and
`CLAUDE.md`. Set `PLANNER_CLAUDE_CONFIG=/path/to/config.json` to use a config
elsewhere.

## API

All routes except `/internal/permission` need `Authorization: Bearer <token>`.
Requests with an `Origin` must come from `allowedOrigins`; the `Host` must be
loopback; `POST` bodies must be `application/json`.

### `GET /health`

`200 { "ok": true, "name": "planner-claude-code", "version": "2.0.0", "autoMode": true }`

### `POST /api/claude-code/execute`

```json
{
  "projectPath": "/Users/me/code/my-app",
  "context": "Do this plan\nhttp://localhost:3000/api/plan/<todoId>?fileId=<fileId>",
  "extraContext": "Use pnpm. Don't touch the migrations.",
  "auto": true
}
```

- `projectPath` — absolute path of an existing folder (inside `allowedProjectRoots` if set); the agent's working directory.
- `context` — the **Copy context** text (one-line ask + Plan API link).
- `extraContext` — optional free text.
- `auto` — optional; `true` runs with `--permission-mode auto` (see [Auto mode](#auto-mode)); `403` when `allowAutoMode` is off.

Errors: `400` bad body or folder, `403` folder outside `allowedProjectRoots`
or auto mode off, `415` not JSON, `429` `maxConcurrentRuns` reached.

The prompt is the two in that order:

```
<context>

Extra context:
<extraContext>
```

Response: `application/x-ndjson`, one JSON object per line: Claude's
`stream-json` events (`system`, `assistant`, `user`, `result`) framed by the
bridge's own:

```json
{"type":"planner","event":"start","runId":"…","pid":123,"cwd":"/Users/me/code/my-app","auto":true}
{"type":"planner","event":"exit","code":0}
```

Closing the request (Planner's **Stop** on the live run under the task's
comments, or closing the tab that started it) kills the run.

### `POST /api/claude-code/permission`

`{ "runId", "requestId", "allow": true | false }` → `{ "ok": true }`, or 404
when that request is no longer waiting. `runId` comes from the stream's
`start` line, `requestId` from its `permission_request` line:

```json
{"type":"planner","event":"permission_request","requestId":"…","tool":"Bash","detail":"node index.ts"}
{"type":"planner","event":"permission_resolved","requestId":"…","allow":true}
```

`POST /internal/permission` is the other end, called by `permission-mcp.ts`
with the run's own token (the master token is refused there, as is any
request with an `Origin`).

### `POST /api/local/pick-folder` · `POST /api/local/open-folder`

The OS folder picker (`{ "path": "/abs/path" }`, or `{ "path": null }` when
cancelled; `409` if one is already open) and "open in Finder/Explorer" (`{ "path" }` → 204; on macOS a folder with an
extension, which may be a bundle like `Foo.app` or `Foo.prefPane`, is
revealed rather than opened). Planner uses
them when it is not running on this machine (a deployed copy can't open
dialogs here); on localhost it uses its own `/api/local/*` routes.

```bash
curl -N -X POST http://127.0.0.1:4319/api/claude-code/execute \
  -H "Authorization: Bearer $TOKEN" -H "Content-Type: application/json" \
  -d '{"projectPath":"'"$PWD"'","context":"Say hi"}'
```
