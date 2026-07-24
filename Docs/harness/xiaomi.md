# xiaomi Factory Extraction

Upstream source: https://github.com/XiaomiMiMo/MiMo-V2-Flash

Pinned commit: `b4eaae40d3728657ff7f0f9397dcce3c9ab3d3b7`

Applicable model family: `xiaomi` models.

Source location reviewed: model usage guidance. The exact file layout remains upstream-owned and is rechecked by `harness:check` against the pinned commit.

Rewrite approach: adapt stable engineering behaviors into a short VSPi overlay. Do not copy a complete upstream system prompt; preserve attribution and re-check the repository license before redistribution.

