# kimi-inspect：给改这个目录的 Agent 看

kap-server `/api/v1/debug` RPC 的 Web 检查器：工作区与会话浏览、单会话聊天、Session 和 Agent 作用域的 Service 面板。

## 界面

- 左侧图标栏 `src/components/NavRail.tsx` 切换顶层视图。
- 会话工作区：`src/components/Sidebar.tsx` 用 `GET /api/v2/sessions?view=by_workspace` 渲染工作区 → 会话树；视图筛选在 `src/sessions/views.ts`，活动状态来自 WebSocket。
- 全局消息搜索：`src/components/SearchView.tsx` 走 `POST /api/v1/search`，`literal` 模式做精确子串匹配并忽略排序；结果上的 `live` / `index` 标记说明数据来自实时会话还是持久索引。
- 模型目录：`src/components/ModelCatalogView.tsx`，通过 `IModelCatalog` / `IModelService` 通道代理展示 Provider、Model 和默认标记，支持单模型 ping 和新建会话。
- App Services、Workspace Services 和 DI 视图：分别展示应用作用域服务、工作区作用域服务和引擎的 Service × Effect × DI 调试面。工作区代理走 `/workspace/:id` 路由，按需通过 `IWorkspaceLifecycleService.handlerFor` 建立 handler。
- Agent 作用域在聊天页右侧栏（Audit / Agent / State / Session）。Session 作用域也在同一右侧栏，展示待处理交互和各 Session Service 的 state。
- 聊天页 `src/components/ChatView.tsx` 从 transcript 接口按轮次读取，不使用上下文内存；支持页内搜索和向上分页。`/api/v1/ws` 只订阅 block 粒度的增量，序号缺口、重连或 `resync_required` 时走点对点补拉，异常时回退整页 REST。
- Transcript 审计面板在右侧 Audit 页签，用 `AuditTrail` 记录每次 REST 分页、WS 帧、丢帧信号和取消动作，并提供时间线、State 和 Diff。

## 约束

- 通道层在 `src/channel/`，按 `agent-core-v2` 的 Service 接口类型化；`GET /api/v1/debug/channels` 返回完整协议，不做白名单。
- 没有 Service 事件推送：面板按需拉取或轮询。连接失败显示不可用页面，不能静默降级到其他地址。
- 会话活动是唯一的推送例外：`src/activity/` 的第二个 `/api/v1/ws` 客户端只消费全局事实；活动状态和 REST 结果冲突时以实时事实为准。
- 开发服务器把 `/api` 代理到 `KIMI_SERVER_URL`（默认 `http://127.0.0.1:58627`），并通过 `GET /__inspect/servers` 扫描本机实例登记目录和 home token。
- 收敛逻辑复用 `@moonshot-ai/transcript` 的 reducer，不在这里重写数据模型。
