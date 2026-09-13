# VSPi

VSPi is a daemon-backed terminal coding assistant. Sessions and background work live in the runtime; the terminal interface and non-interactive CLI connect over local IPC.

Requires **Node.js >=22.19.0**. This **2.4.1 Linux-first release** targets Linux. Windows remains on 2.2.4 until this release completes native verification; macOS has not been verified in this round.

## Install

Install the fixed Linux release:

```sh
npm install --global "https://github.com/HypoxanthineOvO/VSPi/releases/download/v2.4.1/vspi-2.4.1.tgz"
vspi --version
vspi init
vspi
```

Run `vspi init` in an interactive terminal to configure a Provider and default model — VSPLab is built in and points at `api.vsplab.tech` by default. Use `vspi continue` to resume the latest workspace session, `vspi resume` to choose one, and `vspi exec --help` for scripting.

## Update

2.4.0 enables `/feedback <description>` and `vspi feedback --help` by default: export a bounded, redacted package, review it, and explicitly confirm before upload. Export and preview work without credentials. Online submission requires a per-user `feedback.json` supplied privately by the administrator, stored in `VSPI_HOME` (normally `~/.vspi`) with mode 0600 on POSIX. These credentials are independent of model API keys; they are not included in the package. Without credentials, keep the exported package and share it manually only after review. The receiver and administrator tools are separate build artifacts, not automatically started by the client.

Signed dual-entry distribution remains experimental and is not the default release channel. Set `KIMI_CODE_EXPERIMENTAL_VSPI_DISTRIBUTION=true` only after the administrator completes mirror provisioning and supplies an independently verified `distribution.json` public-key file in `VSPI_HOME`. Updates then prefer the trusted internal entry and fall back to the public relay, verify signed manifests and package hashes, and retain the existing installation rollback. Normal installations and updates continue to use GitHub.

2.4.1 uses the normal shared release channel. Windows users should stay on the fixed 2.2.4 release and avoid updating until native verification. For the first upgrade from 2.3.0/2.4.0, exit old interfaces with `/quit` before `vspi daemon stop` and the update command below: those old interfaces may otherwise restart the stopped daemon. From 2.2.x, finish tasks, close clients, stop the old daemon and install the fixed URL above. Existing users must not run `init` again.

```sh
vspi update
```

Run `vspi update` outside the TUI. Starting with 2.4.1, idle attached clients no longer block updates; active work requires explicit terminal confirmation (default No), and non-interactive updates will not terminate it. Updates verify SHA-256 and keep rollback packages. An intentional stop/update does not trigger automatic daemon respawn by the old interface. With no clients or unfinished turns, tasks, active goals or scheduled work, the daemon exits after a five-second grace period; set `VSPI_DAEMON_IDLE_TIMEOUT_MS=0` to explicitly keep it resident. History and configuration stay on disk. A failed update attempts to restore the previous package without overwriting changed configuration.

For the first upgrade from 2.2.x, finish tasks and explicitly stop the old daemon before installing. Preserve your existing home and package manager; do not delete configuration or run init again. A legacy Windows instance without graceful shutdown support requires explicit `vspi daemon stop --force-legacy` only after all tasks have finished. New daemons use authenticated shutdown with cleanup confirmation and immutable executable snapshots.

Unsafe TTY hot handoff is disabled: `/reload` explains how to exit and run `vspi continue`. `/history` loads older durable messages; `/history latest` returns to recent history. Large display records and recent-task caches are bounded without deleting persisted history.

Configuration defaults to `~/.vspi/config.toml`; `VSPI_HOME` isolates configuration, sessions, and the daemon. Never commit credentials.

`/quit` detaches the frontend without cancelling work; `/cancel-and-exit` cancels the current run and exits.

See the [project guide](https://github.com/HypoxanthineOvO/VSPi#readme) for features, configuration, release notes, and source development requirements.
