---
kind: discussion-summary
cycle: C13-pi-editor-latency-repair
updated: 2026-08-16T18:29:19+08:00
---

# Pi Editor 与模型目录性能修订讨论摘要

## 已确认需求

- 0.6.2 的开屏表现为接受基线；修复卡顿即可，不新增旧式逐帧动画。
- 尽量复用 Pi 官方绘图与输入能力，特别是 Composer；原始问题是输入后向左移动光标会卡死。
- 更新到 Pi 0.84.2 提供的最新模型目录，并解决模型列表加载和交互卡顿。
- 用户报告 VSPi 运行数分钟后出现严重卡死；该反馈优先级高于继续提交 M2 性能实现。
- 验收目标为本机（不是 Windows 门禁）；本修订作为 v0.6.4 发布候选。
- 删除 SSH Attachment Bridge 整体产品面；保留本地附件和 SSH 命令审批/Provider 认证。
- 默认 Execution Policy 改为 Auto。
- Question review 的 Submit 操作必须比 muted 帮助文字更醒目；切换模型后所有可见模型身份必须刷新。
- Pi family 保持同版本升级；模型目录通过有界 remote catalog refresh 独立更新。

## Cycle 决定

- 新建 C13 并关闭 C12；C13 选择性继承事实和已接受基线，不继承 C12 任务列表。
- Composer 采用 0.6.2 圆角 hybrid：Pi Editor 继续拥有输入、IME、autocomplete、滚动和文本语义；VSPi 保留圆角外框与产品语义。
- S2 实机反馈构成拒绝；旧 M2/M3/M4 完成声明回退，同一 ID 顺序内修订后重新验收。

## 技术事实

- VSPi 已实例化 Pi Editor，但当前 Composer 会切掉官方上下边框、读取 private state、扫描渲染后的 cursor marker/ANSI，并重画四边框。
- Pi 0.84.2 暴露 `getCursor()`，内部拥有 word-wrap、scroll、IME cursor marker 与 autocomplete 布局；模型 runtime 也提供 catalog refresh coordination/snapshot 能力。
- Pi 0.84.2 的水平左移仍无条件建立完整 visual-line map，并把光标前全文 materialize 为 grapheme 数组；10K 字符临时原型只优化这一步即可取得约 2.75x 提升。
- 同时缓存 grapheme boundaries 与 word-wrap chunks 后，10K 字符左移+重绘临时原型从 1494.1ms 降到 7.1ms；正式补丁必须补齐 paste/emoji/vertical/autocomplete 契约。
- 当前模型初始化会并行调用两次 `getAvailable()`；模型面板每帧会重复过滤和排序。
- 新 freeze 的实机快照显示 CPU、内存和 IO 均无压力，异常进程无外网连接，却与前台 shell 形成异常 PTY/process-group 状态；当前证据不支持把它直接归为 Editor O(N) 热循环。

## 2026-08-16 拒绝与根因纠正

- 用户明确说明 v0.6.4 中左键后光标完全不发生可见移动，只有继续输入字符才刷新；这不是“移动耗时”问题。
- 根因是 VSPi 跨帧整页 cache：Pi Editor 内部 cursor 已移动，官方 TUI 也请求 immediate frame，但 app 以未变化的 `renderRevision` 返回旧 body/dock。
- 旧 64ms/1–2ms 基准仅证明裸 Editor 或事件路径执行快，没有证明 fullscreen 可见帧变化；M2 的产品验收因此无效。
- freeze 目前是 shutdown/watchdog/thinking 截断加固，不再表述为请求级 runtime 根因已经完整修复。

## 当前未决问题

- 完成重开的 M3/M4 后重新进入 S2；当前需修复 `/model` 自适应高度、OpenCode Go 模型可见性和 model→Effort 连续选择。

## 2026-08-15 实现轮结论

- M2 completed：Pi Editor 0.84.2 narrow compatibility patch（grapheme/折行缓存 + 水平移动优化）经 `postinstall` 应用到两份 pi-tui 安装，fail closed 且可整体删除；10K/120 左移+重绘回归 64ms。
- freeze 加固 completed：TUI 先停再 dispose（10s 超时）、launcher parent-death watchdog（`VSPi_NO_PARENT_WATCHDOG=1` 关闭）、thinking 渲染端 200K 截断（完整数据保留）。
- M3 completed：pi 0.84.2、GLM-5.3 等 curated 可见性、availability refresh 合并、模型排序缓存、0.6.2 Unicode 视觉基线恢复；全量 859 测试、check、build、audit、pack+install+smoke 通过。

## 2026-08-16 复测与 Gemini 配置

- v0.6.4 已全局安装（Volta store，`vspi --version` = 0.6.4），两份 pi-tui 0.84.2 的 Editor patch 均确认生效。
- PTY 实测：2K/10K 文本 120 次左移 1–2ms，UI 持续响应；300 消息 + 10K 输入全屏帧 1.53ms/帧。补丁在真实运行路径生效。
- 用户实机反馈“光标效果毫无变化”，与自动化测量不一致；需区分“编辑器光标卡顿”（已被补丁消除）与“运行数分钟后整机 freeze”（incident 根因链，当前仅完成 shutdown/watchdog/截断加固，未实现运行时请求级修复）。
- AIMoniker Gemini 已配置：`custom-gemini-via-aimoniker-32efcb06`（openai-completions，8 模型），key 仅存于 `~/.pi/agent/models.json` 与来源 yaml。

## Discussion Ledger

### 2026-08-16 - 自适应面板横向修订

> /model 虽然在高终端拿到最多 16 行预算，但 renderer 硬编码只画 6 行。——搞定之后看看还有无类似的问题，也一起解决掉~

### 2026-08-16 - 第三轮 S2 接受与 1.0 探索

> 接受并关闭 C13
>
> 主要是我有点想把这个发布为 1.0.0 到 GitHub 上给大家用。还有无细节要调整？比如 vspi init 这个语义，我感觉不是只有第一次才能用啊，然后那个界面也没有搜索什么的？还有什么正式发布之前要完善的吗？文档？

用户接受 C13 最终结果。1.0/GitHub、`vspi init` 语义、搜索与公共发布文档属于后续独立范围，不扩张已关闭 Cycle。
