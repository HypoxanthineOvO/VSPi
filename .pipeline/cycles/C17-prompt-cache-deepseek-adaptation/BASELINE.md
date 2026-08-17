---
kind: cache-baseline
cycle: C17-prompt-cache-deepseek-adaptation
captured: 2026-08-17T21:34:00+08:00
currency: CNY
fx_rate: 6.80
---

# 优化前真实 Session 基线

## 结论

选取当前 VSPi 工作区最近一个包含完整 usage 的真实 Pi Session，只读取消息 usage、Provider、模型、时间戳、stop reason 与 compaction 边界，不读取或复制对话正文。该 trace 有 235 个有效 assistant 响应，Provider 报告累计 Cache Hit Rate 为 **97.80%**；最近有效请求为 **99.37%**。按 Pi 的 1,024-token noise floor 规则检出 **6 次** cache miss，重复计费 token 合计 **349,929**。

## 样本

- Session：`2026-08-16T15-05-18-225Z_01a00b1b-1091-796e-8226-cebb3a99cdbe.jsonl`
- 有 usage 的 assistant 响应：235
- Uncached input：592,794 tokens
- Cache read：26,346,304 tokens
- Cache write：0 tokens
- Output：150,605 tokens
- 累计 prompt：26,939,098 tokens
- 累计 Cache Hit Rate：97.7995%
- 最近有效请求 Cache Hit Rate：99.3684%
- Cache miss：6 次 / 349,929 重复计费 tokens

## 起始六轮

| Turn | Prompt | Cache read | Hit Rate | Output | Stop |
| ---: | ---: | ---: | ---: | ---: | --- |
| 1 | 8,117 | 192 | 2.37% | 117 | toolUse |
| 2 | 8,315 | 8,064 | 96.98% | 68 | toolUse |
| 3 | 8,428 | 8,256 | 97.96% | 74 | toolUse |
| 4 | 8,612 | 8,384 | 97.35% | 58 | toolUse |
| 5 | 9,277 | 8,576 | 92.44% | 77 | toolUse |
| 6 | 10,190 | 9,216 | 90.44% | 45 | toolUse |

## 口径与限制

- Hit Rate 分母为 `input + cacheRead + cacheWrite`，分子为 `cacheRead`。
- Miss 使用 Pi 同口径：相邻请求可复用 prompt 与本轮 cache read 的差值超过 1,024 tokens 才计数；compaction/branch summary 清除前序比较基准。
- 这是观察性 Before trace，不是控制实验。M2 会保持 turn workload 一致，分别计算当前动态 system 注入与稳定 prompt 实现。
- Session 内 cost breakdown 为 0，无法证明 Provider 实际账单；`providerBilledCny` 必须保持 `unknown`。
- 真实 Provider-reported cache read 与确定性 prefix simulation 必须分栏，不能把“可缓存”写成“实际命中”。
