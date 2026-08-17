---
kind: cache-simulation
cycle: C17-prompt-cache-deepseek-adaptation
generated: 2026-08-17
currency: CNY
turns_per_scenario: 6
---

# Prompt Cache Before/After 确定性模拟

## 结论

把每轮变化的 Plan、Goal、Workflow 与 review capsule 从 system prompt 移到按需 `continuity_status` 结果后，T3 状态变化与 T5 review 边界不再破坏早期 request prefix。六轮 All-turn CH 因包含一次冷启动，理论上限约为 5/6 = 83.33%；排除冷启动后，长与超长场景的 Warm-turn CH 为 99.61%，与 DSH 常见的 warm/latest `99%+` 表述处于同一量级。

## 方法与边界

- 每档固定 6 turn；T1 为冷启动，T3 改变 Plan/Workflow，T5 进入 review，其余为普通追加。
- Before 的动态 capsule 位于稳定 system 前缀之后；T3/T5 最长公共前缀退回 2,048 tokens。After 的 system prompt 与 tools 不变，`continuity_status` 结果只追加到历史尾部，因此从 T2 起可复用上一请求的完整 prompt。
- Before/After 使用完全相同的 prompt token 和 output trace。`cacheWrite` 固定为 0，因为这是 request-prefix counterfactual，不伪造 Provider 是否执行显式 cache write。
- Cache Hit Rate 使用 Pi 口径 `cacheRead / (input + cacheRead + cacheWrite)`；本 fixture 中 `promptTokens = cacheRead + uncached`。
- `All-turn CH` 包含 T1 冷启动，表示整个固定 workload 的计费结果；`Warm-turn CH` 统计 T2-T6，表示预热后架构表现；`Latest-turn CH` 取稳定的 T6，用于和 recent/latest 指标比较。
- bootstrap、promotion、model switch 与 compaction 会开启新 cache epoch；跨 epoch 的首请求应作为新的 cold start 单列，不能混入 warm `99%+`。
- 重复计费 token 只计 `min(previousPrompt, currentPrompt) - cacheRead`，不把首轮冷启动或新追加尾部算作优化损失。
- 费用按 `PRICE_SCHEDULES` 的人民币/百万 token 逐 bucket 计算；`officialCny` 与 `catalogEstimateCny` 严格分开。输出费用两侧相同，但保留在总价中。

## Provider-reported 实测

当前 M1 baseline 来自 235 个有效 assistant 响应：input 592,794、cache read 26,346,304、output 150,605，Session CH 97.7995%，最近 CH 99.3684%，6 次 miss 导致 349,929 个重复计费 token。Provider cost breakdown 为 0，因此 `providerBilledCny` 仍为 unknown。该实测不与下方 counterfactual 合并。

## 与 DSH `99%+` 的可比口径

DSH 的具体数字只有在相同 trace、相同 cache epoch 和相同 Provider-reported 口径下才能做严格 A/B。下表不把 DSH 的宣传数字伪装成实测；它展示 VSPi 模拟在 All-turn、Warm-turn 与 Latest-turn 三种口径下为何分别约为 83% 和 99%+。

| 场景 | Before All-turn | After All-turn | Before Warm-turn | After Warm-turn | After Latest-turn |
| --- | ---: | ---: | ---: | ---: | ---: |
| 短约 4K | 64.73% | 82.13% | 76.57% | 97.14% | 97.30% |
| 中约 32K | 51.63% | 82.71% | 61.49% | 98.51% | 98.55% |
| 长约 256K | 50.16% | 83.17% | 60.08% | 99.61% | 99.62% |
| 超长约 512K | 50.03% | 83.17% | 59.92% | 99.61% | 99.62% |

## 逐 Turn 请求结构

### 短约 4K

| Turn | 事件 | Prompt | Before 前缀 | Before cached / uncached / write | After 前缀 | After cached / uncached / write | Output |
| ---: | --- | ---: | ---: | ---: | ---: | ---: | ---: |
| T1 | cold-start | 4,096 | 0 | 0 / 4,096 / 0 | 0 | 0 / 4,096 / 0 | 512 |
| T2 | ordinary | 4,224 | 4,096 | 4,096 / 128 / 0 | 4,096 | 4,096 / 128 / 0 | 512 |
| T3 | state-change | 4,352 | 2,048 | 2,048 / 2,304 / 0 | 4,224 | 4,224 / 128 / 0 | 512 |
| T4 | ordinary | 4,480 | 4,352 | 4,352 / 128 / 0 | 4,352 | 4,352 / 128 / 0 | 512 |
| T5 | review-boundary | 4,608 | 2,048 | 2,048 / 2,560 / 0 | 4,480 | 4,480 / 128 / 0 | 512 |
| T6 | ordinary | 4,736 | 4,608 | 4,608 / 128 / 0 | 4,608 | 4,608 / 128 / 0 | 512 |

汇总：All-turn CH 64.73% → 82.13%（+17.39 pp）；Warm-turn CH 76.57% → 97.14%；After Latest-turn CH 97.30%；重复计费 4,608 → 0 tokens。

### 中约 32K

| Turn | 事件 | Prompt | Before 前缀 | Before cached / uncached / write | After 前缀 | After cached / uncached / write | Output |
| ---: | --- | ---: | ---: | ---: | ---: | ---: | ---: |
| T1 | cold-start | 32,768 | 0 | 0 / 32,768 / 0 | 0 | 0 / 32,768 / 0 | 512 |
| T2 | ordinary | 33,280 | 32,768 | 32,768 / 512 / 0 | 32,768 | 32,768 / 512 / 0 | 512 |
| T3 | state-change | 33,792 | 2,048 | 2,048 / 31,744 / 0 | 33,280 | 33,280 / 512 / 0 | 512 |
| T4 | ordinary | 34,304 | 33,792 | 33,792 / 512 / 0 | 33,792 | 33,792 / 512 / 0 | 512 |
| T5 | review-boundary | 34,816 | 2,048 | 2,048 / 32,768 / 0 | 34,304 | 34,304 / 512 / 0 | 512 |
| T6 | ordinary | 35,328 | 34,816 | 34,816 / 512 / 0 | 34,816 | 34,816 / 512 / 0 | 512 |

汇总：All-turn CH 51.63% → 82.71%（+31.08 pp）；Warm-turn CH 61.49% → 98.51%；After Latest-turn CH 98.55%；重复计费 63,488 → 0 tokens。

### 长约 256K

| Turn | 事件 | Prompt | Before 前缀 | Before cached / uncached / write | After 前缀 | After cached / uncached / write | Output |
| ---: | --- | ---: | ---: | ---: | ---: | ---: | ---: |
| T1 | cold-start | 262,144 | 0 | 0 / 262,144 / 0 | 0 | 0 / 262,144 / 0 | 512 |
| T2 | ordinary | 263,168 | 262,144 | 262,144 / 1,024 / 0 | 262,144 | 262,144 / 1,024 / 0 | 512 |
| T3 | state-change | 264,192 | 2,048 | 2,048 / 262,144 / 0 | 263,168 | 263,168 / 1,024 / 0 | 512 |
| T4 | ordinary | 265,216 | 264,192 | 264,192 / 1,024 / 0 | 264,192 | 264,192 / 1,024 / 0 | 512 |
| T5 | review-boundary | 266,240 | 2,048 | 2,048 / 264,192 / 0 | 265,216 | 265,216 / 1,024 / 0 | 512 |
| T6 | ordinary | 267,264 | 266,240 | 266,240 / 1,024 / 0 | 266,240 | 266,240 / 1,024 / 0 | 512 |

汇总：All-turn CH 50.16% → 83.17%（+33.01 pp）；Warm-turn CH 60.08% → 99.61%；After Latest-turn CH 99.62%；重复计费 524,288 → 0 tokens。

### 超长约 512K

| Turn | 事件 | Prompt | Before 前缀 | Before cached / uncached / write | After 前缀 | After cached / uncached / write | Output |
| ---: | --- | ---: | ---: | ---: | ---: | ---: | ---: |
| T1 | cold-start | 524,288 | 0 | 0 / 524,288 / 0 | 0 | 0 / 524,288 / 0 | 512 |
| T2 | ordinary | 526,336 | 524,288 | 524,288 / 2,048 / 0 | 524,288 | 524,288 / 2,048 / 0 | 512 |
| T3 | state-change | 528,384 | 2,048 | 2,048 / 526,336 / 0 | 526,336 | 526,336 / 2,048 / 0 | 512 |
| T4 | ordinary | 530,432 | 528,384 | 528,384 / 2,048 / 0 | 528,384 | 528,384 / 2,048 / 0 | 512 |
| T5 | review-boundary | 532,480 | 2,048 | 2,048 / 530,432 / 0 | 530,432 | 530,432 / 2,048 / 0 | 512 |
| T6 | ordinary | 534,528 | 532,480 | 532,480 / 2,048 / 0 | 532,480 | 532,480 / 2,048 / 0 | 512 |

汇总：All-turn CH 50.03% → 83.17%（+33.14 pp）；Warm-turn CH 59.92% → 99.61%；After Latest-turn CH 99.62%；重复计费 1,052,672 → 0 tokens。

## Price schedules 与来源

单价单位为人民币元/百万 tokens。DeepSeek 新价高峰为北京时间 09:00-12:00、14:00-18:00；其余时段为空闲。`catalogEstimateCny` 不是 Provider 实际账单价。

| Provider / Model | Provenance | 生效时间 | cached / uncached / write / output | Context | 来源（版本） |
| --- | --- | --- | ---: | ---: | --- |
| DeepSeek / V4 Flash | officialCny | 2026-04-24T00:00:00+08:00 | 0.2 / 1 / 1 / 2 | 1,048,576 | DeepSeek official V4 preview announcement image v4-price.png (2026-04-24) |
| DeepSeek / V4 Pro | officialCny | 2026-04-24T00:00:00+08:00 | 1 / 12 / 12 / 24 | 1,048,576 | DeepSeek official V4 preview announcement image v4-price.png (2026-04-24) |
| DeepSeek / V4 Flash (idle) | officialCny | 2026-08-17T00:00:00+08:00 | 0.05 / 1.5 / 1.5 / 4.5 | 1,048,576 | DeepSeek official V4 260813 Chinese pricing announcement (2026-08-13) |
| DeepSeek / V4 Flash (peak) | officialCny | 2026-08-17T00:00:00+08:00 | 0.1 / 3 / 3 / 9 | 1,048,576 | DeepSeek official V4 260813 Chinese pricing announcement (2026-08-13) |
| DeepSeek / V4 Pro (idle) | officialCny | 2026-08-17T00:00:00+08:00 | 0.15 / 4.5 / 4.5 / 13.5 | 1,048,576 | DeepSeek official V4 260813 Chinese pricing announcement (2026-08-13) |
| DeepSeek / V4 Pro (peak) | officialCny | 2026-08-17T00:00:00+08:00 | 0.3 / 9 / 9 / 27 | 1,048,576 | DeepSeek official V4 260813 Chinese pricing announcement (2026-08-13) |
| Kimi / K3 | officialCny | 2026-08-17T00:00:00+08:00 | 2 / 20 / 20 / 100 | 1,048,576 | Kimi official pricing page (2026-08-17 snapshot) |
| OpenCode Go / GLM 5.2 | catalogEstimateCny | 2026-08-17T00:00:00+08:00 | 1.768 / 9.52 / 9.52 / 29.92 | 1,048,576 | OpenCode Go models.dev USD catalog converted at USD/CNY 6.80 (sst/models.dev@de7194b4ec) |
| VSPLab catalog / GPT-5.6 Luna | catalogEstimateCny | 2026-08-17T00:00:00+08:00 | 0.136 / 1.36 / 1.7 / 8.16 | 272,000 | Pi 0.84.2 openai-codex USD catalog converted at USD/CNY 6.80 (0.84.2 / 2026-08-17 snapshot) |
| VSPLab catalog / GPT-5.6 Sol | catalogEstimateCny | 2026-08-17T00:00:00+08:00 | 3.4 / 34 / 42.5 / 204 | 272,000 | Pi 0.84.2 openai-codex USD catalog converted at USD/CNY 6.80 (0.84.2 / 2026-08-17 snapshot) |

## 逐模型人民币费用

费用包含相同的 output；节省仅来自 T3/T5 避免把历史前缀重新按 uncached 计费。Luna/Sol 的 272K context 无法容纳约 512K fixture，明确标为 N/A。

| 价格档（来源） | 场景 | Before | After | 节省 | 节省比例 |
| --- | --- | ---: | ---: | ---: | ---: |
| deepseek-v4-flash-old (officialCny) | 短约 4K | ¥0.0189 | ¥0.0152 | ¥0.0037 | 19.49% |
| deepseek-v4-flash-old (officialCny) | 中约 32K | ¥0.1261 | ¥0.0753 | ¥0.0508 | 40.29% |
| deepseek-v4-flash-old (officialCny) | 长约 256K | ¥0.9570 | ¥0.5376 | ¥0.4194 | 43.83% |
| deepseek-v4-flash-old (officialCny) | 超长约 512K | ¥1.9112 | ¥1.0691 | ¥0.8421 | 44.06% |
| deepseek-v4-pro-old (officialCny) | 短约 4K | ¥0.2030 | ¥0.1523 | ¥0.0507 | 24.97% |
| deepseek-v4-pro-old (officialCny) | 中约 32K | ¥1.3650 | ¥0.6666 | ¥0.6984 | 51.16% |
| deepseek-v4-pro-old (officialCny) | 长约 256K | ¥10.3690 | ¥4.6019 | ¥5.7672 | 55.62% |
| deepseek-v4-pro-old (officialCny) | 超长约 512K | ¥20.7094 | ¥9.1300 | ¥11.5794 | 55.91% |
| deepseek-v4-flash-idle (officialCny) | 短约 4K | ¥0.0287 | ¥0.0220 | ¥0.0067 | 23.28% |
| deepseek-v4-flash-idle (officialCny) | 中约 32K | ¥0.1673 | ¥0.0753 | ¥0.0921 | 55.02% |
| deepseek-v4-flash-idle (officialCny) | 长约 256K | ¥1.2410 | ¥0.4808 | ¥0.7602 | 61.26% |
| deepseek-v4-flash-idle (officialCny) | 超长约 512K | ¥2.4741 | ¥0.9477 | ¥1.5264 | 61.69% |
| deepseek-v4-flash-peak (officialCny) | 短约 4K | ¥0.0574 | ¥0.0440 | ¥0.0134 | 23.28% |
| deepseek-v4-flash-peak (officialCny) | 中约 32K | ¥0.3346 | ¥0.1505 | ¥0.1841 | 55.02% |
| deepseek-v4-flash-peak (officialCny) | 长约 256K | ¥2.4820 | ¥0.9615 | ¥1.5204 | 61.26% |
| deepseek-v4-flash-peak (officialCny) | 超长约 512K | ¥4.9482 | ¥1.8954 | ¥3.0527 | 61.69% |
| deepseek-v4-pro-idle (officialCny) | 短约 4K | ¥0.0861 | ¥0.0660 | ¥0.0200 | 23.28% |
| deepseek-v4-pro-idle (officialCny) | 中约 32K | ¥0.5020 | ¥0.2258 | ¥0.2762 | 55.02% |
| deepseek-v4-pro-idle (officialCny) | 长约 256K | ¥3.7230 | ¥1.4423 | ¥2.2807 | 61.26% |
| deepseek-v4-pro-idle (officialCny) | 超长约 512K | ¥7.4223 | ¥2.8431 | ¥4.5791 | 61.69% |
| deepseek-v4-pro-peak (officialCny) | 短约 4K | ¥0.1722 | ¥0.1321 | ¥0.0401 | 23.28% |
| deepseek-v4-pro-peak (officialCny) | 中约 32K | ¥1.0039 | ¥0.4516 | ¥0.5523 | 55.02% |
| deepseek-v4-pro-peak (officialCny) | 长约 256K | ¥7.4459 | ¥2.8846 | ¥4.5613 | 61.26% |
| deepseek-v4-pro-peak (officialCny) | 超长约 512K | ¥14.8445 | ¥5.6863 | ¥9.1582 | 61.69% |
| kimi-k3 (officialCny) | 短约 4K | ¥0.5284 | ¥0.4454 | ¥0.0829 | 15.70% |
| kimi-k3 (officialCny) | 中约 32K | ¥2.4945 | ¥1.3517 | ¥1.1428 | 45.81% |
| kimi-k3 (officialCny) | 长约 256K | ¥17.7316 | ¥8.2944 | ¥9.4372 | 53.22% |
| kimi-k3 (officialCny) | 超长约 512K | ¥35.2297 | ¥16.2816 | ¥18.9481 | 53.78% |
| glm-5.2 (catalogEstimateCny) | 短约 4K | ¥0.2112 | ¥0.1755 | ¥0.0357 | 16.91% |
| glm-5.2 (catalogEstimateCny) | 中约 32K | ¥1.2191 | ¥0.7270 | ¥0.4922 | 40.37% |
| glm-5.2 (catalogEstimateCny) | 长约 256K | ¥9.0360 | ¥4.9717 | ¥4.0643 | 44.98% |
| glm-5.2 (catalogEstimateCny) | 超长约 512K | ¥18.0118 | ¥9.8515 | ¥8.1603 | 45.31% |
| gpt-5.6-luna (catalogEstimateCny) | 短约 4K | ¥0.0401 | ¥0.0345 | ¥0.0056 | 14.06% |
| gpt-5.6-luna (catalogEstimateCny) | 中约 32K | ¥0.1738 | ¥0.0961 | ¥0.0777 | 44.71% |
| gpt-5.6-luna (catalogEstimateCny) | 长约 256K | ¥1.2099 | ¥0.5682 | ¥0.6417 | 53.04% |
| gpt-5.6-luna (catalogEstimateCny) | 超长约 512K | N/A | N/A | N/A | N/A |
| gpt-5.6-sol (catalogEstimateCny) | 短约 4K | ¥1.0027 | ¥0.8617 | ¥0.1410 | 14.06% |
| gpt-5.6-sol (catalogEstimateCny) | 中约 32K | ¥4.3450 | ¥2.4023 | ¥1.9427 | 44.71% |
| gpt-5.6-sol (catalogEstimateCny) | 长约 256K | ¥30.2481 | ¥14.2049 | ¥16.0432 | 53.04% |
| gpt-5.6-sol (catalogEstimateCny) | 超长约 512K | N/A | N/A | N/A | N/A |

## 解释限制

- 这是 payload 结构的确定性反事实模拟，不是 Provider 实际命中承诺。Provider 最小缓存阈值、TTL、路由、显式 cache-write 策略和服务端 eviction 都可能改变实测结果。
- 模型/profile/resource/tool 集合切换与 compaction 是允许的 cache epoch 边界；本 fixture 不把这些必要 reset 算作动态 capsule 回归。
- `catalogEstimateCny` 只用于横向估算，不代表 VSPLab 实际账单。正式账单必须继续显示为 `providerBilledCny: unknown`，直到 Provider 返回可信 cost。

## 复现

```bash
npx tsx scripts/cache-simulation.ts
npx vitest run test/cache-simulation.test.ts
```
