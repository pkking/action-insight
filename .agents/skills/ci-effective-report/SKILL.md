---
name: ci-effective-report
description: 使用 Action Insight 本地 PostgreSQL 数据生成多个 GitHub 项目的 CI 效率对比 Excel 和 HTML 报告。用户提到 CI 效率、CI 耗时、项目对比、workflow 排队或执行耗时时使用；不调用 GitHub API。
---

# CI Effective Report

从本仓库本地 PostgreSQL 的 `repos`、`runs`、`jobs`、`steps`、`pr_metrics`、`pr_workflows` 表生成多项目 CI 对比报告。

## 执行

默认读取仓库根目录 `.github-ci-efficiency.yaml`，数据库连接依次取 `--pg-url`、`PG_DATABASE_URL`、仓库 `.env`，最后使用本地 Docker 默认地址。

```bash
cd .agents/skills/ci-effective-report
uv run scripts/ci_analyze.py --from 2026-07-01 --to 2026-07-31
```

临时选择项目或 workflow：

```bash
uv run scripts/ci_analyze.py \
  --repo vllm-project/vllm-ascend \
  --workflow E2E \
  --from 2026-07-01 --to 2026-07-31
```

常用参数：

- `--config PATH`：项目/workflow 对比配置。
- `--repo OWNER/REPO`：可重复；覆盖配置中的项目集合。
- `--workflow NAME`：可重复；覆盖所选项目的配置 workflow。
- `--list-repos`：列出本地 PostgreSQL 已采集项目。
- `--skip-steps`：跳过 step，缩短大范围查询时间。
- `--no-excel` / `--no-drilldown`：按需关闭输出。

## 数据规则

- 只使用本地 PostgreSQL，不回退 GitHub API、Turso 或 SQLite。
- 配置优先用 `workflow.file` 稳定匹配，并将动态 `run-name` 归一为配置显示名；未配置 `file` 时才按名称精确匹配。
- 总览每个 workflow 一行，分别显示总 Run、成功 Run、有效成功 Run；E2E 使用有效成功 runs，排队使用该 workflow 的成功 jobs（即使整个 run 最终失败）。
- **空值诊断步骤（必做）**：生成后扫描总览的 E2E/排队列。任何空值都必须在同一行 `空值判断依据` 中写明可核验计数，例如窗口内无 Run、成功 Run=0、Jobs=0、成功 Jobs=0，或时间戳缺失；最终回复同时概括这些依据，禁止只写“无数据”。
- 多项目报告包含仓库对比，以及每个项目的 workflow/job/step/PR 统计。
- 用户给出相对日期时，执行前先明确解析后的绝对日期。
- 数据为空或时间覆盖不足时明确报告，不伪装成完整结果。
