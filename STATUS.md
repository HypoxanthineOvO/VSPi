# 项目进度：给用户和 Agent 看

只写项目走到哪；产品现在的样子写在需求文件里。

## 现在

VSPi 2.9.0 准备发布。这一版包含：

- Devin 作为订阅 Provider 接入：浏览器登录、复用本机 Devin 凭据、SWE-1.6 模型目录与思考档位。
- 模型选择改为“公司 → 模型 → 来源”：同一模型的多来源合并展示，默认来源跳过最近失败的来源，手动选择的来源会被记住。
- Provider 管理统一 `vspi config` 与 `/providers`：本机凭据一键复用，自定义中转站可自动发现模型或手填模型 ID。

## 下一步

- 在 Linux 工作机跑完整的 `pnpm check:vspi`、`package:pack`、`package:verify` 和打包 daemon 冒烟。
- 按 `apps/vspi/docs/development.md` 的清单发布 2.9.0，并回读发布资产。
- 按实际验收结果更新 `apps/vspi/docs/releases.md` 和发布说明。

## 卡在哪

尚无阻塞。

## 等用户决定

尚无。

## 以后

- 发布后补记 2.9.0 的验收范围。
