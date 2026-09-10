# VSPi

VSPi is a daemon-backed terminal coding assistant. Sessions and background work live in the runtime; the terminal interface and non-interactive CLI connect over local IPC.

Requires **Node.js >=22.19.0**. Linux, macOS, and Windows are supported (npm creates a `vspi.cmd` shim on Windows; the daemon speaks named-pipe IPC there).

## Install

```sh
npm install --global "https://github.com/HypoxanthineOvO/VSPi/releases/download/v2.2.4/vspi-2.2.4.tgz"
vspi --version
vspi init
vspi
```

Run `vspi init` in an interactive terminal to configure a Provider and default model — VSPLab is built in and points at `api.vsplab.tech` by default. Use `vspi continue` to resume the latest workspace session, `vspi resume` to choose one, and `vspi exec --help` for scripting.

## Update

```sh
vspi update
```

`vspi update` downloads `vspi-latest.tgz` from the GitHub release, verifies its SHA-256 checksum, and installs it through npm or Volta. Restart the client afterwards; a running daemon keeps serving until you explicitly stop it (`vspi daemon stop`) once its tasks are finished. To pin or downgrade, re-run the install command for that version.

Configuration defaults to `~/.vspi/config.toml`; `VSPI_HOME` isolates configuration, sessions, and the daemon. Never commit credentials.

`/quit` detaches the frontend without cancelling work; `/cancel-and-exit` cancels the current run and exits.

See the [project guide](https://github.com/HypoxanthineOvO/VSPi#readme) for features, configuration, release notes, and source development requirements.
