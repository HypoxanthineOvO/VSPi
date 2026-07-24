# moonshot Factory Extraction

Upstream source: https://github.com/MoonshotAI/kimi-cli

Pinned commit: `4a550effdfcb29a25a5d325bf935296cc50cd417`

Applicable model family: `moonshot` models.

Source location reviewed: agent system prompt and workflow guidance. The exact file layout remains upstream-owned and is rechecked by `harness:check` against the pinned commit.

Rewrite approach: adapt stable engineering behaviors into a short VSPi overlay. Do not copy a complete upstream system prompt; preserve attribution and re-check the repository license before redistribution.

