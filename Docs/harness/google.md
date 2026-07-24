# google Factory Extraction

Upstream source: https://github.com/google-gemini/gemini-cli

Pinned commit: `69b51f8fa2af0abf717daaba4dca1c627023d82d`

Applicable model family: `google` models.

Source location reviewed: agent prompt and tool-use guidance. The exact file layout remains upstream-owned and is rechecked by `harness:check` against the pinned commit.

Rewrite approach: adapt stable engineering behaviors into a short VSPi overlay. Do not copy a complete upstream system prompt; preserve attribution and re-check the repository license before redistribution.

