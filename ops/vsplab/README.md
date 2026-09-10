# VSPLab 中转站模型目录（Golden）

`model-catalog.json` 是 `/vsp/models` 端点的权威内容（Golden 标准目录）。2026-09-08 由联网核实产出：逐模型对照官方文档（智谱 / Moonshot / OpenAI / Anthropic / DeepSeek / 阿里云百炼 / MiniMax 等），修正了旧快照中 37 处与官方不一致的声明（effort 档位照抄模板、上下文/输出上限抄错、定价币种与倍率错误等）。2026-09-10 与线上部署内容对齐回写，并将 DeepSeek V4.1 Flash 转正（去掉内测期的 `expires-on-0910` 后缀），价格按官方当日新定价（空闲时段、7.2 汇率）修正。逐模型来源记录在 `metadataSources`（官方 URL 与核对时间），顶层 `metadataSourceSnapshot` 记录快照级来源；这些 provenance 字段客户端解析时会忽略。

本文件与线上部署内容保持逐字节一致（同一 JSON 序列化），便于用校验和检测漂移；发现线上被热改时，先回写本文件再继续修改。

## 契约要点

- `models[]` 按模型 id 索引；除 `id` 外全部字段可选，缺省表示"中转站未声明"，VSPi 保留本地值。
- `effortLevels` **声明即权威**：VSPi 2.2.0 起不再与内置目录取交集。包含 `"off"` 表示该模型可关闭思考。
- `defaultEffort` 为默认档位（官方有明确默认值时填写）。
- `cost` 单位为 **USD / 百万 tokens**（CNY 官方价按 7.2 汇率换算，DeepSeek 峰谷定价取空闲时段；`pricingBasis.relayCharges: false` 表示与官方等价计费）。
- `hidden: true` 表示该 id 不应出现在模型列表（幽灵 id 清理用）；`curated: false` 表示默认折叠展示。

## 部署

生成或修改后，同步到中转站并让 nginx 精确匹配 `/vsp/models` 直接对外：

```sh
scp ops/vsplab/model-catalog.json <relay-host>:/etc/vsp-sub2api/model-catalog.json
```

客户端在下次目录刷新（TUI 启动或每 6 小时自动刷新）时自动拉取生效，无需重启。
