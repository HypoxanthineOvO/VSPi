# VSPLab 中转站模型目录（Golden）

2026-09-23：维护源增补 GPT-6 Sol/Luna、Claude Opus 5.5、MiMo V2.6 Flash/Pro、Grok 4.7 的官方元数据，并更新 VSPi 常用模型推荐。当前维护源和 Babel 用户目录暂存文件 SHA-256 均为 `41a7011dc0c4001f77a76f95c4c05166e922e6abc752330305d6923bd13ab6bf`。Babel 的 root 所有线上 `/etc/vsp-sub2api/model-catalog.json` 已通过受限免密安装工具替换，cn/tech 回包及 Windows 公网 tech 均核对为同一 SHA-256 和 70 条；旧文件备份在 `/var/backups/vsp-model-catalog/`。VSPi 2.5.3 候选包仍在验证，已安装的 2.5.2 尚未更新。模型目录不受 Sub2API 账户、分组和路由是否可用的约束。

2026-09-16：已备份并同步到 Babel，tech 公网及 Babel 本机 cn/tech 虚拟主机回读 SHA-256 均为 `acb1d4e239893e354e18d917345c52d531c7ae1a93096b459f8435d296d5f027`。修复 `deepseek-flash` 的 V4.1 名称、V4 Pro 隐藏状态及 K3 元数据差异。2.5.1 起该文件同时打包为客户端内置默认值；服务端目录供旧客户端/其他调用方使用，不再覆盖新版客户端的用户配置。

2026-09-13 更新：用户确认本文件为模型元数据标准。DeepSeek 四个现有可见条目的价格按当前官方 USD 价格页修正，并在 `metadataSources.cost` 标记空闲基价、峰值倍率和时段；不再使用人民币固定汇率换算 DeepSeek。官方当前价格页已撤回 9 月 14 日将 V4 Pro 改按 Flash 计费的旧安排，Pro 仍按独立费率。此次不修改模型 ID、协议或思考档位，不新增提供商接入。**本次更新尚未发布到 Babel**，实施前线上文件仍是较早快照，与本文件不一致；下文历史同步记录不代表当前线上已同步。

`model-catalog.json` 是 `/vsp/models` 端点的权威内容（Golden 标准目录）。2026-09-08 由联网核实产出：逐模型对照官方文档（智谱 / Moonshot / OpenAI / Anthropic / DeepSeek / 阿里云百炼 / MiniMax 等），修正了旧快照中 37 处与官方不一致的声明（effort 档位照抄模板、上下文/输出上限抄错、定价币种与倍率错误等）。2026-09-10 与线上部署内容对齐回写，并将 DeepSeek V4.1 Flash 转正（去掉内测期的 `expires-on-0910` 后缀），价格按官方当日新定价（空闲时段、7.2 汇率）修正。逐模型来源记录在 `metadataSources`（官方 URL 与核对时间），顶层 `metadataSourceSnapshot` 记录快照级来源；这些 provenance 字段客户端解析时会忽略。

本文件与线上部署内容保持逐字节一致（同一 JSON 序列化），便于用校验和检测漂移；发现线上被热改时，先回写本文件再继续修改。

## 契约要点

- `models[]` 按模型 id 索引；除 `id` 外全部字段可选，缺省表示"中转站未声明"，VSPi 保留本地值。
- 可选 `capabilities` 使用 VSPi 已有能力名（例如 `tool_use`）；新模型可用数据直接声明工具能力，不必添加按模型名识别的代码。字段省略时行为不变，用户 overrides 保留；`input` 继续描述媒体输入。该字段不提供调用权限或可用性承诺。
- `effortLevels` 表示真实独立档位，不应照抄通用模板。新版 VSPi 对已知模型使用已核对的本地基线；远程修订须携带 `effortRevision`（当前为 2 或更高），旧的未版本化列表不能覆盖该基线。包含 `"off"` 表示支持关闭，但新版界面不会展示 Off。
- `effortMode` 为 `effort` 或 `toggle`。MiMo V2.5 与 MiniMax M3 使用 `toggle`，列表中的 `on` 只表示开启思考，不代表一档推理强度。发布此契约时须与支持它的新版 VSPi 配套，不能假设旧版会正确解释。
- 版本化声明应完整提供档位与默认值；同版本或更高版本可修订既有模型，较旧版本不能回退已保存的新声明。用户 `overrides` 始终保留。
- `defaultEffort` 为默认档位（官方有明确默认值时填写）。
- `cost` 单位为 **USD / 百万 tokens**。DeepSeek 直接使用[官方 USD 表](https://api-docs.deepseek.com/quick_start/pricing/)的空闲时段价格，高峰为两倍；其他条目保留原有来源/换算约定（CNY 官方价按 7.2 汇率换算）。客户端当前投影的是基准价，不是实时峰谷账单；实际网关计费还取决于请求时间与渠道/分组设置，`pricingBasis.relayCharges: false` 不代表已经验证线上所有扣费配置。
- `hidden: true` 表示该 id 不应出现在模型列表（幽灵 id 清理用）；`curated: false` 表示默认折叠展示。

## 部署

生成或修改后，同步到中转站并让 nginx 精确匹配 `/vsp/models` 直接对外：

```sh
scp ops/vsplab/model-catalog.json <relay-host>:/etc/vsp-sub2api/model-catalog.json
```

2.5.0 及更早客户端在下次目录刷新时拉取；2.5.1 起内置目录随客户端发布更新，用户在 VSPi `config.toml` 中写差异覆盖。
