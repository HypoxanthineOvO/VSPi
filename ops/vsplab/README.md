# VSPLab 中转站模型目录（Golden）

2026-10-27：新增 GPT-6.1 Terra（`gpt-6.1-terra`），目录共 78 条，已通过受限安装器发布。cn/tech 公网回读 SHA-256 均为 `de096cae095a47a58cb007c377227095b655dcf19b68500ee86ca3aea631b8d7`。模型支持文本、图片输入及 Responses 工具调用，API 上下文 1,050,000、最大输出 128,000；思考关闭映射到官方 `none`，其余为 low/medium/high/xhigh/max，默认 medium。参考价为每百万 token 输入 $1、输出 $5、缓存读 $0.05、30 分钟缓存写 $1.25；输入超过 272,000 时输入及缓存价翻倍、输出价 1.5 倍。官方另有 12 小时缓存写入价格，当前目录的单个缓存写字段只表示 30 分钟价格。

来源：[模型规格与价格](https://developers.openai.com/api/docs/models/gpt-6.1-terra)、[发布日期](https://developers.openai.com/api/docs/changelog)。目录是元数据；生产暂无 OpenAI 上游账号，GPT 路由未启用，不能把目录更新或路由预览当作实际模型可调用的证明。VSPi 消费 `mergeRelayCatalog` 的实际测试已验证 `off → none`、Responses、图片/工具能力与价格；已安装客户端的内置目录仍取决于后续客户端发布。

2026-10-24：维护源补齐 Kimi K3.1 Pro / Highspeed、MiniMax M3.1 Flash、Claude Haiku 5.5，共 77 条，已通过固定免密安装器发布到 Babel；最终 cn/tech 公网回读 SHA256 均为 `bacdc9e686fc04a278381c4d038a489e537c24ef9641aba6921f008d65ac5e98`，与维护源逐字节一致。Kimi 使用官方 Coding Plan ID `k3.1-pro` / `k3.1-pro-highspeed`，`kimi-` 前缀名称仅作显式兼容别名；新增两项优先使用原生 Responses。Kimi K2.8 Preview 的显示名称、1M 上下文与三档思考已校正，K2.7 Code Highspeed 仅保持思考开启，不再展示虚假的强度档位。K3/K3.1 的 Coding Plan 默认显式设为 `high`，依据[模型配置表](https://www.kimi.com/code/docs/kimi-code/models.html)；发布公告和按量 API 文档写作 `max`，因此不依赖上游省略字段的默认值。

新模型的上下文、输入类型、思考与参考价格均保留逐字段官方来源。未取得 Coding Plan / MiniMax 新模型的独立最大输出规格时省略 `maxTokens`，不拿上下文长度或旧模型配置代替；K2.8 主 ID 与旧别名互相矛盾的继承输出上限一并移除，Coding Plan 两个旧条目的未核实费用估算也不再发布。K3 的视频输入按官方规格补齐。Haiku 5.5 的参考价保留 100K 输入以上的高档整单价格。模型元数据与账号准入分开：本次目录更新不启用 Claude、GPT、Devin 或额外 Go 模型，也不改变既有 MiniMax 备用链。DeepSeek V4.1 Flash 1017 已在上次目录更新中记录，本轮保留；没有把官方 checkpoint 更新直接视作 Go/Free 同步证明。

本轮核对来源：[Kimi Coding](https://www.kimi.com/code/docs/kimi-code/models.html)、[MiniMax M3.1 Flash](https://www.minimax.io/blog/minimax-m31f)、[MiniMax 调用规格](https://platform.minimax.io/docs/guides/text-generation)、[Haiku 5.5](https://platform.claude.com/docs/en/models/haiku-5-5/overview)、[DeepSeek 更新](https://api-docs.deepseek.com/updates/)、[OpenAI 模型目录](https://developers.openai.com/api/docs/models)、[GLM](https://autoclaw.z.ai/models/)、[MiMo](https://mimo.xiaomi.com/blog/mimo-v2-6-tool-call-repetition)。GPT-6.1 Sol、GLM-5.3/Flash 与 MiMo-V2.6 已有条目。VSPi 2.5.1 及以后使用随客户端发布的内置目录；更新这个维护源和公网 JSON 不代表已安装客户端同步升级。真实 `mergeRelayCatalog` 离线消费已验证新增协议、上下文、能力、思考档位、别名与 overrides 保留；当前消费者的 `contextTiers` 只投影输入/输出费用，Haiku 的阶梯缓存费率仍仅完整保存在 JSON 中，须随后续客户端计价类型改造处理，不影响 Sub2API 账本。

2026-10-17：已同步 Babel 线上 `/vsp/models`，cn/tech 公网正文 SHA-256 均为 `a2b0945babff36e17b736ade1cc016ee203a71f096e25ba40a9ddab120c95378`，共 73 条。官方 Flash 标注为 V4.1-Flash-1017，新增 `deepseek-flash-free`（显示名 DeepSeek Flash Free，兼容 `deepseek-v4.1-flash-free`）；免费入口经真实 OpenCode → 生产混合组实测 995857 输入 tokens、首中尾标记检索和零费用账本后配置 1000000 总上下文/32000 最大输出。免费渠道是否已同步 1017 checkpoint 尚未确认。发布保留此前已提交的 GPT-6.1 Sol、Claude Sonnet 5.5 两项元数据，不改变其业务路由；无需重编译或重启服务。旧目录由固定免密安装器备份到 `/var/backups/vsp-model-catalog/`。

2026-10-15：维护源增补 GPT-6.1 Sol、Claude Sonnet 5.5 的官方元数据（OpenAI 模型页/价格页/changelog，Claude 模型总览/价格页/effort 文档/新闻页，均于当日核对），共 72 条，SHA-256 为 `61af24d1911052dcbc06685ebff50ac71cbd080c9aeeba3834245acba7752092`。随 VSPi 2.7.0 作为内置默认值发布；**尚未同步到 Babel 线上 `/vsp/models`**。VSPi 常用模型推荐同时加入 GPT 6.1 Sol、Claude Sonnet 5.5 与 Gemini 4 Argon（Gemini 不经 VSPLab 目录）。

2026-09-23：维护源增补 GPT-6 Sol/Luna、Claude Opus 5.5、MiMo V2.6 Flash/Pro、Grok 4.7 的官方元数据，并更新 VSPi 常用模型推荐。当前维护源和 Babel 用户目录暂存文件 SHA-256 均为 `41a7011dc0c4001f77a76f95c4c05166e922e6abc752330305d6923bd13ab6bf`。Babel 的 root 所有线上 `/etc/vsp-sub2api/model-catalog.json` 已通过受限免密安装工具替换，cn/tech 回包及 Windows 公网 tech 均核对为同一 SHA-256 和 70 条；旧文件备份在 `/var/backups/vsp-model-catalog/`。VSPi 2.5.3 已按 Linux 先行发布并更新 latest；已安装的 2.5.2 仍需用户更新。模型目录不受 Sub2API 账户、分组和路由是否可用的约束。

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

在 Sub2API 仓库用 `deploy/catalog/catalog.py` 校验并准备已提交的源文件。上传至 Babel 固定暂存文件，再通过既有免密安装器原子替换；安装器保留原目录备份，无需重启 Nginx：

```sh
scp ops/vsplab/model-catalog.json Babel:/home/heyx/VSP-Sub2API/incoming/model-catalog-pending.json
ssh Babel /usr/local/sbin/vsp-model-catalog-install check
ssh Babel sudo -n /usr/local/sbin/vsp-model-catalog-install install
```

安装后分别核对本机 cn/tech 虚拟主机、公网正文与源文件的 SHA256；普通应用发布不能覆盖独立目录。

2.5.0 及更早客户端在下次目录刷新时拉取；2.5.1 起内置目录随客户端发布更新，用户在 VSPi `config.toml` 中写差异覆盖。
