# VSPLab 中转站模型目录（Golden）

`model-catalog.json` 是 `/vsp/models` 端点的权威内容（Golden 标准目录）。2026-09-08 由联网核实产出：逐模型对照官方文档（智谱 / Moonshot / OpenAI / Anthropic / DeepSeek / 阿里云百炼 / MiniMax 等），修正了旧快照中 37 处与官方不一致的声明（effort 档位照抄模板、上下文/输出上限抄错、定价币种与倍率错误等）。2026-09-10 与线上部署内容对齐回写，并将 DeepSeek V4.1 Flash 转正（去掉内测期的 `expires-on-0910` 后缀），价格按官方当日新定价（空闲时段、7.2 汇率）修正。逐模型来源记录在 `metadataSources`（官方 URL 与核对时间），顶层 `metadataSourceSnapshot` 记录快照级来源；这些 provenance 字段客户端解析时会忽略。

本文件与线上部署内容保持逐字节一致（同一 JSON 序列化），便于用校验和检测漂移；发现线上被热改时，先回写本文件再继续修改。

## 契约要点

- `models[]` 按模型 id 索引；除 `id` 外全部字段可选，缺省表示"中转站未声明"，VSPi 保留本地值。
- `effortLevels` 表示真实独立档位，不应照抄通用模板。新版 VSPi 对已知模型使用已核对的本地基线；远程修订须携带 `effortRevision`（当前为 2 或更高），旧的未版本化列表不能覆盖该基线。包含 `"off"` 表示支持关闭，但新版界面不会展示 Off。
- `effortMode` 为 `effort` 或 `toggle`。MiMo V2.5 与 MiniMax M3 使用 `toggle`，列表中的 `on` 只表示开启思考，不代表一档推理强度。发布此契约时须与支持它的新版 VSPi 配套，不能假设旧版会正确解释。
- 版本化声明应完整提供档位与默认值；同版本或更高版本可修订既有模型，较旧版本不能回退已保存的新声明。用户 `overrides` 始终保留。
- `defaultEffort` 为默认档位（官方有明确默认值时填写）。
- `cost` 单位为 **USD / 百万 tokens**（CNY 官方价按 7.2 汇率换算，DeepSeek 峰谷定价取空闲时段；`pricingBasis.relayCharges: false` 表示与官方等价计费）。
- `hidden: true` 表示该 id 不应出现在模型列表（幽灵 id 清理用）；`curated: false` 表示默认折叠展示。

## 部署

生成或修改后，同步到中转站并让 nginx 精确匹配 `/vsp/models` 直接对外：

```sh
scp ops/vsplab/model-catalog.json <relay-host>:/etc/vsp-sub2api/model-catalog.json
```

客户端在下次目录刷新（TUI 启动或每 6 小时自动刷新）时自动拉取生效，无需重启。
