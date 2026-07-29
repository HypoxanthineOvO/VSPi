---
authority_role: record
confidence: confirmed
created_at: 2026-07-29T16:00:00.000+08:00
dedupe_key: decision.vspi.pty-debug-playbook
id: decision-fef54ead775588f8899dba4b09dd65fd
kind: decision
schema_version: '1'
scope:
  ref: VSPi
  type: project
secret_refs: []
semantic_hash: fef54ead775588f8899dba4b09dd65fd5dc8949ea37eaf0730ba51a9c3a76068
source_refs:
  - locator: 2026-07-29-testing-debugging-maintain
    ref: current-chat
    type: session
  - locator: repository-debug-playbook
    ref: Docs/testing-and-debugging.md
    type: file
supersedes: []
updated_at: 2026-07-29T16:00:00.000+08:00
---
# PTY and debug playbook

Use the shared node-pty plus headless-xterm PtyHarness for terminal semantics, including native scrollback, cursor and viewport position, resize, completion layout, Resume, Plan refresh, compaction continuation, and Execution Policy restoration. waitFor searches all scrollback and is never sufficient proof of current-screen placement; after output settles, assert screenText together with baseY, viewportY, cursorX, and cursorY. Use unique sentinels, isolated HOME/config/session directories, normal/short/narrow/tall terminal sizes, and close every harness in finally.

Localize faults by checking, in order, the resolved executable and running process, persisted Session/config state, backend restore directories, App state, rendered row budget, and physical PTY/xterm buffer. Distinguish src/index.ts, dist/index.js, local links, and package-manager caches even when version strings match. Construct late stale Plan responses and consecutive compactions explicitly; verify both persistence write and restore read paths, and make all SessionManager operations use the same explicit sessionDir.
