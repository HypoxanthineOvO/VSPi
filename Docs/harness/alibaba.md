# alibaba Factory Extraction

Upstream source: https://github.com/QwenLM/qwen-code

Pinned commit: `2a97c55ac8d42c9673690dea8ebf1ad7a1aebcec`

Applicable model family: `alibaba` models.

Source location reviewed: agent system prompt and engineering guidelines. The exact file layout remains upstream-owned and is rechecked by `harness:check` against the pinned commit.

Rewrite approach: adapt stable engineering behaviors into a short VSPi overlay. Do not copy a complete upstream system prompt; preserve attribution and re-check the repository license before redistribution.

