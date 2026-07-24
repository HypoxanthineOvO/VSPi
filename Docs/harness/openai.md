# openai Factory Extraction

Upstream source: https://github.com/openai/codex

Pinned commit: `81da9deb065d7adb283816b19b40f89bcc484276`

Applicable model family: `openai` models.

Source location reviewed: agent system prompt and engineering guidelines. The exact file layout remains upstream-owned and is rechecked by `harness:check` against the pinned commit.

Rewrite approach: adapt stable engineering behaviors into a short VSPi overlay. Do not copy a complete upstream system prompt; preserve attribution and re-check the repository license before redistribution.

