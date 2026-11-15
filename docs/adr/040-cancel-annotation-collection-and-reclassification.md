# ADR-040: 取消者 annotation 采集与取消浪费重分类（消除"取消-原因未知"档的显式部分）

日期：2026-11-15　状态：方案已接受（待实施 PR）

## 背景

ADR-039 的浪费账中，`cancelled_unknown`（取消-原因未知）是最大的未解释档：2026-11-14 快照（2026-08-01→11-09，allowlist 内 PR-event NPU 卡时 529,818）中约 **99,676 卡时 / 3,106 attempts** 不计入浪费。消除该档需要回答"是谁取消的"。

已实证的事实（可直接引用）：

1. **GitHub REST 的 run 对象没有"取消者"字段**：`actor` / `triggering_actor` 只记录触发 run 的人（push 的人），不记录取消者。
2. **check-run annotations 里有取消者**：`GET /repos/{owner}/{repo}/check-runs/{check_run_id}/annotations` 对被取消的 job 返回 `[{"message":"The run was canceled by @<login>."}]`；系统自动取消（concurrency cancel-in-progress）**无此 annotation**（返回 `[]`）。
3. **`workflow_jobs.job_id` 就是 check_run id**（可直接拼 annotations URL）。
4. **32 个 run 的抽样**：已知"被新提交替代"（superseded）的 4/4 无 annotation；未知档 28 个 attempt 中 23 个无 annotation（7,354h）、4 个 `github-actions[bot]`（1,097h）、1 个 `sglang-npu-bot`（250h）；未知档同分支 60 分钟内均无新 sha run（0/28）。
5. **用户已拍板口径**：**显式取消（人/bot）都算浪费**，人/bot 分档列出取消者账号；无 annotation 且无替代证据的保持"未知"（大概率基础设施/跨 PR 并发，后续再细分）。

补充的本地库实测（2026-08-01→2026-11-09 固定窗口，allowlist、PR-event、attempt conclusion='cancelled'；只读查询，快照随采集推进略有漂移）：

- 取消 attempt 共 **23,208**（用户更晚快照口径 ~23,902；差异来自窗口末端快照推进，预算按 ~24k 上限取整）。
- **1,480 个 attempt 在 DB 中没有 conclusion='cancelled' 的 job 行**（1,190 个完全无 workflow_jobs 行 + 290 个有 jobs 行但无取消 job）——这些必须走 check-runs 回退路径。
- 取消 attempt 内平均有 5.42 个取消 job（全量口径含零值；零值扣除后约 5.8 个）；按"最多探 2 个"规则，平均探测调用数上限 **1.75 次/attempt**（含 1,480 个零值 attempt）。
- 全部 attempt 的 `runtime_seconds` 与 `runs.head_sha` 均非空（0/23,208 缺失），可安全用于排序与回退。
- 仓库分布：vllm-ascend 9,795、sglang 9,010、triton 1,338、tilelang 1,125、triton-ascend 1,012，其余合计 <950。
- runtime ≥1h 的取消 attempt 4,367 个（全量补采可用 `--min-hours` 大幅剪枝）。

## 目标与非目标

**目标**：

1. 给"取消-原因未知"档中的**显式取消**部分找出取消者（人/bot），将其计入浪费并按取消者账号列出。
2. 采集过程幂等、断点可续、预算可控，符合仓库成本意识纪律（AGENTS.md）。
3. 未采集/无证据的取消 attempt **保持未知，不冒算**。

**非目标**：

- 不消除"未知"档本身：无 annotation 且无替代证据的部分（抽样约占 85% 小时）仍单列为未知，后续按基础设施/跨 PR 并发再细分。
- 不给 superseded/merge_cleanup/duplicate 档重新归因（优先级链固定，见下）。
- 不改动常规 ETL 采集流程（collect.ts 不变）；本采集是一次性补采 + 可重复增量跑的独立脚本。
- 报告技能（`.agents/skills/ci-effective-report`）保持只读、不调 GitHub API——因此采集必须落在 `etl/scripts/`。

## 决策

### 1. 存储：`workflow_attempts` 加取消者证据列

`pg/schema.sql` 是唯一 schema 来源（AGENTS.md 提到的 `supabase/schema.sql` 与 `npm run migrate:supabase` 在本仓库不存在，属文档漂移，见"遗留问题"）。该文件只在容器首次 initdb 时挂载执行（`docker-compose.yml` 将其映射为 `docker-entrypoint-initdb.d/01-schema.sql`），对已存在的本地库（docker `action-insight-postgres-1`，端口 5433）没有自动迁移机制，因此迁移方式为：

- 在 `pg/schema.sql` **文件末尾追加一个 ADR-040 迁移段**，全部语句幂等（文件头部自述 "Idempotent: all statements use IF NOT EXISTS"，新增语句遵循同一惯例用 `ADD COLUMN IF NOT EXISTS` / `CREATE INDEX IF NOT EXISTS`）；
- 对已运行的库直接重放整个文件（对新库是 no-op，对旧库补上增量）：

```sql
-- =====================================================================
-- ADR-040: cancel-actor evidence from check-run annotations.
-- Idempotent migration block: safe to re-apply against live databases
-- (ADD COLUMN IF NOT EXISTS / CREATE INDEX IF NOT EXISTS are no-ops
-- after the first apply). Fresh containers get these via initdb replay
-- of this same file.
-- =====================================================================
ALTER TABLE workflow_attempts ADD COLUMN IF NOT EXISTS cancelled_by TEXT;            -- 取消者 login，NULL=无显式取消者
ALTER TABLE workflow_attempts ADD COLUMN IF NOT EXISTS cancel_evidence TEXT;         -- 'job_annotation' | 'check_run_annotation' | 'none' | 'gone' | 'no_cancelled_check_run'
ALTER TABLE workflow_attempts ADD COLUMN IF NOT EXISTS cancel_message TEXT;         -- 原始 annotation message（审计留档）
ALTER TABLE workflow_attempts ADD COLUMN IF NOT EXISTS cancel_annotation_fetched_at TEXT;  -- ISO 时间戳；NULL=未采集（幂等标记）

-- Collector resume query: pending cancelled attempts by runtime DESC.
CREATE INDEX IF NOT EXISTS idx_workflow_attempts_cancel_pending
  ON workflow_attempts (runtime_seconds DESC)
  WHERE conclusion = 'cancelled' AND cancel_annotation_fetched_at IS NULL;
```

列语义与状态机：

| cancelled_by | cancel_annotation_fetched_at | 含义 |
|---|---|---|
| NULL | NULL | **未采集**（待探测） |
| NULL | 非空 | **已探测、无显式取消者**（evidence='none'=系统取消；'gone'=check run 已不存在；'no_cancelled_check_run'=回退后也没找到取消 check run，是采集缺口信号） |
| 非空 | 非空 | **显式取消**，evidence 记录来源（'job_annotation' / 'check_run_annotation'），cancel_message 留原始文本 |

设计要点：

- 幂等标记就是 `cancel_annotation_fetched_at` 非空；**重复跑零重复 API 调用**。
- `cancel_message` 冗余存原始 message：regex 抽取 login 若有 bug，可离线重算而无需重新调 API（每次 API 调用都是真金白银的配额）。
- **关键不变量**：现有 `workflow-attempt-writes.ts` 的 upsert `ON CONFLICT ... DO UPDATE SET` 列清单不含新列，常规 collect.ts 重跑/回填不会抹掉采集结果。未来任何人改 attempt upsert 时必须保持该不变量（写入本 ADR 的后续约束）。
- 时间戳沿用库内惯例用 `TEXT`（与 `jobs_fetched_at` 等列一致），应用层写 `new Date().toISOString()`。

### 2. 采集脚本：`etl/scripts/collect-cancel-annotations.ts`

TypeScript/tsx，遵循 `collect.ts` 既有惯例，**复用其导出的工具而非复制**：

- **PG 客户端**：`src/lib/db.ts` 的 `getDatabaseClient()` / `query()`（`PG_DATABASE_URL` 默认 `postgresql://action_insight:action_insight@localhost:5433/action_insight`）。
- **token 解析**：per-repo 优先（AGENTS.md 优先级）：
  `GITHUB_TOKEN_PER_REPO_<OWNER>_<REPO>`（key 归一为 `repoKey.toUpperCase().replace(/[^A-Z0-9]/g, '_')`，同 `rebuild-pr-artifacts.ts`）→ `GITHUB_TOKEN_PER_REPO_TRITON_LANG_TRITON_ASCEND`（fallback PAT）→ `resolveGitHubTokens()`（gh-token.txt / `gh auth token` / `GITHUB_TOKEN`）轮询分配。
- **共享配额防超支**：每个去重 token 建 `createOctokit(token)`，再用 `getGitHubIdentity()`（`GET /user`）按身份二次去重、每身份一个 `reserveRateLimitBudget()` 包装客户端（复用 collect.ts 的 `RATE_LIMIT_RESERVE` 预留，默认 10）。共享 fallback PAT 的多个 repo 汇到同一预算客户端上串行消费，不会各自为政打爆 5,000/h。
- **429/二级限流退避**：复用 `isGitHubRateLimitError()`（覆盖 remaining=0、"secondary rate limit"、403+Retry-After）、`getRateLimitDetails()`、`withRetry()`（jitter 指数退避，瞬时错误=5xx/网络/响应形状异常）、`safeErrorDiagnostics()`（日志脱敏）。命中限流 → 抛 `RateLimitAbortError` → **优雅停机**：打印进度与剩余预算，**退出码 3**，重跑即从 `cancel_annotation_fetched_at IS NULL` 续传。
- **断点续采**：以 DB 里的 fetched 标记为准，每处理完一个 attempt 立即单条 `UPDATE`（无长事务窗口），中断/限流后零损失恢复。
- **`--help` / dry-run**：见下方 CLI。

CLI（对齐 `collect-options.ts` 的帮助风格）：

```
Usage: npx tsx etl/scripts/collect-cancel-annotations.ts [options]

Collect cancel-actor evidence for cancelled workflow attempts via
check-run annotations and persist it to workflow_attempts.

Options:
  --repo, -r <owner/repo>     Only process this repo (repeatable).
                              Default: all repos referenced by --attempts-file,
                              or all repos with pending cancelled attempts.
  --attempts-file <path>      JSON artifact from npu_waste_superseded.py
                              (key 'cancelled_unknown_attempts': [{repo,
                              run_id, run_attempt}, ...]). Membership-only;
                              ordering/filtering/idempotency stay in SQL.
                              Omit to scan the full allowlist corpus of
                              cancelled attempts (bounded by DB retention).
  --limit <n>                 Max attempts to process this run (default 500)
  --min-hours <h>             Only attempts with runtime_seconds >= h*3600
                              (default 0)
  --max-api-calls <n>         Hard stop after n GitHub API calls (safety cap)
  --dry-run                   Print per-repo target counts and estimated API
                              calls; no API requests, no DB writes
  -h, --help                  Show this help

Environment:
  PG_DATABASE_URL             PostgreSQL URL (default local Docker 5433)
  GITHUB_TOKEN                / gh-token.txt / gh auth (via resolveGitHubTokens)
  GITHUB_TOKEN_PER_REPO_<OWNER>_<REPO>   Per-repo CI secret, highest priority
  GITHUB_TOKEN_PER_REPO_TRITON_LANG_TRITON_ASCEND  Fallback PAT
  GITHUB_RATE_LIMIT_RESERVE  Budget reserve (default 10, collect.ts semantics)
  CANCEL_FETCH_CONCURRENCY    Per-identity concurrent probes, clamp 1..4 (default 2)
  VERBOSE                     Verbose logging (true/1)
```

**每个 attempt 的处理流程**（按用户已验证的调用顺序）：

1. 从 `workflow_jobs` 取该 attempt 下 `conclusion='cancelled'` 的 job，按 `runtime_seconds DESC` 最多取 **2** 个：
   `SELECT job_id FROM workflow_jobs WHERE run_id=$1 AND run_attempt=$2 AND conclusion='cancelled' ORDER BY runtime_seconds DESC NULLS LAST LIMIT 2`。
2. 依序 `GET /repos/{owner}/{repo}/check-runs/{job_id}/annotations?per_page=100`（全量扫描返回数组中每条的 `message`，匹配 `/run was cancell?ed by @([A-Za-z0-9-]+)\./i`；如单页满 100 条则最多再翻 2 页）。**命中即停**，后续 job 不再探测。
3. **无取消 job 行的 attempt**（实测 1,480/23,208，含完全无 job 行与有 job 行但无取消 job 两种情形）回退：
   `GET /repos/{owner}/{repo}/commits/{head_sha}/check-runs?per_page=100`（分页最多 3 页）→ 过滤 `conclusion='cancelled'` 的 check run，按 `started_at DESC` 最多取 2 个再查 annotations。
4. 落库（每 attempt 一条，天然断点）：

```sql
UPDATE workflow_attempts
SET cancelled_by=$3, cancel_evidence=$4, cancel_message=$5, cancel_annotation_fetched_at=$6
WHERE run_id=$1 AND run_attempt=$2 AND cancel_annotation_fetched_at IS NULL
```

   `cancel_evidence` 取值：`'job_annotation'` / `'check_run_annotation'`（显式取消者）；`'none'`（探测完成、无取消者=系统取消）；`'gone'`（annotations 或 check-runs 返回 404/410，属非失败、幂等完成）；`'no_cancelled_check_run'`（回退后也没找到取消 check run，采集缺口信号，不计失败）。

5. 5xx/网络/形状异常 → `withRetry`（3 次、jitter 指数退避）；404 → 记 `'gone'`；限流 → `RateLimitAbortError` 优雅停机。PG 短暂不可达按 `RETRYABLE_POSTGRES_CODES` 语义重试（复用 `withRetry`）。

**目标选择 SQL**（以 repo 为单位组队列，逐 token 串行/低并发消费）：

```sql
SELECT a.run_id, a.run_attempt, a.runtime_seconds, r.head_sha
FROM workflow_attempts a
JOIN runs r ON r.id = a.run_id
WHERE r.repo_id = $1
  AND r.event = 'pull_request'
  AND a.conclusion = 'cancelled'
  AND a.cancel_annotation_fetched_at IS NULL          -- 幂等/续采
  AND a.runtime_seconds >= $2 * 3600                  -- --min-hours
  [AND JOIN 临时表 cancel_targets(run_id, run_attempt) ON ...]   -- --attempts-file
ORDER BY a.runtime_seconds DESC
LIMIT $3
```

`--attempts-file` 的目标装载进 `CREATE TEMP TABLE cancel_targets` 后批量插入，仅作**成员过滤**，不做排序。

**为什么排序用 SQL 的 `runtime_seconds DESC`，而不用 Python 侧的卡时清单**：

1. **新鲜度**：Python 导出物是分析时刻的快照，而库由常规采集持续推进；把它当排序依据会随时间静默错序。`runtime_seconds` 在 DB 中随 attempt upsert 保持最新（实测 0 缺失），SQL 单点完成"选择 + 过滤 + 排序 + 幂等跳过"，避免清单与 DB 双源真相。
2. **口径纪律**：NPU 卡时是报告侧派生量（`resource_evidence` + `split_hours` + `static_resources`），在 TS 采集器里复刻会造成两套口径漂移（ADR-017/024/039 明令禁止）；`runtime_seconds` 是 attempt 原生列。
3. **相关性足够**：allowlist 内这些 workflow 的卡时由 NPU jobs 主导，attempt runtime 与卡时强相关，作为"最大浪费优先"的优先级代理成立；首批 top 数百个自然覆盖未知档大头。

**目标清单（未知档成员）从哪来**：`npu_waste_superseded.py` 的分析 JSON 增加键 `cancelled_unknown_attempts`（成员清单：`[{repo, run_id, run_attempt}]`，约 3,106 条、~400KB，顺带充当未知档的审计 listing）。分类逻辑只在 Python 一处（避免在 SQL/TS 里复刻 supersede/merge 判定造成口径漂移——ADR-039 的核心纪律）；清单即使过时也只多花无害调用（幂等跳过），不会漏采新出现的未知 attempt——那由"分析 → 采集 → 再分析"的收敛循环解决（见执行序）。

### 3. 优先级与速率预算

**优先级**：**未知档优先**。依据：

- superseded 档抽样 4/4 无 annotation，对它全量探测的增量分类价值≈0（优先级链固定 superseded > explicit_cancel，探测了也不用）；merge_cleanup 同理。
- 未知档是唯一能被 annotation 直接消除的档。

**预算估算**（per-repo token 与共享 5,000/h 两个口径）：

| 方案 | 基数 | 调用模型 | 估算调用 | 单身份（5k/h）墙钟 |
|---|---|---|---|---|
| **未知档全量（采纳）** | 3,106 att | 主路径 1.75 次/att + 回退 ~6.4% ×3 | ≈ 5,300 + 560 ≈ **~5,900** | **≈ 1.2 h** |
| 全量取消 attempt（可选后续） | ~23,902 att | 同上 | ≈ 41,800 + 4,400 ≈ **~46,000** | ≈ **9.2 h** |

- 未知档方案下，若 vllm-ascend / sglang 配了 per-repo token（未知档大头集中在这两个 repo），并行后墙钟可压到 ~30–40 分钟；无 per-repo token 则共享 5k/h ≈ 1.2 小时，一次跑完。
- 全量方案：即便 vllm-ascend（9,795 att ≈ 17k calls ≈ 3.4h）与 sglang 各持独立 token，共享 token 仍要承担其余 ~5,100 att（≈9k calls ≈ 1.8h），总成本 ≈7.5 倍于未知档方案，而预期分类增益≈0。**决策：先采未知档；全量补采仅在后续审计需要"superseded 档附取消者"时，以 `--min-hours 1` 剪枝（23,208 → 4,367 att）后再评估。**
- 硬顶保护：`--max-api-calls` 可设任意上限；`RATE_LIMIT_RESERVE=10` 保证不把配额打空影响常规采集。
- 首批（建议 `--limit 500`）：~900 次调用 ≈ 11 分钟（5k/h），先验证全链路再放量。

### 4. 重分类改造：`npu_waste_superseded.py`

**分类档位**：`CAUSES` 增加 `explicit_cancel_human`、`explicit_cancel_bot`（位于 `merge_cleanup` 之后、`duplicate` 之前）。新优先级链：**superseded > merge_cleanup > explicit_cancel > duplicate > cancelled_unknown > normal**（每段卡时仍只归一个因）。

**读新列**：`fetch()` 的查询 1 增加 `a.cancelled_by, a.cancel_evidence, a.cancel_annotation_fetched_at`，进入 attempt dict：`cancelled_by` 与 `cancel_probed`（fetched_at 非空）。`classify_attempt` 在 superseded / merge_cleanup 均未命中且 attempt 为取消时：

```python
def is_bot_login(login: str) -> bool:
    return login.endswith('[bot]') or login.lower() in BOT_LOGINS

BOT_LOGINS = {'sglang-npu-bot'}   # 显式 bot 清单；采集首批后按 top 列表人工补充

# classify_attempt 内，merge_cleanup 检查之后：
who = att.get('cancelled_by')
if who:
    return ('explicit_cancel_bot' if is_bot_login(who) else 'explicit_cancel_human'), None
```

- bot 判定 = login 以 `[bot]` 结尾（覆盖 `github-actions[bot]`）**或**命中 `BOT_LOGINS` 显式清单（覆盖 `sglang-npu-bot` 这类不带后缀的 bot）。清单常量放在脚本顶部并在 provenance 中输出版本。
- **降级规则（部分采集）**：`cancelled_by` 为 NULL 的取消 attempt 一律保持 `cancelled_unknown`——不区分"未采集"与"探测过但无取消者"，**绝不把未采集冒算为系统取消**。两者在 coverage 计数里分开展示（`probed_no_canceller` / `unprobed`），报告可看到残余未采集量。

**输出改造**：

- 两档计入浪费：`waste = superseded + merge_cleanup + duplicate + explicit_cancel_human + explicit_cancel_bot`（`summary.waste_card_hours`、`waste_share` 随之更新）。
- `summary` 增加 `explicit_cancel_card_hours`（及 human/bot 拆分）；`cancelled_unknown_card_hours` 相应缩小。
- 新增 `explicit_cancel_attempts` listing（含 `canceller` 字段，按卡时降序）。
- 新增 `cancel_cancellers`：`{'human': [{login, hours, attempts}...top10 按卡时], 'bot': [...]}`——满足"人/bot 分档列出取消者账号"。
- `classification_coverage.cancelled_attempts` 增加 `explicit_cancel` / `probed_no_canceller` / `unprobed` 三个计数。
- `provenance.cause_rules` 与 `caveats` 同步更新：`explicit_cancel` 规则文本、优先级链、bot 判定规则、"unprobed 未知不是零"。

**ADR-039 的配套更新**（随实施 PR 一并修改）：

- 决策表增加两行：

| 类别 | 判定 | 计量 |
|---|---|---|
| explicit_cancel_human（显式取消-人） | attempt 取消且 `workflow_attempts.cancelled_by` 非空、非 bot：check-run annotation "The run was canceled by @X."（ADR-040 采集） | 该 attempt 全部已执行 NPU 卡时，计入浪费，按取消者列出 |
| explicit_cancel_bot（显式取消-bot） | 同上，login 以 `[bot]` 结尾或命中 bot 清单 | 同上 |

- 优先级链改为 `superseded > merge_cleanup > explicit_cancel > duplicate`，`cancelled_unknown` 行描述改为"取消且无替代/合并清场/显式取消者证据；**含未采集与系统自动取消**，不计浪费，单列"。
- 证据与验证节追加：annotation 抽样结论（4/4 superseded 无 annotation；未知档 23/28 无、4 个 `github-actions[bot]`、1 个 `sglang-npu-bot`；同分支 60 分钟内无新 sha run 0/28）与本 ADR 的引用。

**规划期影响预估**（实施后以实测替换）：按抽样显式占比 ~18% attempts / ~15.5% 小时外推，未知档约 **~550 attempts / ~1.5 万卡时** 移入浪费（human+bot），未知档缩小到 ~8.5 万卡时。这只是规划估计，不写入结论。

**测试更新**（`tests/test_npu_waste_superseded.py`）：

- `test_explicit_cancel_human`：取消 attempt、`cancelled_by='octocat'`、无 superseder → `explicit_cancel_human`；waste 合计含其卡时。
- `test_explicit_cancel_bot_suffix`：`cancelled_by='github-actions[bot]'` → `explicit_cancel_bot`。
- `test_explicit_cancel_bot_allowlist`：`cancelled_by='sglang-npu-bot'` → `explicit_cancel_bot`。
- `test_priority_over_duplicate`：取消的非 keeper、有取消者 → `explicit_cancel_human`（不是 duplicate）；而 superseded / merge_cleanup 仍压过 explicit_cancel。
- `test_unprobed_stays_unknown`：`cancelled_by=None` → `cancelled_unknown`。
- `analyze()` 聚合测试：`cancel_cancellers` top 列表排序与 human/bot 分档正确。
- 既有用例语义不变（`make_att` 增加 `cancelled_by=None` 默认字段后向后兼容）。

### 5. 本地执行序

实施本身走标准 PR 流程（feature 分支 → PR → 合并，禁止在 main 直接 commit；本 ADR 文件当前落在 `feat/pr-card-hours-coverage-audit` 工作区，**不随本分支 commit/push**，由实施 PR 一并带走）。实施合入后：

```bash
# 0. 分支检查（AGENTS.md Step 0）
git branch --show-current        # 必须是新 feature 分支，不能是 main

# 1. 导出 token 并确认身份与预算
export GITHUB_TOKEN="$(gh auth token)"
gh auth status
# 可选：export GITHUB_TOKEN_PER_REPO_VLLM_PROJECT_VLLM_ASCEND=... / GITHUB_TOKEN_PER_REPO_SGL_PROJECT_SGLANG=...

# 2. 幂等迁移（对已运行库重放整个 schema.sql；对新容器由 initdb 自然覆盖）
docker exec -i action-insight-postgres-1 psql -U action_insight -d action_insight \
  -v ON_ERROR_STOP=1 < pg/schema.sql
docker exec action-insight-postgres-1 psql -U action_insight -d action_insight \
  -c '\d workflow_attempts'      # 验证 4 个新列与部分索引存在

# 3. 生成未知档成员清单（分析脚本新输出的 cancelled_unknown_attempts 键）
(cd .agents/skills/ci-effective-report && uv run scripts/npu_waste_superseded.py)
# 记下 reports/npu-waste-superseded-<snapshot>.json

# 4. dry-run：核对目标数与预计调用量（零 API、零写入）
npx tsx etl/scripts/collect-cancel-annotations.ts --dry-run \
  --attempts-file reports/npu-waste-superseded-<snapshot>.json

# 5. 首批：未知档 top 500（按 runtime DESC；~900 次调用 ≈ 11 分钟 @5k/h）
npx tsx etl/scripts/collect-cancel-annotations.ts \
  --attempts-file reports/npu-waste-superseded-<snapshot>.json --limit 500

# 6. 重跑分析，看 explicit_cancel_* 档、canceller top、unprobed 残余
(cd .agents/skills/ci-effective-report && uv run scripts/npu_waste_superseded.py)

# 7. 收敛循环：重复 3→5（新清单自动排除已升级为 explicit_cancel 的成员；
#    已探测无取消者的成员被 fetched_at 幂等跳过），直至 unprobed≈0、unknown 稳定。
#    之后视预算决定是否 --min-hours 1 做全量补采（可选，默认不做）。

# CI 验证（commit 前本地必须全绿）
npm run lint
npm test                                    # vitest（含新增 collector 单测）
npx tsx etl/scripts/collect-cancel-annotations.ts --help
npm run validate:repos                      # etl-validate.yml 对应的仓库配置校验
(cd .agents/skills/ci-effective-report && uv run pytest tests/test_npu_waste_superseded.py)
```

新增采集脚本本身需配套 vitest 单测（放 `etl/scripts/collect-cancel-annotations.test.ts`，对齐 `backfill-missing-jobs.test.ts` 的做法）：目标 SQL 过滤/排序/幂等跳过、attempts-file 装载、message→login 正则（含 cancelled 拼写变体）、evidence 状态落库、限流优雅停机与退出码。

### 6. 风控与验收

**API 预算上限**：

- 硬顶：`--max-api-calls`；软顶：`RATE_LIMIT_RESERVE`（默认 10）预留 + `RateLimitAbortError` 优雅停机（退出码 3），重跑续传。
- 单次运行默认 `--limit 500`，避免误触全量。
- 与常规采集共用配额：per-repo token 优先可隔离大 repo（vllm-ascend/sglang 占未知档大头）；共享 fallback token 时全部 repo 汇入同一预算客户端串行消费。

**失败重试策略**：

- 瞬时错误（5xx/网络/形状异常）：`withRetry` 3 次 jitter 指数退避（2s 基准）。
- 429/二级限流：`isGitHubRateLimitError` 识别（含 Retry-After/secondary 文案），进入优雅停机而非盲目重试。
- 404/410：不重试，记 `evidence='gone'`（幂等完成，区分于失败）。
- PG 写失败：按 `RETRYABLE_POSTGRES_CODES` 语义重试；逐 attempt 单条 UPDATE，无批量事务丢失窗口。

**部分采集的降级**：

- 未采集（`cancel_annotation_fetched_at` NULL）的取消 attempt 保持 `cancelled_unknown`，**不冒算**；coverage 中 `unprobed` 计数让报告能展示残余量。结论引用时必须带上该计数（沿用 ADR-039 的"未知不是零"约束）。
- `'no_cancelled_check_run'` / `'gone'` 同样保持未知（无取消者证据），但在 evidence 维度可见，供后续排查采集缺口。

**残余风险**：

- annotation 数据保留期：check-run annotations 属 checks 数据，不随 Actions 日志 90 天清理一起消失；窗口内抽样 32/32 端点可用。**残余不确定性**：若 GitHub 对很老的 check run 清理了 annotations，返回 `[]` 将无法区分“系统取消”与“已被清理”，导致 `'none'` 把少量老 attempt 误读为系统取消——该类仍留在 unknown 档、不计浪费，影响仅是 explicit 档的轻微漏计，不会冒算浪费；验收抽样按 attempt 年龄分层核验（见验收标准）。更老的 run 或已删除的 check run → `'gone'` 降级，不冒算。
- fork PR 回退路径：`commits/{head_sha}/check-runs` 依赖 GitHub 在 base repo 命名空间按 sha 记录 check run 的行为；抽样未覆盖 fork 场景，404 时降级为 `'gone'`。
- bot 误判：`-bot` 后缀但实为人的账号风险 → 只认 `[bot]` 后缀 + 显式清单，宁缺勿滥；新发现的 bot 需人工确认后加入 `BOT_LOGINS`。
- 取消者 ≠ 责任人：canceller top 列表仅是记账维度，管理动作前需人工核对（如 bot 代人取消的场景）。

**验收标准**：

1. 幂等性：同一目标清单连续跑 2 次，第二次 API 调用数为 0（全部被 fetched_at 跳过）。
2. 采集覆盖：未知档 `unprobed` 计数收敛到 0（或明确记录放弃的残余及原因）。
3. **抽样人工核验**：随机抽 **N≥20** 个已采集 attempt，分层覆盖各 evidence 值（`job_annotation` / `check_run_annotation` / `none` / `gone`）**并按 attempt 年龄分层**（窗口早期/近期各半，兼验 annotation 保留期风险），用 `gh api repos/{owner}/{repo}/check-runs/{job_id}/annotations` 或 run 页面核对：存储的 `cancelled_by`/`cancel_evidence` 与 GitHub 实际一致；分析输出中对应档位（human/bot/unknown）分类一致。
4. 账目守恒：重跑分析后 `waste_card_hours = superseded + merge_cleanup + duplicate + explicit_cancel_human + explicit_cancel_bot`，且各档之和不超过已知结果账卡时；`cancelled_unknown` 的减小量 = explicit 两档增量（无凭空漂移）。
5. CI：`npm run lint`、`npm test`、`npx tsx etl/scripts/collect-cancel-annotations.ts --help`、`npm run validate:repos`、`uv run pytest tests/test_npu_waste_superseded.py` 全绿；改动若涉及 `.github/workflows/**` 另跑 actionlint（本方案不涉及）。

## 影响与后续约束

- `pg/schema.sql` 追加 4 列 + 1 个部分索引；对已运行库的迁移命令幂等可重放。
- 新增 `etl/scripts/collect-cancel-annotations.ts`（+ 单测），不改 collect.ts 主流程。
- `npu_waste_superseded.py` 与 ADR-039 同步升级：新增两档、canceller top 输出、`cancelled_unknown_attempts` 导出键；旧 JSON 产物不回溯改写（快照制品原则）。
- 后续约束：
  - 任何修改 `workflow_attempts` upsert 的变更不得覆盖/清空本 ADR 的 4 个新列（幂等标记与证据是花配额买来的）。
  - 修改 explicit_cancel 判定（bot 清单、优先级、evidence 语义）需更新本 ADR 与 ADR-039，并在 `provenance.cause_rules` 同步。
  - 把 cancel-annotation 采集纳入日常增量（每日新增取消 attempt 很少）属可选后续，若做需另立 ADR 评估与 collect.ts 的合并方式。
  - ADR-039 的历史数字（99,676h unknown）是采集前快照，引用时须注明采集状态。

## 遗留问题（需人工确认）

1. **AGENTS.md 文档漂移**：`supabase/schema.sql`、`npm run migrate:supabase` 在仓库中不存在；真实来源是 `pg/schema.sql`（initdb 挂载 + psql 手工重放）。本 ADR 按现状规划；是否另开 PR 修正 AGENTS.md 与 README 的迁移说明？
2. **token fallback 中间层不一致**：AGENTS.md 写了 `GITHUB_TOKEN_PER_REPO_TRITON_LANG_TRITON_ASCEND` 中间层，但 `rebuild-pr-artifacts.ts` 实际实现没有该层（直接落到 tokens 轮询）。新脚本按 AGENTS 语义实现三层；是否顺带对齐 rebuild 脚本？
3. **全量补采是否执行**：预算 ~46k 调用 ≈ 9.2h（单身份），预期分类增益≈0（superseded 档抽样 4/4 无 annotation）。本方案默认不做、仅保留 `--min-hours` 剪枝后的可选项，请确认。
4. **bot 清单初值**：已实证 `sglang-npu-bot`；是否还有其他已知 bot（各 repo 的 CI bot 账号）需要预置进 `BOT_LOGINS`？首批采集后按 canceller top 列表人工补充亦可。
5. **本 ADR 文件归属**：当前工作区分支为 `feat/pr-card-hours-coverage-audit`，按要求本 ADR 未 commit；实施 PR（schema + 脚本 + Python 改造 + 测试）应基于最新 main 新建分支，并把本 ADR 与 ADR-039 更新一并纳入，请确认携带方式。
