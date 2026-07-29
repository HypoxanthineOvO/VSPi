---
authority_role: record
confidence: confirmed
created_at: 2026-07-23T14:17:08.891Z
dedupe_key: cycle.vspi-v0-1-0-usability.plan
id: decision-8d34bd77ce05ef6f025ea3e659aa23fb
kind: decision
schema_version: '1'
scope:
  ref: vspi-v0-1-0-usability
  type: cycle
semantic_hash: 8d34bd77ce05ef6f025ea3e659aa23fb8cfc76189ccd6e7193d7de44d835c39b
source_refs:
  - locator: compiled-plan
    ref: cycle:vspi-v0-1-0-usability:revision:2
    type: delivery_plan
supersedes:
  - decision-97e22cda868fbfc2ddf1a7779beedcc6
updated_at: 2026-07-23T14:17:08.891Z
---
# VSPi v0.1.0 本地日用版本

把当前以完整 TUI Fixture 为主、真实 Pi 后端为辅的原型收敛为诚实、可恢复、可配置并可长期本地使用的 v0.1.0：真实会话、Provider/Model、四级执行 Policy、OS sandbox、recovery、Question、附件、Local Plan、Prompt Profile 与手动压缩形成一条可验收链路，生产路径不再伪造能力。

```json
{
  "acceptance": {
    "criteria": [
      {
        "id": "truthful-runtime",
        "statement": "真实配置能够启动、恢复最近会话与历史、多轮流式执行、取消并恢复草稿、新建/切换/Fork 且退出重开后继续；失败明确显示且生产模式不静默回退 Fixture。",
        "verification": "使用真实 Pi、无凭据、损坏默认模型、恢复会话和显式 Fixture 五组 PTY 场景，检查 transcript、草稿、Session 身份、Model、Context 与错误边界。"
      },
      {
        "id": "tui-contract",
        "statement": "Splash、空状态、两行 Status、命令别名/补全、Composer、Markdown、thinking/tool、Question 和所有面板使用统一动作定义，提示与 handler 一致且无拥挤或抢键。",
        "verification": "40/80/120 列、ASCII/Unicode、no-color/256/truecolor、长路径/模型、IME/多行输入和真实按键序列快照与 PTY 测试全部通过。"
      },
      {
        "id": "provider-model",
        "statement": "Provider、凭据引用、Model、Effort、Prompt Profile 与全局/项目默认真实接入 Pi；项目 overlay 受 Trust 控制且不接受明文密钥或命令式 resolver。",
        "verification": "配置优先级、原子写入、冲突/损坏恢复、协议假服务器、手动连接测试、模型切换失败回滚和重启持久化测试通过。"
      },
      {
        "id": "execution-policy",
        "statement": "VSPi 以 Standard 为默认提供 Safe、Standard、Auto、YOLO 四级真实执行边界；Auto 仍受 sandbox，YOLO 明示 Host 风险，项目配置只降不升，recovery 与 Policy 分离且所有等级保留 Workflow authority gates。",
        "verification": "在隔离工作区执行每级文件/进程/网络矩阵、配置优先级与原子回滚、YOLO 警告、Sandbox/Host 标签、恶意项目配置 recovery 和 Workflow gate 拒绝测试，并由用户在 M4 Stone 检查真实 artifact。"
      },
      {
        "id": "interactive-inputs",
        "statement": "Question Tool 与图片附件从模型调用或用户输入到 TUI 回答、临时存储、Vision 校验和 Session 恢复形成真实闭环。",
        "verification": "四种 Question 题型及切题/重排/直接回答/跳过/复查键序列，Linux/macOS 剪贴板适配、SSH bridge、附件别名/删除/篡改/清理和非 Vision 拒绝测试通过。"
      },
      {
        "id": "local-plan-continuity",
        "statement": "Local Plan 支持多 Plan、Session 绑定、三层结构、typed tools、revision/lock/冲突拒绝、提醒与完整 TUI 工作区；压缩后仍能恢复目标、焦点、阻塞和下一步。",
        "verification": "Plan CRUD/bind、/new 与 --continue、并发 expected_revision、崩溃恢复、提醒计数、四种手动压缩 profile、Ctrl+C 取消和压缩后复核测试通过。"
      },
      {
        "id": "prompt-profiles",
        "statement": "模型家族 Prompt Profile 可选择、Fork、自定义、分层覆盖、匹配、导入导出并查看脱敏后的最终 Prompt；Factory 来源和评测元数据不构成功能门槛。",
        "verification": "Factory/用户/项目/Session 优先级、模型切换重匹配、rule toggle、effective prompt provenance、脱敏、上游版本/许可证 manifest 和只读更新检查测试通过。"
      },
      {
        "id": "scope-honesty",
        "statement": "v0.1.0 生产目录不包含 Demo/Fixture 命令、Update TUI、Hypo-Workflow Adapter、Sub Agent、Secret Manager、thinking 翻译或 Web 的伪实现；显式 Fixture 只作为隔离测试/离线入口。",
        "verification": "生产命令和打包 allowlist 审计、默认/Fixture 模式差异测试、文档契约搜索和 source/dist smoke 证明延期能力被删除、隔离或明确标注。"
      },
      {
        "id": "checkpoint-quality",
        "statement": "完整实现通过独立 test、implement、audit 证据，并可从干净临时目录安装和运行；接受后才创建并 push v0.1.0 commit 与 annotated tag，不创建 Public Release。",
        "verification": "npm run check、npm test、npm run build、source/dist smoke、npm pack、临时安装、真实 PTY、clean shutdown 和独立审计均无 High/Medium finding；Git 变更范围与版本策略复核通过。"
      }
    ],
    "scope": "plan"
  },
  "acceptance_criteria": [
    {
      "id": "truthful-runtime",
      "statement": "真实配置能够启动、恢复最近会话与历史、多轮流式执行、取消并恢复草稿、新建/切换/Fork 且退出重开后继续；失败明确显示且生产模式不静默回退 Fixture。",
      "verification": "使用真实 Pi、无凭据、损坏默认模型、恢复会话和显式 Fixture 五组 PTY 场景，检查 transcript、草稿、Session 身份、Model、Context 与错误边界。"
    },
    {
      "id": "tui-contract",
      "statement": "Splash、空状态、两行 Status、命令别名/补全、Composer、Markdown、thinking/tool、Question 和所有面板使用统一动作定义，提示与 handler 一致且无拥挤或抢键。",
      "verification": "40/80/120 列、ASCII/Unicode、no-color/256/truecolor、长路径/模型、IME/多行输入和真实按键序列快照与 PTY 测试全部通过。"
    },
    {
      "id": "provider-model",
      "statement": "Provider、凭据引用、Model、Effort、Prompt Profile 与全局/项目默认真实接入 Pi；项目 overlay 受 Trust 控制且不接受明文密钥或命令式 resolver。",
      "verification": "配置优先级、原子写入、冲突/损坏恢复、协议假服务器、手动连接测试、模型切换失败回滚和重启持久化测试通过。"
    },
    {
      "id": "execution-policy",
      "statement": "VSPi 以 Standard 为默认提供 Safe、Standard、Auto、YOLO 四级真实执行边界；Auto 仍受 sandbox，YOLO 明示 Host 风险，项目配置只降不升，recovery 与 Policy 分离且所有等级保留 Workflow authority gates。",
      "verification": "在隔离工作区执行每级文件/进程/网络矩阵、配置优先级与原子回滚、YOLO 警告、Sandbox/Host 标签、恶意项目配置 recovery 和 Workflow gate 拒绝测试，并由用户在 M4 Stone 检查真实 artifact。"
    },
    {
      "id": "interactive-inputs",
      "statement": "Question Tool 与图片附件从模型调用或用户输入到 TUI 回答、临时存储、Vision 校验和 Session 恢复形成真实闭环。",
      "verification": "四种 Question 题型及切题/重排/直接回答/跳过/复查键序列，Linux/macOS 剪贴板适配、SSH bridge、附件别名/删除/篡改/清理和非 Vision 拒绝测试通过。"
    },
    {
      "id": "local-plan-continuity",
      "statement": "Local Plan 支持多 Plan、Session 绑定、三层结构、typed tools、revision/lock/冲突拒绝、提醒与完整 TUI 工作区；压缩后仍能恢复目标、焦点、阻塞和下一步。",
      "verification": "Plan CRUD/bind、/new 与 --continue、并发 expected_revision、崩溃恢复、提醒计数、四种手动压缩 profile、Ctrl+C 取消和压缩后复核测试通过。"
    },
    {
      "id": "prompt-profiles",
      "statement": "模型家族 Prompt Profile 可选择、Fork、自定义、分层覆盖、匹配、导入导出并查看脱敏后的最终 Prompt；Factory 来源和评测元数据不构成功能门槛。",
      "verification": "Factory/用户/项目/Session 优先级、模型切换重匹配、rule toggle、effective prompt provenance、脱敏、上游版本/许可证 manifest 和只读更新检查测试通过。"
    },
    {
      "id": "scope-honesty",
      "statement": "v0.1.0 生产目录不包含 Demo/Fixture 命令、Update TUI、Hypo-Workflow Adapter、Sub Agent、Secret Manager、thinking 翻译或 Web 的伪实现；显式 Fixture 只作为隔离测试/离线入口。",
      "verification": "生产命令和打包 allowlist 审计、默认/Fixture 模式差异测试、文档契约搜索和 source/dist smoke 证明延期能力被删除、隔离或明确标注。"
    },
    {
      "id": "checkpoint-quality",
      "statement": "完整实现通过独立 test、implement、audit 证据，并可从干净临时目录安装和运行；接受后才创建并 push v0.1.0 commit 与 annotated tag，不创建 Public Release。",
      "verification": "npm run check、npm test、npm run build、source/dist smoke、npm pack、临时安装、真实 PTY、clean shutdown 和独立审计均无 High/Medium finding；Git 变更范围与版本策略复核通过。"
    }
  ],
  "constraints": [
    "复用 @earendil-works/pi-coding-agent 与 pi-tui 0.81.1 的公开 SDK/事件契约，不复制或 fork Pi 核心实现。",
    "保留并兼容用户现有 ~/.pi/agent 与项目 .pi 文件；VSPi 不静默改写 SYSTEM.md、APPEND_SYSTEM.md、AGENTS.md 或全局 models.json。",
    "项目 .vspi/models.json 禁止明文密钥和 !command；日志、错误、Prompt 预览与测试 artifact 必须脱敏。",
    "真实 API 冒烟调用需单独确认可用凭据、Provider 与费用上限；未运行只记录评测未运行，不禁用用户模板。",
    "v0.1.0 不提供 /update；真实 vspi --update、每次启动后台版本检查、Hypo-Workflow 集成和 Public Preview 均属于 v0.2.0。",
    "不实现模型路由、Agent Teams/Sub Agent、Secret Manager、thinking 翻译或 Web；这些进入后续独立 Cycle。",
    "当前工作树无 Git 基线提交且可能包含用户文件；执行期间不得丢弃或覆盖未知改动。",
    "执行权限等级固定为 Safe < Standard < Auto < YOLO，默认 Standard；项目配置只能降低有效 Policy，不能提升到 Auto/YOLO。",
    "Auto 在已配置能力边界内免询问但必须保留 OS sandbox；YOLO 只可由 CLI 或全局用户配置显式开启并显示 Host 风险警告。",
    "vspi --recovery 与 Policy 分离：忽略项目动态资源、第三方 extension 和 Workflow Adapter，以全局配置及 Standard 启动。",
    "任何 Execution Policy 都不能绕过 Hypo-Workflow 的 authority gate；旧后端 Mode Auto 与静默 Pi→Fixture fallback 必须删除。",
    "v0.1.0 不集成 Workflow Adapter；v0.2.0 的首个外部 Bootstrap Stone 由当前 Codex + Hypo-Workflow 执行并经用户验收后，才转入 VSPi 自托管。"
  ],
  "delivery_kind": "cycle",
  "delivery_mode": "plan",
  "evidence": [
    {
      "ref": "Docs/init_doc.md",
      "summary": "总体模型编排、上下文、TUI、Question、附件、配置与后续扩展需求。",
      "type": "requirements"
    },
    {
      "ref": "Docs/tui-v1.md",
      "summary": "已实现的 TUI 视觉与交互契约，同时明确列出仍为 Fixture 的能力。",
      "type": "ui-spec"
    },
    {
      "ref": "src/ and test/",
      "summary": "当前真实 Pi adapter 已覆盖基础流式会话、usage、图片和 session 切换，但 Model/Provider/Question/Update/Plan 等仍有 Fixture 或缺失。",
      "type": "repository"
    },
    {
      "ref": "node_modules/@earendil-works/pi-coding-agent/docs/",
      "summary": "ModelRuntime、SettingsManager、SessionManager、before_agent_start、compact、custom tools 与四种 Provider API 已核验可复用。",
      "type": "pi-sdk"
    },
    {
      "ref": "official repositories pinned during 2026-07-23 planning",
      "summary": "Codex、Gemini CLI、Qwen Code、Kimi Code 可作为开放 Harness；Anthropic 与其余模型家族按官方设计指南或模型级资料分级。",
      "type": "harness-sources"
    },
    {
      "ref": "planning conversation 2026-07-23",
      "summary": "确认 Local Plan、压缩、Workflow Adapter、Prompt Profile、Provider overlay、版本策略、更新入口和公共发布边界。",
      "type": "user-decisions"
    },
    {
      "ref": "conversation-2026-07-23-execution-policy",
      "summary": "用户确认执行权限顺序为 Safe < Standard < Auto < YOLO，Standard 默认，Auto 仍受 sandbox，YOLO 使用宿主用户权限。",
      "type": "user_decision"
    },
    {
      "ref": "conversation-2026-07-23-recovery",
      "summary": "用户确认恢复启动与执行权限分离；恢复入口为 vspi --recovery，不复用 --safe。",
      "type": "user_decision"
    },
    {
      "ref": "conversation-2026-07-23-workflow-bootstrap",
      "summary": "用户确认 v0.1.0 不内置 Workflow Adapter；v0.2.0 先由当前 Codex + Hypo-Workflow 完成 Adapter Bootstrap Stone，再切换到 VSPi 自托管。",
      "type": "user_decision"
    }
  ],
  "id": "vspi-v0-1-0-usability",
  "milestones": [
    {
      "depends_on": [],
      "id": "M1",
      "order": 1,
      "outcome": "以单一 Action Registry 统一按键、命令、alias、completion 与 contextual hints；修复永久 Splash、空 transcript、两行 Status、Composer/Markdown 基础布局，展示真实 Backend 与 Policy，并从生产目录删除 Update 与 Demo 命令入口。",
      "title": "统一动作系统与诚实 TUI 外壳",
      "verification_criteria": [
        "每个 Panel/Composer/Inspect 动作只有一个定义源，handler、hint、命令候选和禁用原因由同一注册表生成。",
        "Tab/Shift+Tab、Enter、Space、方向键、Ctrl/Option 组合在 Commands、Question、Provider、Model、Settings、Sessions、Plan、Prompt 与 Policy 中没有抢占或漂移。",
        "启动、/new、/clear 都把完整 final Splash 写入 scrollback，动态 TUI 不擦除；空会话只显示当前计划为空与真实配置状态。",
        "80 列状态固定为第一行 Model/Effort/Context、第二行 Path/Token/Cost；40/120 列安全降级，长值只截断自身。",
        "生产命令至少覆盖 /new、/sessions、/compact、/model、/providers、/plan、/prompt、/thinking、/effort、/policy、/usage、/settings、/theme、/quit；/session、/provider、/exit、/q 等明确显示 canonical/alias 关系并支持唯一 Tab 补全。",
        "Splash 与状态区分别显示 Backend Pi 或显式 Fixture，以及 Policy 名称与 Sandboxed/Host 边界；旧的后端 Mode Auto 文案和语义被删除。"
      ]
    },
    {
      "depends_on": [
        "M1"
      ],
      "id": "M2",
      "order": 2,
      "outcome": "扩展 Pi adapter 和 App 状态恢复，使正常启动、历史 hydration、流式消息、thinking/tool、取消、草稿恢复、新建/切换/Fork/退出重开全部使用真实 Pi Session 真相；Fixture 仅能通过显式测试/离线入口启用，绝不静默回退。",
      "title": "真实 Pi Runtime、历史与 Session 生命周期",
      "verification_criteria": [
        "正常启动成功时使用真实 Pi Model；无可用模型或配置损坏时显示 setup/error，不回退 Fixture；只有显式 VSPi_FIXTURE=1 或等价测试入口才进入 Offline Fixture。",
        "恢复最近 Session 时先 hydration 历史再接受输入，流式 delta 不重复历史，切换/新建/Fork 后 transcript、usage、Context 和 Plan binding 不串屏。",
        "Ctrl+C 能取消生成并恢复未发送或失败草稿；连续取消、provider retry、compact 边界和 clean shutdown 不留下 busy 状态。",
        "/new 继承当前 Model/Effort/Profile 且解绑 Plan；/new --default 重读默认；/new --continue 额外继承当前 Plan。",
        "source/dist 和 80x24 PTY 覆盖首次启动、恢复、切换、Fork、退出重开与不可用默认模型。"
      ]
    },
    {
      "depends_on": [
        "M2"
      ],
      "id": "M3",
      "order": 3,
      "outcome": "建立 ProviderCatalog/ConfigService，合并 Pi 内置、全局 models.json 与受限项目 .vspi/models.json；复用 ModelRuntime/Auth/Settings 接通 Provider 操作、凭据入口、模型列表、原子 Model/Effort 切换和全局/项目默认。",
      "title": "Provider、Model、Effort 与配置真相源",
      "verification_criteria": [
        "项目 Provider overlay 覆盖规则、Trust gate、schema 校验、原子保存、expected hash 冲突、损坏文件恢复和来源标记均有契约测试。",
        "项目配置拒绝明文 API Key、!command 和敏感 header；Pi 全局凭据、环境变量与 Session 临时凭据按已确认优先级解析且永不回显。",
        "Provider Enter 只打开操作菜单；编辑使用 Ctrl+S；检查配置不联网；测试连接显式触发；最小生成测试再次确认费用。",
        "/model 从 ModelRuntime 读取真实可用模型并调用 session.setModel；切换成功后 Model/Effort/Context/Vision/Profile 同步，失败原子回滚。",
        "OpenAI Responses、OpenAI Completions、Anthropic Messages 和 Google Generative AI 使用本地假服务器/contract fixtures 覆盖请求形态与错误映射。"
      ]
    },
    {
      "depends_on": [
        "M1",
        "M2",
        "M3"
      ],
      "id": "M4",
      "order": 4,
      "outcome": "建立独立的 ExecutionPolicyService 与进程执行边界，实现 Safe、Standard、Auto、YOLO 四级权限、默认 Standard、项目只降不升、可审计的 OS sandbox，以及与权限策略分离的 vspi --recovery 启动链路。",
      "stone": {
        "acceptance_criteria": [
          "Safe、Standard、Auto、YOLO 各自的真实文件/进程/网络探针结果与界面标签一致，没有把提示文案当作 sandbox。",
          "Standard 是默认值；项目配置无法提升到 Auto 或 YOLO；Auto 显示 Sandboxed，YOLO 显示 Host 且经过显式警告。",
          "vspi --recovery 在含恶意或损坏项目配置、extension、Workflow Adapter fixture 的目录中仍以全局配置和 Standard 启动。",
          "Policy 不绕过 Hypo-Workflow authority gates，审计证据不包含 secret，用户确认键位、文案和失败反馈可接受。"
        ],
        "id": "S-policy-contract",
        "review": "用户在真实 TUI 与隔离测试工作区中检查四级 Policy 的标签、允许/拒绝矩阵、YOLO 警告、项目只降不升和 vspi --recovery 行为；只有该安全契约被接受，才继续其余 v0.1.0 功能。"
      },
      "title": "执行 Policy、OS Sandbox 与 Recovery",
      "verification_criteria": [
        "Policy 顺序与语义固定为 Safe < Standard < Auto < YOLO：Safe 为只读 sandbox；Standard 允许工作区内可逆操作并对风险、越界或共享动作询问/阻止；Auto 在配置的工作区与网络能力边界内不询问但仍处于 sandbox；YOLO 不经 VSPi approval 或 sandbox，直接受当前 OS 用户权限约束。",
        "默认 Policy 为 Standard；CLI 与全局用户配置可以显式选择更高等级，项目配置只能保持或降低有效等级，不能把用户提升到 Auto/YOLO；YOLO 启动必须展示不可跳过的明确警告与 Host 标识。",
        "TUI、启动页、诊断信息和错误统一展示例如 Policy Auto · Sandboxed 与 Policy YOLO · Host；Policy 切换原子生效，失败回滚，不与 Backend Pi/Fixture 混为同一 Mode。",
        "Linux OS sandbox 的文件、进程和网络能力矩阵由真实探针验证：每级允许项成功、禁止项在动作发生前失败，并产生不含 secret 的决策日志；声明 Sandboxed 时不得退化为仅 UI 提示。",
        "vspi --recovery 忽略项目 .pi/.vspi 动态资源、第三方 extension 与 Workflow Adapter，只读取全局配置并强制以 Standard Policy 启动；它不叫 --safe，也不继承项目的 Auto/YOLO。",
        "任一 Policy 都不能绕过 Hypo-Workflow 的 Plan、Stone、Receipt、删除或发布权限门；Fixture 和测试注入也不能改变这一约束。"
      ]
    },
    {
      "depends_on": [
        "M1",
        "M2",
        "M3",
        "M4"
      ],
      "id": "M5",
      "order": 5,
      "outcome": "把现有 Question、clipboard/bridge、thinking/tool 和 Markdown 表面接入真实模型工具与 Session，统一题型状态机、附件生命周期、折叠/展开、代码换行和中文 Markdown 视觉规则。",
      "title": "Question、附件与 Transcript/Markdown 完整交互",
      "verification_criteria": [
        "Question Tool 真实注册并覆盖 single/multi/ranking/freeText、其他、直接回答、跳过、Left/Right 切题、Ctrl/Option 重排和最终 review；提示只列当前可用动作。",
        "剪贴板图片写入 session 临时目录并生成可重命名别名；SSH bridge token/origin、大小/MIME/路径、manifest 篡改、恢复、删除和清理策略测试通过。",
        "非 Vision 模型在发送前明确拒绝附件且保留草稿；Vision 模型收到真实 image content 和脱敏 manifest。",
        "Markdown 标题、列表层级符号、引用、粗体/斜体、行内/块代码、长代码换行与流式增量在 40/80/120 列无重叠或残影。",
        "showThinking、wrapCode 与单条 thinking/tool 展开即时生效并持久化；隐藏内容不破坏 Inspect 索引。"
      ]
    },
    {
      "depends_on": [
        "M1",
        "M2",
        "M4"
      ],
      "id": "M6",
      "order": 6,
      "outcome": "实现独立于 Hypo-Workflow 的 LocalPlanBackend：不可变 revision + 原子 HEAD + lock + semantic hash；支持多 Plan、Session 绑定、三层 work items、焦点/阻塞/下一步、typed tools 和完整 TUI 操作。",
      "title": "Local Plan 后端、工具与完整工作区",
      "verification_criteria": [
        "plan_list/read/create/update/bind 的 schema、expected_revision、语义冲突、原子写入、崩溃恢复、archive 和跨进程 lock 测试通过。",
        "一个 Session 绑定零或一个 Plan；/new 解绑、--continue 继承；binding 使用 Pi custom entry，Plan 内容不被复制进历史消息。",
        "Plan 工作区展示目标、背景、难点、一个 focus、多个 in_progress、blocker 和 next action；最大三层，窄屏才使用紧凑 fallback。",
        "Enter contextual action menu 支持状态/focus/next action 等简单编辑；复杂重构通过 typed tools；无 Plan 时只显示当前计划为空。",
        "绑定 Session 接到无关多步任务时触发 Question 路由，不静默混入当前 Plan。"
      ]
    },
    {
      "depends_on": [
        "M3",
        "M4",
        "M6"
      ],
      "id": "M7",
      "order": 7,
      "outcome": "建立 PromptProfileService 和 Factory Registry，在不改写用户 Pi 文件的前提下按模型注入可追踪 overlay；提供 Factory/Fork/覆盖/规则/匹配/导入导出/effective prompt UI，并维护官方 Harness 来源 manifest 与提炼文档。",
      "title": "模型 Prompt Profile 与官方 Harness 资料库",
      "verification_criteria": [
        "Factory 家族覆盖 Anthropic、OpenAI、Google、DeepSeek、Moonshot、Z.AI、Xiaomi、MiniMax、Tencent、Alibaba；来源类型与评测状态分离且不锁功能。",
        "全局、项目、Session 覆盖优先级，Provider/model 精确或 family 匹配，rule toggle、profile pin/off 和模型切换重匹配测试通过。",
        "effective prompt 逐段标注 Pi base/SYSTEM/APPEND/context/Profile/Plan 来源并脱敏；VSPi 不重写 SYSTEM.md、APPEND_SYSTEM.md 或 AGENTS.md。",
        "Factory 更新不覆盖用户 Fork；导入导出校验 schema/version/source；解析失败显示具体字段并保持上一个有效 profile。",
        "Docs/harness 的 source manifest、family extraction、commit/tag、license policy、适用模型、改写理由、评测和 last reviewed 完整；harness:check 只读生成上游变化报告。"
      ]
    },
    {
      "depends_on": [
        "M2",
        "M4",
        "M6",
        "M7"
      ],
      "id": "M8",
      "order": 8,
      "outcome": "通过 before_agent_start 临时注入不超过约 2K tokens 的 Plan capsule，按四轮/六事件及 resume/compaction/failure/completion 触发复核；手动 compact 支持四种 profile，并保证取消或失败不改变 Session/Plan。",
      "title": "Plan 上下文、提醒与手动压缩连续性",
      "verification_criteria": [
        "绑定 Plan 默认 Execution Continuity，未绑定默认 Pi Native；Research Decisions、Custom 和 profile 选择在 /compact 中可检查。",
        "Plan capsule 只在本轮 system prompt overlay 中出现，不每轮持久化 hidden message；内容预算、来源和 semantic hash 可诊断。",
        "四个 meaningful turns 或六个 work events、resume、compaction、重复失败和 completion claim 触发需复核标记与隐藏提醒，不弹阻塞模态。",
        "Ctrl+C 调用 abortCompaction；成功、失败、取消、overflow-before-manual 和重试场景均保持 Session/Plan 原子性与草稿。",
        "v0.1.0 自动 threshold/overflow 仍使用 Pi Native，完成后触发 Plan review；文档明确统一自动 profile 属于 v0.2.0。"
      ]
    },
    {
      "depends_on": [
        "M1",
        "M2",
        "M3",
        "M4",
        "M5",
        "M6",
        "M7",
        "M8"
      ],
      "id": "M9",
      "order": 9,
      "outcome": "清除 Fixture-as-feature 叙述和生产入口，完成旧配置/Session 兼容、全链路错误恢复、文档与安装验证；在用户最终接受后才创建并 push v0.1.0 commit 和 annotated tag，不发布 Release。",
      "title": "集成迁移、独立审计与 v0.1.0 检查点",
      "verification_criteria": [
        "默认启动到恢复/对话/Question/附件/Plan/Profile/compact/new/switch/fork/restart 的真实端到端 PTY 链路通过，四级 Policy 和 recovery 路径纳入矩阵，任何失败不丢草稿、配置或历史。",
        "npm run check、npm test、npm run build、source/dist smoke、npm pack --dry-run、临时目录安装、40/80/120 色彩矩阵和 clean shutdown 全部通过。",
        "生产 bundle、命令 catalog、README 和 Docs 不含 /update、Demo Question/Tool/Provider、静默 Fixture fallback 或虚假可用状态。",
        "独立 test、implement、audit 身份分别提供证据，最终审计无 High/Medium finding；真实 API 未获授权的家族明确标注评测未运行。",
        "Git 状态审计只包含本 Cycle 有意文件；最终接受前不 commit/tag/push，接受后执行一次 v0.1.0 checkpoint 且不创建 GitHub/GitLab Release。"
      ]
    }
  ],
  "outcome": "把当前以完整 TUI Fixture 为主、真实 Pi 后端为辅的原型收敛为诚实、可恢复、可配置并可长期本地使用的 v0.1.0：真实会话、Provider/Model、四级执行 Policy、OS sandbox、recovery、Question、附件、Local Plan、Prompt Profile 与手动压缩形成一条可验收链路，生产路径不再伪造能力。",
  "revision": 2,
  "schema_version": "1",
  "status": "draft",
  "title": "VSPi v0.1.0 本地日用版本",
  "plan_hash": "d00878825b84a0c51e2afa263fc27b25e7880ce0b2becab53228671d09049845"
}
```
