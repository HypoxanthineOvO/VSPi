# deepseek Factory Extraction

Upstream source: https://github.com/deepseek-ai/DeepSeek-V3

Pinned commit: `9b4e9788e4a3a731f7567338ed15d3ec549ce03b`

Applicable model family: `deepseek` models.

Source location reviewed: model usage and reasoning guidance. The exact file layout remains upstream-owned and is rechecked by `harness:check` against the pinned commit.

Rewrite approach: adapt stable engineering behaviors into a short VSPi overlay. Do not copy a complete upstream system prompt; preserve attribution and re-check the repository license before redistribution.

