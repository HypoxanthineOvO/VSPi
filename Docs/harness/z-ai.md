# z-ai Factory Extraction

Upstream source: https://github.com/zai-org/GLM-4.5

Pinned commit: `170f20b2c10659008fdbc909d478bc2a75bc3627`

Applicable model family: `z-ai` models.

Source location reviewed: model usage guidance. The exact file layout remains upstream-owned and is rechecked by `harness:check` against the pinned commit.

Rewrite approach: adapt stable engineering behaviors into a short VSPi overlay. Do not copy a complete upstream system prompt; preserve attribution and re-check the repository license before redistribution.

