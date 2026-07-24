# anthropic Factory Extraction

Upstream source: https://github.com/anthropics/claude-code

Pinned commit: `2982f951552e94f38cd972764ae94c1d90c41da3`

Applicable model family: `anthropic` models.

Source location reviewed: official CLI agent guidance. The exact file layout remains upstream-owned and is rechecked by `harness:check` against the pinned commit.

Rewrite approach: adapt stable engineering behaviors into a short VSPi overlay. Do not copy a complete upstream system prompt; preserve attribution and re-check the repository license before redistribution.

