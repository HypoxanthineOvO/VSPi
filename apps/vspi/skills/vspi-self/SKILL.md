---
name: vspi-self
description: Inspect, configure, or diagnose VSPi itself, including the main model, subagent models and profiles, runtime paths, logs, and the current session files. Use whenever the user asks VSPi to change its own setup or locate one of its sessions.
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

Normally VSPi home is `$VSPI_HOME` when set, otherwise `~/.vspi`, but the resolved paths above remain correct for a daemon started with a custom home. `vspi config path` is the non-interactive CLI shortcut for the config path of the runtime selected by the current shell.

The current session's main transcript is `agents/main/wire.jsonl`; durable state is `state.json`; subagent transcripts live at `agents/<agent-id>/wire.jsonl`. Treat these as diagnostic data. Do not modify session records unless the user explicitly asks for a repair and the affected session is not running.

## Read or change runtime configuration

Prefer the non-interactive CLI because Core validates the section and writes `config.toml` atomically:

```bash
VSPI_HOME="$vspi_home" vspi config get defaultModel
VSPI_HOME="$vspi_home" vspi config set defaultModel '"provider/model"'
VSPI_HOME="$vspi_home" vspi config get secondaryModel
VSPI_HOME="$vspi_home" vspi config set secondaryModel '{"defaultModel":"provider/model","models":{"provider/model":"default subagent model"}}'
VSPI_HOME="$vspi_home" vspi config reload
```

The CLI uses Core section names in camelCase. The corresponding TOML keys are snake_case:

- `defaultModel` -> top-level `default_model`, the main model alias.
- `secondaryModel` -> `[secondary_model]`, the subagent model policy.
- `subagent` -> `[subagent]`; this section only controls `timeout_ms`, not the subagent model pool.
- `models` -> `[models."provider/model"]`, model declarations.
- `providers` -> `[providers.<id>]`, provider declarations and credentials.

For `[secondary_model.models]`, every table key is a configured model alias, `default_model` must name one of those keys, and `primary` is reserved for the calling agent's model. With `force = true`, set `default_model` and do not set a `models` table. VSPi enables the `secondary-model` feature by default.

Before `config set`, always run `config get` for that section and preserve unrelated fields. The JSON argument replaces the complete section. Prefix model-run CLI calls with `VSPI_HOME="$vspi_home"` as above so a custom-home session cannot connect to the default daemon by mistake. Never put API keys directly in a command line because shell history and process listings may expose them; use `vspi config` or `vspi login <provider>` in an interactive terminal for credentials.

If direct TOML editing is specifically required, read the existing file first, keep a timestamped backup, edit a candidate copy, and use `vspi config reload` after replacement. If reload fails, restore the backup. Never overwrite invalid TOML from scratch or drop unrelated sections.

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
vspi daemon status
vspi daemon logs
vspi config reload
```

Read the runtime log and current session files only as needed. Redact tokens, API keys, authorization headers, and private prompt content from anything shown to the user. Do not stop or restart the daemon while other sessions are active unless the user explicitly approves the disruption.
