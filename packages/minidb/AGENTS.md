# minidb：给改这个包的 Agent 看

kap-server 搜索索引背后的嵌入式 JSON 文档存储。持久化由 snapshot 和 WAL 组成，写入锁是排他的；抢不到锁的实例只读打开，并从 WAL 追赶。`OpenOptions.onLockAcquired` 在拿到锁后、恢复工作开始前返回锁 token；worker 线程和宿主进程共用 pid，所以只看锁文件里的 pid 无法判断过期锁。

## 全文索引

- `src/text-index/` 是倒排索引：内存字典加 delta，磁盘 postings 在 `src/text-postings.ts`。`index.ts` 的 `TextIndex` 核心周围拆出 `tokenize.ts`、`types.ts`、`builder.ts` 和 `image.ts`。
- `tokenizer` / `queryTokenizer` 可注入。默认 tokenizer 保留 ASCII 单词和 CJK 单字、双字；`src/trigram.ts` 提供带哈希的 2/3-gram tokenizer（NFKC、小写、按码点开窗），支撑精确子串搜索。
- 文本索引定义（包括 tokenizer 名称）持久化在 `db.textindexes.json`。

## 索引代与回退

- 派生状态（store image、各二级和复合索引、文本字典、postings、doc table）按持久化代 checkpoint：`generations/g-NNNNNN/` 加 `CURRENT`，格式 v1。`src/generation.ts` 管布局和 manifest，`src/gen-codec.ts` 管二进制 image。
- 写入方先在 `g-N.tmp-*` 目录构建，再用 rename 和 CURRENT 交换原子发布，关键路径执行 fsync。每次 compaction 的轮换和代发布属于同一个事务。
- 打开时加载已发布的代并回放 WAL delta，不重新解码每个值、不重新分词、不重写 postings。代缺失、损坏或版本未知时自动走完整恢复；`OpenOptions.indexGenerations: false` 强制走回退路径。
- 回退路径上，全量文本重建不阻塞 `open()`：它在恢复 checkpoint 固定的有界引擎上作为 `'text-build'` 维护任务运行；`OpenOptions.deferOpenTextBuilds: false` 是回滚开关。索引尚未提交时搜索抛 `TextIndexBuildingError`，状态通过 `MiniDb.textIndexBuilding` 暴露。这个守卫是独立的 `basePending` 标志，在旧 base 上做 staged build 时仍可继续服务。
- 只读打开者在 db 目录旁的私有 scratch 目录构建，关闭时删除，不聚合完整的内存 base。异步 base 读取通过 `TextIndex.baseEpoch` 保证提交安全：跨提交的读取会从新 base 重读，不缓存旧列表。
- 健康写入方在运行时保留一个有效代：每次写入检查 WAL 增长（`MiniDb.maybeAutoGenerationBuild`，4 MiB 陈旧阈值，失败退避节流）；`close()` 会尽力发布缺失或陈旧的代（`buildGeneration('close')`）。

## 维护与 worker

- 重维护任务统一走维护调度器（`src/maintenance.ts`）：每个库同时只跑一个重任务，带队列背压、磁盘空间预检、deadline 和取消、关闭时排空或取消。嵌套提交在任务内通过 AsyncLocalStorage 同步执行，避免自锁。
- 全文代产物由 worker 在主线程外生成：分词 → 有界内存聚合 → 分段外部归并 → postings / 字典 / base-docs。宿主是 `src/worker/text-build.ts` 和 `text-build-worker.ts`，核心在 `src/worker/text-build-core.ts`。
- worker 使用 Node 原生类型剥离，`execArgv: ['--experimental-transform-types']`，整个 worker 闭包里的 import 都写显式 `.ts` 后缀。worker 只写 tmp 代目录，主线程做完整性和流式 crc 校验，再通过 `TextIndex.commitRebase` 交换 live base。
- `OpenOptions.textBuildWorker: false` 是回滚开关。worker 文件缺失时，同一个有界核心在主线程内联运行；worker slot 紧张时先按进程级配额排队（`WorkerSlots.acquireBounded`，上限由 `MiniDb.textBuildSlotWaitMs` 控制，默认 30 秒，支持中断），持续拿不到 slot 才内联作为最后手段。
- 线程内 staged 聚合只保留给小语料（少于 4096 文档）、自定义函数 tokenizer 和显式回滚。`MiniDb.boundedTextBuild` 同时支撑首次建索引和打开时对损坏或定义不匹配代的重建。
- 打开过程的生命周期和耗时统计在 `LifecycleTracker`（`src/lifecycle-status.ts`），由 `lifecycle.ts`、`generation-loader.ts`、`recovery.ts` 写入，通过 `MiniDb.lifecycleStatus()` 读取。`bench/open-lifecycle.ts`（`pnpm bench:open`）是四条打开路径的事件循环延迟和输入延迟基线。

## 异步读取

- 异步读取面是增量的：`getAsync`、`searchAsync`、`searchBoundedAsync`、`queryAsync`。postings 解码缓存按字节设上限（`TextIndexOptions.cacheBytes`）。
- 恢复扫描使用异步顺序扫描器（`scanFrameRefsFdAsync`）：窗口读取、分片 CRC、周期让出、AbortSignal，并与同步扫描器共享有界损坏重同步预算。
- compaction 的磁盘快照按 (file, offset) 分组，用有界并发定位读取。只读副本的 WAL 追赶（`MiniDb.catchUpFromWal`）也走同一异步扫描器，按原语操作数和墙钟预算让出；同一实例的追赶串行化，不会在中途交错。
