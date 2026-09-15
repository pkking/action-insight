---
name: ci-effective-report
description: 使用 Action Insight 本地 PostgreSQL 数据生成 CI 对比、管理月报和每日诊断 Excel/HTML 报告；绝不调用 GitHub API。
---

# CI Effective Report

唯一的报告出口。只读本地 PostgreSQL 的 `repos`、`runs`、`workflow_attempts`、`workflow_jobs`、`workflow_steps`、`pr_metrics` 与 `pr_workflow_attempts`（attempt 级 PR 链接，rerun 在 PR 计数中可见；run 级 `pr_workflows` 仅在无 attempt 链接时回退）；旧 `jobs`/`steps` 仅作历史回退。队列指标固定为 job `created_at → started_at`，不以 run 创建时间代替。

## 数据不足时

报告技能不得补采或调用 GitHub API。窗口缺少 runs/jobs/steps 时，先使用 `ci-raw-data-collector` 收集并检查覆盖；PR artifact 缺失时使用 `npm run rebuild:pr-artifacts`。`etl/repos.yaml` 是分析目标的唯一来源。

## 执行

```bash
cd .agents/skills/ci-effective-report
uv run scripts/ci_analyze.py --from 2026-07-01 --to 2026-07-31
```

单仓库管理月报：

```bash
uv run scripts/ci_analyze.py \
  --repo vllm-project/vllm-ascend \
  --from 2026-07-01 --to 2026-07-31 \
  --report-mode monthly_summary
```

每日技术诊断：

```bash
uv run scripts/ci_analyze.py \
  --repo vllm-project/vllm-ascend \
  --from 2026-07-31 --to 2026-07-31 \
  --report-mode daily_diagnostic
```

常用参数：

- `--config PATH`、`--repo OWNER/REPO`、`--workflow NAME`：选择已有本地数据。
- `--report-mode monthly_summary|daily_diagnostic`：生成管理摘要或以当前问题为首的日诊断。
- `--skip-steps`：缩短查询，但会在 step 附录中明确没有可用记录。
- `--no-excel` / `--no-drilldown`：关闭相应产物。

## 报告契约

- 报告模式包含 Workflow E2E 四档分布（run 级计数：成功且达到有效阈值的 Run；`<60m`、`60-120m`、`120-240m`、`>240m`）、按总耗时和运行次数排序的 workflow drag、最长 job 与 step 热点。PR 侧 CI E2E 使用 `pr_metrics.ci_duration_seconds` 包络口径（最早 run 创建 → 最晚 run 结束），仅用于 PR 统计，不与 run 级分布混用。
- Excel 必含 `Workflow Raw`、`Job Raw`、`Step Raw`，保存窗口内所有可用 run/job/step 行及可追溯标识；非 PR workflow 也不得遗漏。
- 月报包含 `Management Summary`（核心指标、E2E 四档分布、月度判定与异常清单，空指标带可核验原因）和 `Diagnostic Appendix`；日诊断以 `Current Problems` 开始，并区分高频拖慢项、偶发长尾与待观察项。
- 默认总览中任一 E2E/排队空值必须带同一行的 `空值判断依据`，包含可核验计数；不得只写“无数据”。
- `workflow.file` 优先于显示名，动态 `run-name` 必须归一为配置显示名；`static_resources` 优先于 runner label 推断。
- 测试用例统计由 `etl/scripts/collect-test-case-stats.ts` 统一写入 PostgreSQL；报告不会 clone 仓库或自行计数。
