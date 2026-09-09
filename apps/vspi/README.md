# VSPi

VSPi is a daemon-backed terminal coding assistant. Sessions and background work live in the runtime; the interactive terminal and non-interactive CLI connect to it over local IPC.

## Install and start

Requires **Node.js >=22.19.0**. Use a recent patch release of Node.js 22 or 24.

```sh
npm install --global "https://github.com/HypoxanthineOvO/VSPi/releases/download/v2.2.2/vspi-2.2.2.tgz"
vspi --version
vspi init
vspi
```

`vspi init` opens interactive Provider and model setup. Existing users can start with `vspi`, resume the latest workspace session with `vspi continue`, or choose a session with `vspi resume`.

- `/agents` shows Subagent activity and conversations; `/tasks` shows background jobs, processes, and questions.
- `/quit` detaches the frontend; `/cancel-and-exit` cancels active work before exiting.
- `vspi exec --help` documents non-interactive execution and text/JSON/JSONL output.
- `vspi config path` prints the configuration path; `vspi config reload` reloads runtime configuration.
- `vspi inspect paths` and `vspi daemon status` help diagnose the runtime. Do not stop a daemon with active work merely to inspect it.

Configuration defaults to `~/.vspi/config.toml`. Set `VSPI_HOME` to isolate configuration, sessions, and the runtime. Configure credentials interactively; do not commit API keys or publish unredacted diagnostics.

## Updates and recovery

Run `vspi update`, then restart the client. An incompatible daemon is not silently replaced: finish its work before explicitly stopping it, or use an isolated `VSPI_HOME` for a different build.

Version 2.2.1 bounds large-directory previews and listings, avoids whole-workspace enumeration for known configuration watch targets, improves IPC session recovery, and keeps short regular-mode input surfaces near the bottom. Recovery does **not** replay interrupted prompts or tool calls automatically.

Version 2.2.2 synchronizes displayed permissions with the daemon and preserves existing session permissions across rebinds and reconnects. Safe and Standard both map to the backend's manual mode; restored manual mode is displayed as Standard. Plan restrictions and explicit deny rules remain enforced. Nested `vspi` commands use the daemon's Node and executable, with its home as the default unless explicitly overridden.

`vspi web` prints the local runtime address; this package does not include a standalone browser frontend.

See the [full project guide](https://github.com/HypoxanthineOvO/VSPi#readme) for workflows, validation scope, and development instructions. Building the monorepo still requires Node.js >=24.15.0 and pnpm 10.33.0.
