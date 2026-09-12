# VSPi

VSPi is a daemon-backed terminal coding assistant. Sessions and background work live in the runtime; the terminal interface and non-interactive CLI connect over local IPC.

Requires **Node.js >=22.19.0**. This **2.3.0 Linux-first release** is validated on Linux. Windows remains on 2.2.4 until this release completes native verification; macOS has not been verified in this round.

## Install

Install the fixed Linux release:

```sh
npm install --global "https://github.com/HypoxanthineOvO/VSPi/releases/download/v2.3.0/vspi-2.3.0.tgz"
vspi --version
vspi init
vspi
```

Run `vspi init` in an interactive terminal to configure a Provider and default model — VSPLab is built in and points at `api.vsplab.tech` by default. Use `vspi continue` to resume the latest workspace session, `vspi resume` to choose one, and `vspi exec --help` for scripting.

## Update

2.3.0 uses the normal shared release channel, but this round is verified only on Linux. Windows users should stay on the fixed 2.2.4 release and avoid updating until native verification. To upgrade from 2.2.x, finish tasks, close clients, run `vspi daemon stop`, and install the fixed 2.3.0 URL above. Existing users must not run `init` again. For later updates:

```sh
vspi update
```

Run `vspi update` outside the TUI, after finishing work and closing attached clients. It downloads the versioned GitHub asset, verifies SHA-256, saves a rollback package, and safely switches an idle runtime. It refuses to overwrite an installation while that runtime is in use. A failed update attempts to restore the previous package without overwriting changed configuration.

For the first upgrade from 2.2.x, finish tasks and explicitly stop the old daemon before installing. Preserve your existing home and package manager; do not delete configuration or run init again. A legacy Windows instance without graceful shutdown support requires explicit `vspi daemon stop --force-legacy` only after all tasks have finished. New daemons use authenticated shutdown with cleanup confirmation and immutable executable snapshots.

Unsafe TTY hot handoff is disabled: `/reload` explains how to exit and run `vspi continue`. `/history` loads older durable messages; `/history latest` returns to recent history. Large display records and recent-task caches are bounded without deleting persisted history.

Configuration defaults to `~/.vspi/config.toml`; `VSPI_HOME` isolates configuration, sessions, and the daemon. Never commit credentials.

`/quit` detaches the frontend without cancelling work; `/cancel-and-exit` cancels the current run and exits.

See the [project guide](https://github.com/HypoxanthineOvO/VSPi#readme) for features, configuration, release notes, and source development requirements.
