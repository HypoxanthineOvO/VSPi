# VSPi Agent Guide

VSPi is a separate product from Kimi Code. Treat `apps/vspi/src/v1` as the source of truth for its TUI, slash commands, transcript, panels, status footer, and Klient-backed behavior. Do not diagnose or fix a VSPi UI report in `apps/kimi-code` unless code evidence proves the defect is in a shared package.

## Map

- `src/main.ts`, `src/daemon`: process startup, daemon discovery, compatibility, and lifecycle.
- `src/v1/app`: TUI coordination, input handling, session lifecycle, and command dispatch.
- `src/v1/backend`: Klient event and service projection into the VSPi frontend contract.
- `src/v1/ui`: transcript, panels, composer, layout, status, and themes.
- `src/v1/domain/commands.ts`: the complete VSPi slash-command registry and aliases.
- `test`: focused VSPi frontend and backend projection tests.

## Constraints

- Preserve chronological transcript order. Updating a tool or task must update its existing node rather than move it to the tail.
- Busy-input behavior must distinguish a non-empty composer from an empty one: user text must not be discarded by an interrupt action.
- `/agents` is the Subagent browser with one read-only chronological child process stream; its wide-list preview and detail view share the same commentary/tool/final projection and never render thinking. `/tasks` is a separate grouped background-work dashboard for Agent jobs, processes, and questions; Agent rows in `/tasks` never expose child conversation.
- Live Subagent state belongs in the docked Agents surface and `/agents`, never in chronological transcript child cards.
- Model context, price, usage, and cache labels must state one coherent metric and provenance. Do not present cumulative counters as current context.
- Keep daemon/client compatibility explicit. A client must not silently attach to a daemon running a different build or unsupported Node version.
