---
name: ci-raw-data-collector
description: Use when CI efficiency or drilldown reports need missing, stale, or incomplete workflow/job/step data. Collect GitHub Actions raw runs and jobs into the PostgreSQL database started by Docker Compose, then verify coverage before handing off to report skills. Trigger on requests to collect/backfill CI raw data, fill the local CI database, repair missing jobs, or prepare data for CI efficiency analysis.
---

# CI Raw Data Collector

把 GitHub Actions 的 **raw runs/jobs/steps** 写入 Docker Compose 启动的 PostgreSQL，供 CI 效率报告和 drilldown skill 读取。这个 skill 只负责采集和完整性检查，不生成报告、不重建 PR 指标。

## 目标

完成后必须同时满足：

1. PostgreSQL 服务可连接，schema 已迁移。
2. 指定仓库和日期窗口的 runs/jobs 已采集；需要步骤分析时 steps 也已采集。
3. 对每个目标仓库输出 runs、jobs、steps 覆盖计数和缺口原因。
4. 若报告需要 PR 指标，明确提示后续运行 `npm run rebuild:pr-artifacts`；不要把 raw collection 冒充 PR artifact rebuild。

## 先确认范围

从用户请求解析：

- `owner/repo` 列表；优先使用 `etl/repos.yaml` 中的精确名称。
- 绝对日期窗口；“最近 N 天”先固定为执行时的起止日期并在结果中写明。
- 是否需要 steps。默认采集 runs/jobs；下钻 step 分析需要完整 steps。
- 是否只修复缺口，还是回填整个保留窗口。

窄窗口优先。只有用户明确要求历史回填，或保留窗口最早日期缺失，才使用 full backfill。

## 数据库启动与连接

先定位 compose 文件并确认服务名：

```bash
docker compose config --services
docker compose up -d postgres
```

若服务名不是 `postgres`，使用 `docker compose config --services` 的实际 PostgreSQL 服务名。等待健康检查后再继续：

```bash
docker compose ps
```

本项目默认连接通常是：

```bash
export PG_DATABASE_URL='postgresql://action_insight:action_insight@localhost:5433/action_insight'
```

以仓库 `.env`、compose 配置和当前运行状态为准；不得把密码写入 skill、日志或提交。若连接串已在环境中，优先复用 `PG_DATABASE_URL`。

若 schema 尚未存在，按仓库维护入口执行：

```bash
npm run migrate:supabase
```

迁移失败时停止，不向空库采集，也不伪造“采集成功”。

## 采集 raw runs/jobs

需要 GitHub token。可使用两个独立账号的 token 来源：

- `@gh-token.txt`：读取 `/home/lcr/action-insight/gh-token.txt`，只放入环境变量，不打印内容；
- `gh auth token`：通过 GitHub CLI 获取当前登录账号 token，只放入环境变量，不打印内容。

两者属于不同账号时，可以并行分摊不同仓库的 GitHub API 请求。不要让两个账号同时采集同一个仓库，也不要把 token 写入命令行日志、文件或提交。

```bash
export GITHUB_TOKEN_FILE="$(tr -d '\r\n' < /home/lcr/action-insight/gh-token.txt)"
export GITHUB_TOKEN_GH="$(gh auth token)"
```

若只使用一个来源：

```bash
export GITHUB_TOKEN="${GITHUB_TOKEN_FILE:?GITHUB_TOKEN is required}"
# 或： export GITHUB_TOKEN="$GITHUB_TOKEN_GH"
```

先查看 CLI，避免使用过时参数：

```bash
npx tsx etl/scripts/collect.ts --help
```

常规窄窗口采集：

```bash
PG_DATABASE_URL="$PG_DATABASE_URL" \
GITHUB_TOKEN="$GITHUB_TOKEN" \
npx tsx etl/scripts/collect.ts --repo owner/repo --days N --reverse
```

多个仓库可按 token 分组并行执行；每个仓库只由一个账号负责：

```bash
GITHUB_TOKEN="$GITHUB_TOKEN_FILE" npx tsx etl/scripts/collect.ts --repo owner/repo --days N --reverse &
GITHUB_TOKEN="$GITHUB_TOKEN_GH"   npx tsx etl/scripts/collect.ts --repo another/repo --days N --reverse &
wait
```

并行前先确认：仓库集合不重叠、两个进程写入同一个 PostgreSQL schema、失败可按仓库单独重试。若 API 限流或数据库写入出现冲突，降级为逐仓库执行；不要盲目增加并发。

约束：

- `--skip-jobs` 只适用于明确只要 workflow runs 的场景；效率和 drilldown 数据不要使用它。
- `--reverse` 是最新数据优先的默认安全选择。
- `--force-full-backfill` 仅用于重建保留窗口，不用于普通缺口修复。
- 不要无范围重复调用 GitHub API；失败后先看错误和数据库覆盖，再决定是否重试。

## 修复 jobs/steps 缺口

当已有 runs 但 jobs 缺失，使用仓库提供的缺口修复入口（若本仓库版本存在）：

```bash
PG_DATABASE_URL="$PG_DATABASE_URL" GITHUB_TOKEN="$GITHUB_TOKEN" \
npx tsx etl/scripts/backfill-missing-jobs.ts \
  --days N --repo owner/repo
```

raw runs 已存在但 PR 相关产物缺失时，另行执行：

```bash
PG_DATABASE_URL="$PG_DATABASE_URL" GITHUB_TOKEN="$GITHUB_TOKEN" \
npm run rebuild:pr-artifacts -- \
  --repo owner/repo --start-date YYYY-MM-DD --end-date YYYY-MM-DD
```

这一步属于 PR artifact rebuild，不属于 raw collector；最终报告必须分别列出两步状态。

## 完整性检查

优先用 `psql` 在同一个 compose 网络/服务中查询；若宿主机端口可用，也可使用 `PG_DATABASE_URL`：

```bash
docker compose exec -T postgres psql \
  -U action_insight -d action_insight -P pager=off -F '|' -At <<'SQL'
SELECT r.owner || '/' || r.repo AS repo,
       count(DISTINCT runs.id) AS runs,
       count(DISTINCT jobs.id) AS jobs,
       count(steps.job_id) AS steps
FROM repos r
LEFT JOIN runs ON runs.repo_id = r.id
LEFT JOIN jobs ON jobs.run_id = runs.id
LEFT JOIN steps ON steps.job_id = jobs.id
GROUP BY r.owner, r.repo
ORDER BY repo;
SQL
```

对指定日期窗口至少检查：

- runs 数量；
- completed runs 中非取消/跳过 runs 的 jobs 数量；
- 成功且超过 10 分钟的 runs 是否有 steps；
- workflow 是否存在“有 run、无 job”的缺口；
- 采集日期是否覆盖请求窗口。

发现 genuine job gap 时，最多重跑缺口修复 3 次；仍有缺口就停止并报告具体 repo、日期和数量。

## 交付给报告 skill

返回一份简短数据契约：

```text
source: local PostgreSQL via Docker Compose
window: YYYY-MM-DD..YYYY-MM-DD
repos: owner/repo, ...
runs/jobs/steps: per-repo counts
collection: complete | partial
missing: exact repo/date/metric and reason
next: report command or rebuild-pr-artifacts still required
```

只有 `collection=complete` 且字段覆盖满足报告需求时，才把任务交给 CI efficiency/drilldown skill。部分数据必须明确标记为 partial。

## 完成标准

- `docker compose ps` 显示数据库可用。
- 采集命令已实际执行并成功返回。
- 完整性 SQL 已执行；结果包含每个目标仓库的 runs/jobs/steps 计数。
- 未打印任何 token 或密码。
- 最终说明是否仍需 PR artifact rebuild，以及报告可安全使用的日期窗口。
