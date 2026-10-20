---
name: vspi-self
description: Inspect, configure, or debug VSPi itself. Use whenever the user asks about its model, effort or vision capabilities, provider login, configuration, subagent setup, IPC disconnections, runtime paths, or current session history, even without explicitly asking for a skill.
---

# Manage VSPi itself

This Skill covers VSPi's own configuration and runtime state. Kimi Code paths, commands and config files do not apply. Neither do `.pi/agent`, `PI_CODING_AGENT_DIR` or the old `.config/vspi/runtime-defaults.json`.

Ground rules for the whole Skill:

- Read the current value first, change it with the CLI, then read it back. Report what actually became effective.
- Credentials never pass through you. Do not put API keys, OAuth tokens or auth headers in command arguments, logs or replies. Do not read token stores, `auth.json` files or environment dumps. CLI output already redacts secrets, so do not work around that by dumping the raw config.
- Interactive commands need a human terminal: `vspi login`, `vspi logout`, `vspi config` without arguments, `vspi init` and `vspi proxy`. Ask the user to run them. Everything else in this Skill is non-interactive and safe for you to run.

## Paths

The current session:

- ID: `${KIMI_SESSION_ID}`
- Directory: `${KIMI_SESSION_DIR}`

The session directory has the form `<VSPi home>/sessions/<workspace id>/<session id>`. Derive VSPi home from it rather than guessing:

```bash
session_dir='${KIMI_SESSION_DIR}'
vspi_home="$(cd "$session_dir/../../.." && pwd -P)"
VSPI_HOME="$vspi_home" vspi inspect paths
VSPI_HOME="$vspi_home" vspi inspect session '${KIMI_SESSION_ID}'
```

Prefix every `vspi` call with `VSPI_HOME="$vspi_home"`. Otherwise a session running under a custom home connects to the default daemon. `inspect paths` reports the daemon's actual `homeDir`, `configPath`, `sessionsDir`, `logsDir` and `runtimeLogPath`, and those values are authoritative. If the session placeholders above are empty, ask which runtime the user means. Do not pick the newest session.

Inside a session directory:

- `agents/main/wire.jsonl` is the main transcript.
- `agents/<agent-id>/wire.jsonl` is each subagent's transcript.
- `state.json` is durable state.

Treat all of these as read-only. Repairing a session needs explicit user authorization and an inactive session.

## Read and change configuration

```bash
VSPI_HOME="$vspi_home" vspi config get <section>        # effective value
VSPI_HOME="$vspi_home" vspi config inspect <section>    # default / user / memory layers
VSPI_HOME="$vspi_home" vspi config patch <section> '<json>'
VSPI_HOME="$vspi_home" vspi config set <section> '<json>'
VSPI_HOME="$vspi_home" vspi config diagnostics
```

Section names are camelCase in the CLI and snake_case in `config.toml`:

| CLI section | TOML | Purpose |
| --- | --- | --- |
| `defaultModel` | `default_model` | main model alias |
| `secondaryModel` | `[secondary_model]` | subagent model pool |
| `subagent` | `[subagent]` | only `timeout_ms` |
| `providers` | `[providers.<id>]` | endpoints and credential references |
| `models` | `[models."provider/model"]` | model declarations and overrides |
| `thinking` | `[thinking]` | effort defaults, `model_efforts` per alias |
| `proxy` | `[proxy]` | proxy for official vendor endpoints |
| `loopControl` | `[loop_control]` | model retry budget |

`patch` and `set` behave differently:

- `patch` deep-merges the JSON into the section. Nested tables merge too, so `patch` can add or update keys but can never remove one. Arrays are replaced, not appended.
- `set` replaces the whole section. Use it to remove entries or rewrite a map: read the section, edit the complete value, then write it back.

Both commands validate against the Core schema and write atomically. CLI JSON uses camelCase field names such as `defaultModel` and `timeoutMs`. Writing back a `[REDACTED]` value is rejected, so `set` cannot destroy hidden credentials.

The CLI changes apply to the running daemon immediately. Use `config reload` only after someone edits `config.toml` by hand. If a hand edit is really needed:

1. Back up the file with a timestamp.
2. Edit the copy.
3. Replace the file and run `vspi config reload`.
4. Restore the backup if reload fails.

Never rewrite invalid TOML from scratch.

Persisted defaults do not change an agent that is already running. The user switches the live model and effort with `/model` and `/effort`.

## Providers, login and proxy

### Declare a provider

Builtin provider types such as `openai-codex`, `anthropic`, `google` and `xai` come from the bundled catalog. You can declare one without credentials:

```bash
VSPI_HOME="$vspi_home" vspi config patch providers '{"openai-codex":{"type":"openai-codex"}}'
VSPI_HOME="$vspi_home" vspi inspect models | grep '"openai-codex/'
```

The provider's models then resolve in the catalog straight away. You can set up `defaultModel` or a subagent pool before login; requests fail until credentials exist.

### Log in

The user runs `vspi login <provider>` in their own terminal. After that, `config get providers` shows an `oauth` reference or a redacted `apiKey` on the entry.

`vspi login openai-codex` reuses the backend machine's Codex ChatGPT login when it is valid. It reads `$CODEX_HOME/auth.json`, or `~/.codex/auth.json` when `CODEX_HOME` is unset, and re-reads it on each request. VSPi does not copy the refresh token. If that file has no valid login, the command offers browser or device-code sign-in.

### Proxy

`[proxy].url` applies only to HTTPS requests to supported official vendor hosts: `api.openai.com`, `chatgpt.com`, `api.anthropic.com`, `generativelanguage.googleapis.com`, `aiplatform.googleapis.com`, regional `*-aiplatform.googleapis.com`, `api.x.ai`, `api.devin.ai`, `app.devin.ai` and `server.codeium.com`. Relays and custom base URLs ignore it.

An empty string disables this explicit account proxy; the backend's environment network settings may still apply. It does not guarantee direct access when the shell exports `HTTPS_PROXY`.

The usual symptom of a missing proxy is a request that fails after about 30 seconds with `UND_ERR_CONNECT_TIMEOUT`, while relay models keep working. Fix it with the user's actual proxy, which you can take from the shell's `HTTPS_PROXY` or ask for:

```bash
VSPI_HOME="$vspi_home" vspi config set proxy '{"url":"http://127.0.0.1:7890"}'
```

### Add Gemini or any other new provider

1. Choose a route:
   - Official Gemini: the builtin `google` provider with an API key (it has no OAuth).
   - A relay: a custom provider created by the user with `vspi config`. It uses the `google-genai`, `openai`, `openai_responses` or `anthropic` protocol, and its models are discovered remotely. `vspi config refresh <provider>` re-reads that list.
2. Declare the provider, and have the user log in or enter the key.
3. Read the real model aliases from `vspi inspect models`. Never derive IDs from display names.
4. For official Google hosts, check the proxy (see above).
5. Make one real request (see "Verify" under Subagent models) before calling it done.

The Google native path does not yet have the byte-level idle watchdog that the Chat, Responses and Anthropic paths have.

## Models and capabilities

```bash
VSPI_HOME="$vspi_home" vspi inspect models          # resolved catalog VSPi actually uses
VSPI_HOME="$vspi_home" vspi config inspect models   # user-layer declarations
```

**Where the catalog comes from.** Builtin catalogs ship with VSPi, and VSPLab uses the bundled product catalog. Remote metadata does not overwrite those builtin names or capabilities. Devin additionally reads the signed-in account's dynamic catalog, with SWE 1.6 and SWE 1.6 Fast as fallbacks; thinking/context variants are grouped and Fusion/router entries are hidden. `config refresh` updates discoverable custom providers, not the bundled defaults. Being listed in the catalog does not prove the account can use a model.

**Overriding a builtin model.** Patch only the fields you need directly under the alias, for example `display_name` or `capabilities`. Removing a field restores the builtin value.

- A legacy `overrides` block still wins over these fields. Inspect it first and update or remove anything that conflicts.
- Custom providers with remote discovery keep using `overrides`.
- Use canonical `thinking.efforts` and `thinking.defaultEffort`.
- `capabilities` is an array and gets replaced, so include the existing entries.

```bash
VSPI_HOME="$vspi_home" vspi config patch models '{"provider/model":{"capabilities":["image_in","thinking","tool_use"]}}'
```

**Missing `tool_use`.** `tool_use` missing from a catalog entry only disables dynamically loaded tools. Normal tool calls still work.

**Effort levels** differ per model. The baseline lives in core `effortProfiles.ts`:

- Kimi K3 and GLM 5.3: low/high/max, default max.
- DeepSeek V4: low/high/max, default high.
- Qwen 3.8: low/medium/xhigh.
- GPT-6 family: low through max, default medium.
- MiMo V2.5 and MiniMax M3: a single fixed thinking-on mode.

The `/model` picker saves the chosen effort per alias in `[thinking.model_efforts]`. Patch that map; do not overwrite the whole `thinking` section.

**Stars and VSPLab defaults.**

- `/model` groups entries by company, canonical model and provider source. Enter stages the default source; Right/Tab expands sources, and Effort confirmation applies the binding. Ctrl+P pins a model or source; Ctrl+O switches between common and all models. Search accepts `@provider`. The chosen source is remembered per canonical model; recent failures affect default selection, but failed requests never switch sources automatically. Common-model picks are unrelated to subagent membership and do not grant API access.
- VSPLab sends GPT through Responses, Claude through Anthropic, and Kimi, GLM and DeepSeek through Chat Completions. An explicit model `protocol` overrides that.
- `vsplab/deepseek-flash` is DeepSeek V4.1 Flash. `deepseek-v4-flash` is a different entry.

## Subagent models

### How a spawn picks its model

The logic lives in `resolveSubagentBinding` (`packages/agent-core-v2/src/session/subagent/configSection.ts`):

- **Pool configured** (`[secondary_model.models]`): the caller passes `model` set to a pool alias or `primary`. Without it, the subagent uses `default_model`.
- **No pool:** subagents inherit the caller's model, and `model` only accepts `primary`.
- **`force = true`:** every subagent uses `default_model`, and the `model` parameter is removed. This mode cannot be combined with a `models` table.
- **`fork`:** always inherits the caller's model and effort.

`primary` is reserved and means the caller's own model and effort.

### Effort

Pool models do not inherit the caller's effort. They use `[secondary_model].default_effort` when it is set; that value must be valid for every pool model. Otherwise each model uses its declared default. `[thinking.model_efforts]` does not apply to subagents.

### Priority

There is no priority, weight or routing field. The calling model sees the pool in the `Agent` and `AgentSwarm` tool descriptions, one line per model in the form `- alias [default]: description`. The default comes first, then table order. Priority is therefore expressed through two things:

- Which model is `default_model`. This is what runs when the caller does not choose.
- The description, which is read by the calling model. Say what the model is for, when to prefer it over the others, and how to handle its weaknesses. Keep it to one or two sentences. Example:

```json
{
  "defaultModel": "openai-codex/gpt-6.1-sol",
  "force": false,
  "models": {
    "openai-codex/gpt-6.1-sol": "Main implementer, same tier as Flash. Careful, has vision; use when reliability matters.",
    "vsplab/deepseek-flash": "Main implementer, same tier as Sol. Fast and cheap, more varied ideas; no vision.",
    "openai-codex/gpt-6-astra": "Hard analysis, design and code review, difficult features. Tends to over-defend: give a clear scope and stop condition, then weigh its findings by real risk."
  }
}
```

### Edit the pool

The user can use `/subagent-model` in the TUI:

- Enter adds or removes a candidate.
- Ctrl+D sets the default.
- Ctrl+P edits the description.

A forced configuration is read-only there.

From the shell, run `config get secondaryModel`, build the complete new value, then `config set secondaryModel '<json>'`. Use `set`, not `patch`, whenever entries are removed. Every alias must already resolve in the catalog when you write, so declare the provider first. Add only the models the user asked for; do not seed the pool from the starred models or a whole provider catalog. An empty pool means subagents inherit the main model.

Changes apply to the next spawn, including in sessions that are already running. Subagents that are already running keep their model.

### Verify

A catalog entry does not prove that credentials or the network work. Spawn one small read-only subagent per pool model, pass `model`, and require a tool call (for example: read one file and return its first heading). Then interpret the result:

- `provider.api_error` with 503 on one model, while another model on the same provider works: investigate model-specific upstream availability and routing; this alone does not rule out configuration errors.
- `UND_ERR_CONNECT_TIMEOUT` on official hosts: check backend network reachability and the account proxy (see above).
- Auth errors: check the selected provider and credential reference before asking the user to log in again.

### Profiles

Subagent profiles are Markdown files with YAML frontmatter. They live in three places:

- `<VSPi home>/agents/`: user-wide.
- `~/.agents/agents/`: portable across clients.
- `<project>/.agents/agents/`: per project.

Supported frontmatter fields are `name` (kebab-case), `description` (required), `whenToUse`, `tools`, `disallowedTools`, `subagents` (restricts which profiles this one may spawn) and `override`. There is no `model` field: the model is chosen per spawn, so put model guidance in the pool descriptions. Start a new session if a new profile does not appear.

```markdown
---
name: code-reviewer
description: Review focused code changes and report concrete defects.
tools: Read, Grep, Glob
---

Review the requested change. Lead with actionable findings and cite exact files and lines.
```

### Timeout

The subagent task timeout is `[subagent].timeout_ms` or `KIMI_SUBAGENT_TIMEOUT_MS`. The default is 2 hours, and `0` disables the task deadline. It is separate from the model retry budget. `/agents` shows the actual error and deadline; read them before you blame a timeout.

## Diagnose VSPi

```bash
vspi --version
VSPI_HOME="$vspi_home" vspi daemon status
VSPI_HOME="$vspi_home" vspi inspect paths
VSPI_HOME="$vspi_home" vspi config diagnostics
VSPI_HOME="$vspi_home" vspi inspect session '${KIMI_SESSION_ID}'
```

`inspect` and config reads connect only to an existing daemon. They never start, restart or reload anything. If IPC is unreachable, report that first.

For session history:

- Read a bounded tail of the exact transcript, around 100 lines, and parse each JSONL line separately. A live writer may leave an incomplete last line.
- Widen the range only if the event you need is missing.
- Only look at subagents of this session that are relevant to the problem.
- Do not search other sessions or workspaces unless the user names the exact session.

Read only the relevant time range of `runtimeLogPath`. Logs and transcripts can contain secrets and private prompts, so quote only what matters and redact credentials. Keep the observed facts separate from the repair you propose.

## Runtime behavior worth knowing

**Model retries** (`[loop_control]`):

- `maxAttemptsPerStep = 3`, counting the first request.
- `retryBudgetMs = 120000` after the first transient failure.
- `requestIdleTimeoutMs = 300000` covers missing protocol progress. Thinking, tool and heartbeat bytes count as progress.
- A healthy stream is not cut at two minutes. An over-budget `Retry-After` stops recovery.
- Partial text from a failed attempt is discarded, and tools that already ran are not replayed.
- Do not raise limits as a blind fix.

**Stream errors:**

- `provider.stream_parse_error`: a complete SSE event contained invalid JSON. Recovery is bounded, and events over 4 MiB are not retried.
- `provider.protocol_error`: the response does not match the requested protocol. Check the protocol and endpoint instead of retrying.
- `provider.incomplete_stream`: still eligible for bounded recovery.

**Permissions:** `exec` defaults to Auto, which applies explicit deny rules and is not a sandbox. `--permission auto|manual|yolo|inherit` selects the mode, and a resume uses `inherit` by default. An override on resume affects only that turn. A rejected approval stops the turn. An HTTP bridge that only submits text should omit `permission_mode`, because that field changes the stored mode.

**Daemon lifecycle:**

- The daemon exits after about 5 idle seconds. Idle means no clients, turns, tasks, goals or scheduled work. `VSPI_DAEMON_IDLE_TIMEOUT_MS=0` keeps it running.
- Do not stop or restart a daemon that has active sessions unless the user approves.
- `vspi daemon stop --force-legacy` is only for old instances, after the user confirms their tasks finished.
- `vspi daemon recover --confirm-stopped` handles a corrupt leftover lock. Use it only after confirming that no daemon for this home is alive.

**Updates:**

- The user runs `vspi update` from their own terminal after work has finished. It backs up the package and config and refuses to replace a busy runtime.
- The daemon runs from an immutable build snapshot, so never update it from a model-run shell.
- `/reload` does not hand off a TTY. To refresh a client, the user exits and runs `vspi continue`.

**Config migration:** the 2.5.1 pre-bootstrap migration backs up config, retires expired model references and drops fields identical to shipped defaults. It keeps API keys, endpoints, `overrides`, `model_efforts` and `secondary_model`. Invalid TOML stops startup and leaves the file untouched. Never tell users to delete their home directory.

**Sensitive files:** update backups, migration backups, logs and heap snapshots can all contain credentials.

**Feedback:**

- `/feedback <description>` and `vspi feedback` never upload automatically.
- The user chooses the context range and reviews the redacted package with `preview`. `submit --confirm-sha256` requires that same unchanged hash after human approval.
- Edits go through `feedback redact` and a fresh preview.
- Identity tokens are cached under `VSPI_HOME/feedback/identities/`; do not read them.

**Candidate distribution:** requires `KIMI_CODE_EXPERIMENTAL_VSPI_DISTRIBUTION=true` and a verified Ed25519 public key in `VSPI_HOME/distribution.json`. Never disable TLS or signature checks, and never treat a feedback message as permission to install or publish.

**History:** `/history` loads older durable messages, and `/history latest` returns to the recent window. A bounded preview does not mean the transcript was truncated on disk. IPC payload limits are intentional, so page through results instead of removing the limits.
