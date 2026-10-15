# VSPi Desktop

- `src/main` owns SSH processes, authentication, Klient connections, and runtime tokens. The renderer receives only the operations declared in `src/shared.ts` through the isolated preload.
- `src/renderer` owns the React UI. The terminal remains in the right panel; hiding a tab must not destroy its PTY. Closing Desktop must release connections without cancelling Agent tasks.
- Keep credentials out of renderer reads, localStorage, logs, and error payloads. Provider edits use the remote revision-aware settings service.
- Remote HTML/SVG are data, never privileged documents. Keep context isolation, renderer sandboxing, CSP, and IPC sender validation enabled.
- The development entrypoint is opt-in through `KIMI_CODE_EXPERIMENTAL_DESKTOP=1`. Linux is the current validation platform; record additional platform checks before declaring support.
- Use `pnpm --filter @vsp/vspi-desktop build`, `typecheck`, and `test`. Keep interactive test fixtures under `.tmp/`; use isolated runtime homes and SSH servers for lifecycle tests.
- Follow Hypo-Expression's web UI rules for visible copy: keep normal states quiet, place instructions in contextual help, and avoid repeated actions or implementation labels.
