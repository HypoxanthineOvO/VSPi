---
kind: cycle-summary
cycle: C12-release-train
status: closed
updated: 2026-08-15T17:41:14+08:00
---

# VSPi v0.6.x Release Train 摘要

## 目的与边界

将 v0.3.11 后的能力形成可安装、可审计的 GitLab Release，并完成 Windows 安装交付；发布渠道不包含公共 npm registry。

## 最终结果

- v0.6.0、v0.6.1 与 v0.6.2 均完成 main/tag pipeline、GitLab Release、匿名资产下载和 clean install 复验。
- v0.6.1 修复 Windows named-pipe session lease；v0.6.2 修复 fullscreen 历史权威、Auto Policy 切换和模型排序。
- 后续 v0.6.3 包含有效的 regular history/render 与 Provider compatibility 修复，但其全局窄字符替换、开屏退化和模型列表卡顿未通过 Windows 最终验收。
- C12 以“发布列车结束、最新结果未接受”关闭；未解决问题转入 C13，不把未验证结果伪装成成功。

## 验证证据

- v0.6.0 main/tag pipelines #348/#349；v0.6.1 #351/#352；v0.6.2 #368/#369 全绿。
- v0.6.2 公开资产 SHA-256 `a3400a01e34a4c76051cce68625a832afdf297675a0269ca79cbc9ff3fd606ad`，latest/pinned 字节一致，clean install 与 Fixture smoke 为 0.6.2。
- 0.6.3 Windows 用户验收明确拒绝，作为 C13 的来源证据保留。

## 重要决定与经验

- Corrective release 必须隔离内容边界，不能把未归属改动混入 tag。
- 终端宽度问题不能通过无差别 ASCII 替换改变已批准视觉；应先定位输入/布局热路径和 upstream 能力。
- 长期 Release Train 不再承载新的组件所有权讨论；后续修复使用全新 Cycle 与任务列表。

## 后续候选

- C13 选择性继承 0.6.2 UI 基线、0.6.3 有效非视觉修复、Windows 光标左移卡死反馈和模型目录更新需求。
