# VSPi

VSPi is a daemon-backed terminal coding assistant. Sessions and background work live in the runtime; the terminal interface and non-interactive CLI connect over local IPC.

Requires **Node.js >=22.19.0**.

```sh
npm install --global "https://github.com/HypoxanthineOvO/VSPi/releases/download/v2.2.3/vspi-2.2.3.tgz"
vspi init
vspi
```

Run `vspi init` in an interactive terminal to configure a Provider and default model. Use `vspi continue` to resume the latest workspace session, `vspi resume` to choose one, and `vspi exec --help` for scripting.

Configuration defaults to `~/.vspi/config.toml`; `VSPI_HOME` isolates configuration, sessions, and the daemon. Never commit credentials.

`/quit` detaches the frontend without cancelling work. Use `vspi update` to upgrade, then restart the client; finish active tasks before explicitly stopping an incompatible daemon.

See the [project guide](https://github.com/HypoxanthineOvO/VSPi#readme) for features, configuration, release notes, and source development requirements.
