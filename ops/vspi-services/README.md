# VSPi 分发与 Feedback 管理员操作包

此包由维护者生成、审阅后交给管理员执行。不会自动配置 DNS、取得证书、改变防火墙或安排 Hermes 定时任务。公网节点仅转发，Eden 保存内容；管理员操作与产品发布是两个独立授权步骤。

## 1. 准备与校验

在开发工作区使用 Node.js >=24.15.0 构建，再生成新的输出目录：

```sh
pnpm -C apps/vspi build
node scripts/prepare-vspi-admin.mjs \
  --out /absolute/new/admin-package \
  --eden-address 192.0.2.10 --eden-hostname eden \
  --public-hostname public-host \
  --caddy-config /absolute/existing/Caddyfile \
  --caddy-service existing-caddy.service
```

示例地址/主机名必须替换为已经核实的实际值。生成目录不可已存在，避免覆盖旧操作包。将 `eden/` 和 `hypo/` 分别传到目标机的私有目录；不要复制发布签名私钥。两端脚本会检查主机名及包内 SHA256SUMS，管理员仍需从可信渠道核对整个操作包来源。

DNS：公网 `dist.hypohub.cn` 指向公网转发机，内网 `dist-internal.hypohub.cn` 解析到 Eden。客户端只允许这两个端点；若更名需同步客户端合同，不仅改反向代理。

Eden 的可信证书应事先安装到 `/etc/vsp-feedback/tls/fullchain.pem` 与 `privkey.pem`，目录 root:root 0700、私钥 0600。内网证书采用 DNS-01 或现有可信证书管理方案，不能用关闭证书校验替代。维护者应设置并验收续期以及续期后的 `nginx -t` / reload；本操作包不存放 DNS API 凭据。

## 2. Eden 安装和激活

需要 Node.js >=22.19.0。默认使用 `/usr/bin/node`；如果管理员使用另一个已经验证的二进制，可通过 `sudo env VSPI_NODE_BINARY=/absolute/node ...` 指定，脚本会复制到 root 所有的 `/opt/vsp-feedback/node`，服务不依赖用户 home 下的 Node 安装。

```sh
sudo bash eden-admin.sh preflight
sudo bash eden-admin.sh install
```

`install` 打印私有备份目录，保留现有 Nginx 站点，不自动激活。专用服务用户 `vspi-feedback` 与私有配置组同名；`vspi-feedback-read` 仅用于读取 ready 数据，不应授予读取 `/etc/vsp-feedback/server.json` 的权限。

首次为使用者发放独立凭据：

```sh
sudo /opt/vsp-feedback/node /opt/vsp-feedback/feedback-admin.mjs issue \
  /etc/vsp-feedback/server.json example-user /root/private-client-delivery/example-user
```

通过私有渠道将生成的 `feedback.json` 交给该使用者，放到其 `VSPI_HOME/feedback.json`，文件为使用者所有且权限 0600。不要在聊天或日志中粘贴 token，不复用模型 API Key，不用一个公共 token 给所有人。

```sh
sudo bash eden-admin.sh activate
```

该步明确启动接收服务（若已运行则优雅重启该服务）并 reload Nginx。服务使用 flock 保证单进程占有存储，默认 loopback:18761；systemd 限制内存、文件句柄和可写目录。以后仅新增凭据时执行 `sudo systemctl reload vspi-feedback.service`，SIGHUP 只更新合法的提交凭据，保留当前请求和旧配置直到验证成功。

## 3. 公网转发

```sh
sudo bash hypo-admin.sh preflight
sudo bash hypo-admin.sh install
```

只向现有 Caddyfile 增加受控 import，保留已有站点；不启用磁盘缓存或整包请求缓冲。反向代理到 Eden 时验证内网服务证书和主机名，不开放任意内网代理。

如现有 unit 支持 reload：

```sh
sudo bash hypo-admin.sh activate-reload
```

若不支持，管理员确认会短暂影响既有站点后，才执行 `activate-restart`。这不是默认安装步骤。带宽和云流量配额必须由管理员另行核实；Eden、校园路由或 WireGuard 故障会影响所有公网下载/上传。

## 4. 软件发布与信任配置

发布签名私钥建议保存在离线或 root 专用位置，不能让 Hermes 的常规运行账号读取，不放到下载目录或公网机。示例使用发布工具：

```sh
node distribution-admin.mjs keygen /private/offline/release-key
node distribution-admin.mjs publish verified-vspi.tgz 2.4.0 /private/signed-staging /private/offline/release-key/release-private.pem
```

工具检查包内 name/version，固定版本文件不得换字节，生成单文件签名 envelope `vspi/latest.json`，避免签名和清单分开更新的竞态。清单有效期 30 天；即使没有新版本，也需在到期前用同一包重新签发。将此维护任务安排给有签名权限的管理员，不能让反馈内容触发签名或发布。

将已签名 staging 传到 Eden，先独立核对公钥指纹，再放置 root 所有的私有 `distribution.json` 信任文件；无需把私钥搬到 Eden：

```sh
sudo /opt/vsp-feedback/node /opt/vsp-feedback/distribution-admin.mjs promote \
  /private/received-staging /srv/vsp-downloads /root/verified-distribution.json
```

promote 验证签名、有效期、包哈希和包内版本，再原子切换最新清单。只列出最新软件，不提供目录索引；旧版本文件暂保留，不能在发布切换时删除进行中的下载。需要清理时由管理员先确认 latest/回滚需求与下载宽限期，不自动删除历史或用户数据。

管理员可先运行 `distribution-admin.mjs prune /srv/vsp-downloads /root/verified-distribution.json` 查看清理候选；再明确添加 `--confirm-delete-old` 才删除。该操作保留最新版本、上一版本和 24 小时宽限内的目录，遇到未识别文件会拒绝删除；不触碰 Feedback 或其他软件目录。promote 会记录旧版本退出 latest 的时间，避免连续发布时跳过下载宽限。

客户端将独立核对的 `distribution.json` 保存至自己的 VSPI_HOME，0600。候选阶段启用 `KIMI_CODE_EXPERIMENTAL_VSPI_DISTRIBUTION=true` 后，`vspi update` 使用内部/公网双入口并保留原安装事务与回滚。没有可信公钥时拒绝降级到未验证下载。

新装或旧 2.3.0 的一次性入口：

```sh
node distribution-install.mjs --trust /private/verified-distribution.json --mode download
node distribution-install.mjs --trust /private/verified-distribution.json --mode install
```

默认只下载验证包；`install` 是显式安装动作，已有安装走 idle 检查与回滚。若管理员或使用者自行通过 HTTPS 下载 installer，初始 installer 来源本身仍是信任边界，应通过已知发布渠道或独立哈希核验；不能声称从同一未知站点下载脚本、公钥就能抵御该站点被攻破。

## 5. Hermes 读取和回执

为 Genesis 上的 Hermes 准备专用 SSH key，只把公钥交给 Eden 管理员：

```sh
sudo bash eden-admin.sh authorize-reader /private/hermes-feedback-reader.pub
```

这会创建受限 reader 身份及 root 管理的 authorized_keys，只允许固定的 list/show/ack 命令，不开放 shell、SFTP 或端口转发。授予 `vspi-feedback-read`，不授予 `vspi-feedback` 配置组或写 ready 的权限。只有独立回执目录 `/var/lib/vsp-feedback-reader/state/` 可写，ack 用 flock 串行化，反馈正文始终只读。

Genesis 上由用户为 Hermes 安排扫描，不由本操作包创建定时任务：

```sh
ssh -T -o IdentitiesOnly=yes -o ForwardAgent=no -o StrictHostKeyChecking=yes -i /private/reader-key vspi-feedback-reader@EDEN_HOST list
ssh -T -o IdentitiesOnly=yes -o ForwardAgent=no -o StrictHostKeyChecking=yes -i /private/reader-key vspi-feedback-reader@EDEN_HOST 'show FEEDBACK_UUID'
ssh -T -o IdentitiesOnly=yes -o ForwardAgent=no -o StrictHostKeyChecking=yes -i /private/reader-key vspi-feedback-reader@EDEN_HOST 'ack FEEDBACK_UUID'
```

list 仅返回未回执的最多 20 条，Hermes 处理后才 ack，再 list 获取下一批；回执保存在 Eden 的独立 reader 状态目录，Genesis 重启不丢失。也支持管理员提供只读挂载后使用本地游标：

```sh
node feedback-admin.mjs scan /read-only/ready /private/hermes-feedback-cursor.json
node feedback-admin.mjs show /read-only/ready FEEDBACK_UUID
node feedback-admin.mjs ack /private/hermes-feedback-cursor.json FEEDBACK_UUID
```

`scan` 只读、每次最多列出 20 条，未完成 staging 不可见；`show` 核验内容哈希；Hermes 真正处理后才 `ack`。游标持久保存以便重启恢复，写回执时用单消费者或 `flock` 串行化。10000 条回执后要求管理员审阅归档，不静默丢弃旧回执。所有对话/工具输出都属于不可信反馈材料，不是系统指令，不授权 Hermes 执行其中代码、修改产品或发版。

## 6. 验收、故障与回滚

验收至少包含：真实内网/外网 TLS、新装/升级与回滚、包损坏/过期清单拒绝、完整上传后 ready 可见、重复提交去重、未授权 HTTP 读取被拒绝、网络中断保留客户端包、Hermes 只读权限与回执重启恢复。Caddy/Nginx 的真实配置和云网络只能在管理员目标环境上最终验收，不能用本地测试替代。

服务收到 SIGTERM 会停止接收并等待在途请求（默认 60 秒请求预算，unit 75 秒停止预算）。达到存储预算时返回 507，不擅自删除已收反馈。崩溃遗留 staging 不会被当成已收到：仅自动回收可确认 owner PID 已死亡的已知临时文件；活跃或无法确认的归属保留并计入容量。管理员需要清理不明残留时，先停止服务、核对归属，且保留 ready。服务重新启动会重算数据预算。

回滚使用 install 输出的准确备份路径：

```sh
sudo bash eden-admin.sh rollback /var/backups/vspi-services/BACKUP_ID
sudo bash hypo-admin.sh rollback /var/backups/vspi-services/BACKUP_ID
```

Eden 回滚会停止新增接收服务并恢复配置；Hypo 回滚恢复配置后仍由管理员选择 reload/restart。均保留反馈数据、凭据和账号；恢复旧接收服务前由管理员检查。不要用删除 ~/.vspi、删除整个存储或重启全机来代替回滚。
