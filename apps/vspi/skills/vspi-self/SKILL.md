---
name: vspi-self
description: Inspect, configure, or debug VSPi itself. Use whenever the user asks about its model, effort or vision capabilities, provider login, configuration, subagent setup, IPC disconnections, runtime paths, or current session history, even without explicitly asking for a skill.
---

# Manage VSPi itself

Use this Skill for VSPi's own configuration and runtime state. Do not apply Kimi Code paths, commands, or configuration instructions.

## Authoritative paths

The current session is:

- ID: `${KIMI_SESSION_ID}`
- Directory: `${KIMI_SESSION_DIR}`

The session directory is `<VSPi home>/sessions/<workspace id>/<session id>`. Derive the exact VSPi home from the current session instead of guessing or selecting the newest session:

```bash
session_dir='${KIMI_SESSION_DIR}'
vspi_home="$(cd "$session_dir/../../.." && pwd -P)"
config_path="$vspi_home/config.toml"
sessions_dir="$vspi_home/sessions"
log_path="$vspi_home/server/runtime.log"
printf 'home=%s\nconfig=%s\nsessions=%s\nlog=%s\n' "$vspi_home" "$config_path" "$sessions_dir" "$log_path"
```

Normally VSPi home is `$VSPI_HOME` when set, otherwise `~/.vspi`. Use the current session directory to select the runtime, then verify the paths reported by the running daemon:

```bash
VSPI_HOME="$vspi_home" vspi inspect paths
VSPI_HOME="$vspi_home" vspi inspect session '${KIMI_SESSION_ID}'
```

`inspect paths` returns the daemon's actual `homeDir`, `configPath`, `sessionsDir`, `logsDir`, and `runtimeLogPath`. These are authoritative; the shell's home or working directory may differ. `vspi config path` only resolves the current shell's choice of home without connecting. If the session placeholders are empty or unresolved, ask for the intended runtime/session instead of picking the newest one.

The current session's main transcript is `agents/main/wire.jsonl`; durable state is `state.json`; subagent transcripts live at `agents/<agent-id>/wire.jsonl`. The inspect command returns metadata and a transcript path, not prompt content. It does not restore an archived session. Treat these files as read-only diagnostic data. Session repair is a separate operation that needs explicit user authorization and an inactive session.

## Read or change runtime configuration

Prefer the non-interactive CLI because Core validates the section and writes `config.toml` atomically:

```bash
VSPI_HOME="$vspi_home" vspi config get defaultModel
VSPI_HOME="$vspi_home" vspi config set defaultModel '"provider/model"'
VSPI_HOME="$vspi_home" vspi config get secondaryModel
VSPI_HOME="$vspi_home" vspi config patch secondaryModel '{"defaultModel":"provider/model","models":{"provider/model":"default subagent model"}}'
VSPI_HOME="$vspi_home" vspi config inspect thinking
VSPI_HOME="$vspi_home" vspi config diagnostics
```

The CLI uses Core section names in camelCase. The corresponding TOML keys are snake_case:

- `defaultModel` -> top-level `default_model`, the main model alias.
- `secondaryModel` -> `[secondary_model]`, the subagent model policy.
- `subagent` -> `[subagent]`; this section only controls `timeout_ms`, not the subagent model pool.
- `models` -> `[models."provider/model"]`, model declarations.
- `providers` -> `[providers.<id>]`, provider declarations and credentials.

For `[secondary_model.models]`, every table key is a configured model alias, `default_model` must name one of those keys, and `primary` is reserved for the calling agent's model. With `force = true`, set `default_model` and do not set a `models` table. VSPi enables the `secondary-model` feature by default.

For object sections prefer `config patch`: Core merges the supplied fields, validates the resulting section, and writes atomically. CLI JSON uses camelCase field names such as `timeoutMs` and `defaultEffort`, not TOML snake_case. Arrays are replaced, not appended. For scalar values use `config set`. `config set` replaces the complete section; only use it after inspecting that section and preserving unrelated fields. The CLI rejects writing `[REDACTED]` values back so hidden credentials cannot accidentally be destroyed.

`config inspect` distinguishes effective, default, user, and memory values. `config get` returns the effective value; environment or memory overrides may still take precedence after a successful write. Read back after changes and report what actually became effective. API writes apply to the running config service; use `config reload` only after an authorized external file edit, not as a routine diagnostic. Changing persisted defaults does not prove an already running agent switched models or effort; use the TUI `/model` and `/effort` to change the active agent.

Prefix model-run CLI calls with `VSPI_HOME="$vspi_home"` so a custom-home session cannot connect to the default daemon by mistake. `vspi init` and `vspi config` provide the interactive provider setup, while `vspi login <provider>` handles supported login flows. These require a human terminal; do not launch interactive auth from a non-interactive model shell. Never put API keys, OAuth tokens, or authorization headers in command arguments, logs, or conversation. CLI configuration output hides credentials, headers and environment bags; do not bypass that protection by dumping the raw config or token store.

## Inspect model capabilities

```bash
VSPI_HOME="$vspi_home" vspi inspect models
VSPI_HOME="$vspi_home" vspi config inspect models
```

`inspect models` reads the same resolved Core catalog that VSPi uses. Use the matching model's `capabilities`, `thinking`, `support_efforts`, and `default_effort` instead of guessing from its name or fetching another catalog. The provider adapter supplies the pinned pi-ai definitions; explicit user model overrides are maintained through Core configuration. Do not edit a generated catalog or install another provider library to change one model.

If the user explicitly asks for a capability override, inspect the existing alias and patch its `overrides` block, the highest-priority user layer. Use canonical `thinking.efforts` and `thinking.defaultEffort` there. Old flat `supportEfforts` and `defaultEffort` fields are compatibility inputs; canonical thinking in the same layer takes priority, including thinking saved during initial provider setup. Do not try to change those flat fields underneath an existing canonical thinking definition.

```bash
VSPI_HOME="$vspi_home" vspi config patch models '{"provider/model":{"overrides":{"capabilities":["image_in","thinking","tool_use"],"thinking":{"efforts":["low","medium","high"],"defaultEffort":"medium"}}}}'
VSPI_HOME="$vspi_home" vspi inspect models
```

The example is not a declaration about any real model. Verify the provider's supported values before writing. A custom base URL can serve a different model behind an alias. Preserve other capability entries because arrays are replaced. Only claim success when the read-back catalog matches the requested result.

If direct TOML editing is specifically required, read the existing file first, keep a timestamped backup, edit a candidate copy, and use `vspi config reload` after replacement. If reload fails, restore the backup. Never overwrite invalid TOML from scratch or drop unrelated sections.

## Configure subagent model candidates

The model candidates are user-configured references to the same Core model catalog, not separate provider definitions or an official recommendation list. Use `/subagent-model`: Enter adds/removes a candidate, Ctrl+D sets the default subagent model, and Ctrl+P edits its capability/purpose description. An empty pool inherits the main model. These edits apply to future spawns; they do not switch the main model or running subagents. A forced `secondary_model.force=true` configuration is read-only in this candidate UI; never silently disable it. When editing by CLI, inspect `secondaryModel` first and preserve unrelated settings. Never populate the pool from the main-model stars or the entire provider catalog.

`/model` is independent: its stars are the official common-model selection, not subagent membership or a stability rating. It opens in the starred view; Ctrl+O switches to all models. Search respects the current view. It has no subagent candidate editing shortcuts. Choosing a model opens Effort confirmation before applying either setting; Esc returns without changing the current binding. Effort preferences are stored per actual model alias in `[thinking.model_efforts]`; do not overwrite the entire `thinking` section or copy one model's choice to every model. Existing sessions retain their own binding. The pickers hide Off, and models without adjustable effort use a fixed-configuration confirmation.

For VSPLab, product defaults route GPT through Responses, Claude through Anthropic, and Kimi/GLM/DeepSeek through Chat Completions. A catalog `default_protocol` can update that default; an explicit model `protocol` wins. Inspect the effective protocol before troubleshooting an old configuration; do not silently erase explicit overrides or change official-provider endpoints. Treat an Effort selection as verified only when the effective backend value and request encoding agree.

Effort levels are model-specific, not a universal ladder. Kimi K3 and GLM 5.3 use low/high/max with max as default; DeepSeek V4 uses the same levels with high as default. Qwen 3.8 uses low/medium/xhigh. MiMo V2.5 and MiniMax M3 have no independently documented fine-grained effort control: the UI uses a fixed thinking-on choice, not fabricated Low/Medium/High levels. Keep compatible aliases distinct from real model levels. The source-backed baseline is owned by core `effortProfiles.ts`; versioned relay declarations can update it, while old unversioned lists cannot overwrite it.

The pre-bootstrap migration backs up the configuration and performs a one-time cleanup of provably inherited or redundant relay `protocol` fields, plus stale managed effort metadata. It preserves API keys, custom endpoints, user `overrides`, per-model effort preferences, and `secondary_model`. Do not run destructive blanket cleanup or tell users to delete their home directory; inspect the migration report for ambiguous explicit overrides instead.

## Add or change subagent profiles

Subagent profiles are Markdown files with YAML frontmatter. User-wide VSPi profiles live in `<VSPi home>/agents/`; portable cross-client user profiles may live in `~/.agents/agents/`. Project profiles should use `<project root>/.agents/agents/`. Use kebab-case names and include a non-empty description and prompt body:

```markdown
---
name: code-reviewer
description: Review focused code changes and report concrete defects.
tools: Read, Grep, Glob
---

Review the requested change. Lead with actionable findings and cite exact files and lines.
```

Use `subagents` in a profile only to restrict which child profiles it may spawn. Start a new session after adding a profile if the current session catalog has not refreshed.

## Diagnose VSPi

Use these non-destructive checks first:

```bash
vspi --version
vspi --help
vspi config --help
VSPI_HOME="$vspi_home" vspi daemon status
VSPI_HOME="$vspi_home" vspi inspect paths
VSPI_HOME="$vspi_home" vspi config diagnostics
VSPI_HOME="$vspi_home" vspi inspect session '${KIMI_SESSION_ID}'
```

`inspect` and config reads only connect to an existing daemon. They do not start/restart it or restore a session. If IPC is closed or the daemon is unreachable, record that failure before considering changes; do not turn a diagnostic request into an automatic restart or config reload.

For current-session history, read a bounded tail of the exact transcript returned above (for example 100 lines) and parse each JSONL line separately. A live writer may leave an incomplete final line; do not treat that alone as corruption. Expand the range only when the requested event is absent. Trace a subagent only when its agent ID belongs to this session and is relevant to the reported failure. Never select the newest session, enumerate all session contents, or search another workspace's prompts merely to find a similar error. An explicitly requested historical session needs its exact ID and user-authorized scope.

Read only the relevant time range from `runtimeLogPath` when necessary. Logs and transcripts can contain secrets and private prompts even though CLI config output is redacted: avoid dumping them, omit unrelated content, and redact credentials before reporting. Do not read OAuth token stores or environment dumps. Report the observed error/time/session, evidence, and uncertainty separately from a proposed repair. Do not stop or restart the daemon while sessions are active unless the user explicitly approves the disruption.

## Stability and upgrade boundaries

In 2.3.0, `/history` loads older durable messages and `/history latest` returns to the recent window. The UI does not use compacted model context as its complete conversation history. Long records may have a bounded display preview; never infer that the original transcript was deleted. IPC payload/call budgets are intentional: use paging and lightweight counters instead of removing limits or blindly retrying a timed-out mutation.

Model recovery defaults live in `loopControl` (`[loop_control]`): `maxAttemptsPerStep = 3` includes the first request, `retryBudgetMs = 120000` bounds waiting/reconnecting after the first transient failure, and `requestIdleTimeoutMs = 300000` detects absent protocol progress on Pi Chat/Responses/Anthropic HTTP paths. Receiving protocol content releases that request's hard recovery deadline; a healthy recovered stream is not cut at two minutes. A later failure outside the original recovery window cannot start another attempt. Thinking, tool, and SSE heartbeat bytes count as progress; lack of visible prose is not a timeout. Google/Vertex native SDK and legacy compatibility adapters do not yet provide this byte-level watchdog. Do not claim universal idle-timeout coverage or increase limits as a blind fix. VSPi's finite recovery disables the legacy infinite-retry switch. Over-budget Retry-After stops recovery rather than retrying early. Cancellation clears request/retry timers. Failed partial text is discarded, not concatenated with a successful retry; already-executed tools are not blindly replayed.

The Subagent task timeout remains separate: `[subagent].timeout_ms` / `KIMI_CODE_SUBAGENT_TIMEOUT_MS`, default two hours, with `0` disabling that task deadline only. `/agents` reports the actual error and task deadline. Do not diagnose an unverified “about 30 minutes” failure as a built-in 30-minute limit; inspect the authorized task's error first.

Use `vspi update` from the user's terminal only after work has finished and attached clients have exited. The updater backs up the old package/config, refuses a busy runtime, and verifies installation and runtime startup. The daemon and its nested CLI run from an immutable build snapshot; do not update that snapshot from a model-run shell. `/update` gives the safe CLI workflow. `/reload` does not perform unsafe TTY handoff: ask the user to exit the client and run `vspi continue`, not to stop the shared daemon merely to refresh a terminal.

From 2.2.x, stop the old instance before replacing the installation. New instances shut down through authenticated IPC and produce cleanup confirmation. An old Windows instance may lack this protocol; `vspi daemon stop --force-legacy` explicitly permits termination and is not a diagnostic or a routine repair. Require confirmation that its tasks have finished. Do not bypass failed ownership verification or kill an arbitrary PID.

For a corrupt leftover lock, first establish that no daemon for the selected home is alive. Only then suggest `vspi daemon recover --confirm-stopped`; it protects recent initialization and preserves the old lock. Never remove the entire home. Update backups under `server/update-backups/`, migration backups, logs and heap diagnostics are sensitive data. Heap snapshots near the memory limit are no longer enabled automatically.
