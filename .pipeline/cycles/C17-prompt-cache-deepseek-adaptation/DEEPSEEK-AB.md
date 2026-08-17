# DeepSeek Anchored-Standard Paired A/B

## Conclusion

The post-implementation live probe verified both direct DeepSeek V4 models and
the real VSPi runtime path. All four paired trajectories created the requested
file and returned the exact three requested final strings. Anchored mode paid
one intentional bootstrap-to-promoted surface reset, then reached 98-100%
provider-reported recent Cache Hit Rate on turns 2 and 3.

The cost result is mixed in this small sample. Flash anchored cost 37.2% less
than control because it completed the tool task with fewer provider/tool
round-trips. Pro anchored cost 3.9% more than control because its first turn
generated more tokens. This experiment demonstrates activation, correctness,
promotion and warm-cache behavior; it does not establish a general quality or
cost advantage.

## Setup

- Date: 2026-08-17, Asia/Shanghai.
- Provider: direct `deepseek` using environment-managed authentication.
- Models: `deepseek-v4-flash` and `deepseek-v4-pro`.
- Runtime: built VSPi worktree, isolated temporary workspace, agent directory
  and in-memory interaction per trajectory.
- Policy: VSPi `Auto`; every file/process tool still passed through Policy,
  Approval evaluation and the root single-writer execution boundary.
- Reasoning effort: `low`.
- Modes: ordinary VSPi control (`deepSeekHarness: false`) and anchored-standard
  (`deepSeekHarness: true`). The option remains internal until S2 decides the
  release default.
- Workload: T1 creates and reads a model-specific file, T2 replies exactly
  `SECOND_PASS`, and T3 replies exactly `THIRD_PASS`.
- Cost: `officialCostCny` applies the fixed official DeepSeek high-peak schedule
  to provider-reported token categories. `providerBilledCny` remains unknown.

## Paired Results

| Model | Mode | T1 recent/session CH | T2 recent/session CH | T3 recent/session CH | Input | Cache read | Output | officialCostCny | Correct |
| --- | --- | ---: | ---: | ---: | ---: | ---: | ---: | ---: | --- |
| V4 Flash | control | 99% / 66% | 98% / 74% | 98% / 79% | 5,466 | 20,864 | 171 | ¥0.0100117 | yes |
| V4 Flash | anchored | 41% / 50% | 100% / 73% | 99% / 81% | 3,225 | 13,696 | 169 | ¥0.0062828 | yes |
| V4 Pro | control | 99% / 67% | 99% / 75% | 99% / 80% | 5,432 | 21,376 | 197 | ¥0.0303099 | yes |
| V4 Pro | anchored | 0% / 17% | 98% / 54% | 98% / 68% | 5,706 | 11,904 | 298 | ¥0.0314856 | yes |

Relative official CNY estimate across this three-turn trace:

- V4 Flash anchored versus control: -37.2%.
- V4 Pro anchored versus control: +3.9%.

The T1 rows aggregate multiple provider requests when the model uses tools.
Control used two successful tool calls in each model trajectory; anchored used
one in the paired workload. Therefore T1 cost is a trajectory outcome, not an
isolated measurement of prompt size.

## Exact Two-Tool Probe

A separate post-fix V4 Flash trajectory required `str_replace_editor` before
`bash`:

1. `str_replace_editor(create)` returned the official success string and wrote
   exact content `EDITOR_OK` inside the isolated workspace.
2. `bash` returned `EDITOR_OK`.
3. The assistant returned exact text `BOTH_OK`.

Both tool results had status `success`. Final telemetry was 3,155 input, 8,448
cache-read and 190 output tokens; recent CH was 99%, Session CH was 73%, and
the official CNY estimate was ¥0.0060099.

## Surface And Safety Evidence

- The fixed `pi-dsh-minimal v0.4.0@bdc2bec` persona and two schemas compare
  equal to the upstream runtime fixture.
- Bootstrap provider wire contains only `bash` and `str_replace_editor` in Chat
  Completions, Anthropic and named-parameters envelopes.
- The first assistant/tool signal promotes the epoch. The next request restores
  Pi/VSPi tools, prompt profile, AGENTS context and skills while replacing only
  the leading Pi identity with the official DeepSeek persona.
- Summary/branch-summary payloads are not rewritten. Compaction and model
  switch open a new bootstrap epoch.
- A post-fix process-level resume probe promoted a V4 Flash Session, disposed
  the runtime, reopened it with `continueRecent`, and successfully executed the
  full-surface-only `write` tool. The file contained exact text `RESUMED`,
  proving resume restored `promoted` instead of replaying bootstrap.
- `str_replace_editor` enforces absolute paths, workspace and symlink
  containment, and Policy/Approval before every operation.
- Bootstrap bash is dynamically installed only for the matching DeepSeek
  epoch. Promotion or model exit restores native Pi bash. Timeout defaults to
  120 seconds; timeout/abort kill and await the POSIX process group before the
  single-writer boundary is released.

## Limitations

- This is one stochastic trajectory per model/mode, not a benchmark or a
  statistical quality claim.
- Tool routing differed in T1, so the cost delta combines harness behavior and
  model tool choice.
- Provider caching, minimum thresholds and shared account cache state are not
  controlled. Provider-reported cache fields are observations, not guaranteed
  solely by deterministic prefix equality.
- `officialCostCny` is schedule-based accounting, not a reconciled provider
  invoice.
- Root `bash` follows the existing VSPi host policy: Policy/Approval and the
  single-writer boundary govern execution, while arbitrary shell commands are
  not an OS-level workspace filesystem sandbox. The editor has strict path
  containment. This behavior matches ordinary VSPi root bash and is not
  expanded to non-DeepSeek models.
- The current release candidate keeps the harness behind an internal option so
  S2 can choose default-enabled or a user-facing opt-in before M5.
