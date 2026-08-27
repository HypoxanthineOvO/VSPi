---
name: vspi-subagent
description: Use a running VSPi session as a non-owning subagent from another coding agent. Applies when an external agent needs to inspect, message, wait for, or watch live VSPi work without taking over its terminal or session lease.
---

# VSPi Subagent

Use `vspi control` as the transport to an already-running VSPi session. The channel does not own the Session: never start `vspi exec resume`, request handoff, manipulate lease files, or read private descriptor/token files.

## Transport Contract

- `vspi control status [session]`: read liveness, busy state, queue and model identity.
- `vspi control snapshot [session]`: read the current Agent and Cron projection.
- `vspi control send [session] --idempotency-key <key> "<prompt>"`: submit one prompt. Reuse a key only to retry the exact same payload.
- `vspi control wait [session] [timeout-ms]`: wait until the foreground generation and native queues are idle. A timeout does not cancel work.
- `vspi control watch [session] [after-sequence]`: consume JSONL events. Persist the last sequence and pass it when reconnecting.

The selector defaults to `latest`; use a unique Session fragment or full path when multiple VSPi sessions are running. Treat stdout as JSON protocol output and surface stderr failures. The foreground VSPi process must remain running.
