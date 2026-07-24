# Prompt Harness Sources

VSPi Factory profiles are short overlays, not copied upstream system prompts. `sources.json` records the official source class, pinned review reference, license policy, applicable family, extraction area, rewrite rationale, evaluation state, and review date for every supported family.

`npm run harness:check` validates this manifest and prints a read-only review report. It does not update the manifest, download prompts, write user profiles, or make provider requests. A `not-run` evaluation status is informational and never disables a Factory profile.

