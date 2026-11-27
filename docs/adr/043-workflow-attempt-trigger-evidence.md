# ADR-043: Workflow attempt trigger evidence

**状态：部分实现，尚未完成验收。** 本文是 Workflow attempt 计时、样本覆盖与展示的唯一契约；实现现状见「现状与剩余收口」。本 ADR 取代 [ADR-023](023-attempt-duration-rerun-semantics.md) 中重跑 Total 等于 Runtime、缺少开始时沿用旧值的做法；延续 [ADR-015](015-queue-metric-boundaries.md) 的 Workflow 首个 Job 开始边界，并明确 Job 启动前等待不等同于 runner 排队。[ADR-020](020-pr-ci-cycles-card-hours.md) 的 PR 生命周期包络不变；其 drill-down 的 attempt 计时遵循本文。

## 决策：按 attempt 验证端点

GitHub rerun 沿用原 run 的创建时间。重跑前的人为或自动触发间隔不是本次耗时，扣掉这段间隔也不能反推出请求时刻。相比把不可比的样本混入统计，我们接受覆盖率下降，并展示缺失量。

Workflow 样本键为 `(repo, run_id, run_attempt)`，Job 样本再加 `job_id`。同一 run 的首跑与各次重跑分别计数；已观察到的首跑不得被最新 attempt 覆盖。去重及关联必须保留完整键；父 run 只提供归属、原创建时间等 run 级元数据，不能为不同 attempt 补执行端点。仅有 run 级历史时，可保留为明确标注的历史记录；只有能证实归属首跑的记录才进入 attempt 样本，不能默认当作 attempt 1，也不补造缺失的历史 attempt。

| 指标 | 端点及证据 |
| --- | --- |
| Workflow 触发→开始（`queue_duration_seconds`） | 可信的本 attempt 触发时间 → 本 attempt 首个 Job 实际开始（延续 ADR-015；必须能确认该 Job 是首个开始的）。不以 `run_started_at` 代替首个 Job 的开始，也不称为纯 runner 排队。 |
| Workflow 触发→完成（`total_duration_seconds`，Workflow E2E） | 同样的触发证据 → 本 attempt 完成。保留区间内的启动、依赖及其他等待；不扣依赖等待，不加总 Job 时长或补加某个 Job 的等待。 |
| Workflow 开始→完成（`runtime_seconds`，Runtime） | 本 attempt 的 `run_started_at` → 本 attempt 完成。即使没有 trigger 也独立计算和展示；是墙钟时长，包含期间内部 Job 等待，不是纯执行或资源占用时长。开始边界与触发→首个 Job 开始不同，不把二者相加冒充 E2E。 |
| Job 启动前等待（现存 `workflow_jobs.queue_duration_seconds`） | 同一 attempt、同一 Job 的 `created_at → started_at`；可能包含依赖等待。Job 的有效计时不依赖 Workflow trigger 是否已知。 |
| 纯 runner 排队 | 同一 Job 有可验证的「依赖及启动前置条件已满足、可分配 runner」时点，才计算该时点 → 实际开始。没有可调度证据即未知，不能从 Job 创建、前置 Job 最晚完成、runner 标签或已分配 runner 反推。 |

- **触发证据**：`created_at` 只在来源能证明它是原触发、且记录确为首跑时使用。对重跑，必须有经出处核实、唯一绑定本 attempt 的触发时间。原 run 创建、上次完成、本次开始、Job 创建或采集收到记录的时间都不能冒充重跑触发。无可信 trigger 时，触发→开始和触发→完成均未知；有 trigger 而只缺一个结束端点时，另一个指标可独立有效。
- **完成证据**：优先用明确的 attempt 完成时间；`updated_at` 仅可作为代理，条件是它来自经验证为**同一 attempt 已完成**的响应、该来源支持把此更新视为完成，且展示/元数据标明是代理。不得取父 run 的 `updated_at` 给历史 attempt 补完成，也不得把进行中状态的更新时间当完成。库里的 `completed_at`、已算出的时长或两个顺序合理的时间戳，都不能单独证明出处。
- **无效即未知**：端点缺失、不可解析、倒序、归属不明或跨 attempt 时，该指标为空（数据库/API 的 `NULL`/`null`，界面 `—`/未知）；不截断为零，不换用别的指标。只有可信端点实际同刻才记 `0`。一个指标未知不抹掉 attempt、结论、其他有效指标或有效 Job 样本。
- **PR 边界**：PR 创建→合并是评审生命周期；`pr_metrics.ci_duration_seconds` 是关联 CI 的 run 级首创建→末完成包络（可以覆盖 push/rerun 间隔），不是 Workflow attempt E2E 或排队，也没有「PR 排队」指标。Push cycle 仍是单独口径：已核实的首跑保留在原 push 批次，不能让同批未知重跑抹掉合法首跑样本；未知重跑可显示结论和独立 Runtime，但不能用原创建时间画成该 attempt 的执行区间。若显示全范围 busy/idle，未测区间须标为未知/覆盖不全，不能计为 idle。PR 关联、资源计量和 merge-time CI 状态资格另有约定，不随本 ADR 改定义。

## 覆盖与比较

- 每项计时分别显示 `有效样本数 / 符合筛选条件的样本数`：先按该展示的仓库、日期、workflow/ref、runner/resource、状态/结论等条件选样，再按其样本键去重；分母包含这些条件下时间未知的观测记录，分子是实际进入该计时统计的有效记录。不同时间指标、Workflow/Job/PR 不能共用分母。卡片、分组/榜单、图表和比较报告各自展示相应覆盖；分页、取最近 N 或导出限制不能悄悄充当全窗口分母，若只展示切片须标明范围。
- 比较报告逐边写清日期锚点/时区、过滤条件、样本单位、首跑与重跑构成、有效数/分母及缺失原因。以 `runs.date` 或原 run 创建时间选窗时明确它是父 run 日期，不是 rerun 的触发日期。若某报表保留「成功且超过最小时长」等时长门槛，先列出符合其他筛选条件的总数，再列已知且达标、已知但未达标、无法判断门槛的数量；只用已知达标样本做该统计并注明取样规则，未知不默认为达标或短样本。时长门槛不影响其他独立指标和原始计数。
- 仅用有效样本计算均值、分位数及耗时分布；没有有效样本时指标未知（覆盖显示 `0/N`），不能报 `0 min` 或在对比中宣称提速。首跑的真实长尾必须保留在适用样本及长尾档位中，不为去除伪重跑长尾而按耗时上限截断、缩尾或丢弃首跑。若两侧覆盖率或 attempt 构成不同，至少分列首跑/重跑覆盖或提供同口径切片再解释差异。

## 当前证据与存量边界

`etl/scripts/collect.ts` 读取 workflow run 列表，`etl/scripts/github-jobs.ts` 获取 run/attempt 的 Jobs；现有来源不能证实历史 rerun 的 trigger 或 Job 可调度时点，因此不能补算相应两项触发指标或纯 runner 排队。`workflow_attempts.created_at` 不是重跑请求，旧 `total_duration_seconds` 可能是 Runtime 或旧代理，旧 Runtime/完成字段还可能来自曾混用父 run 的回填。补齐 Job 与补齐触发证据是两回事；禁止将旧非空字段或写入日期当作证据。

当前工作树已在 `pg/schema.sql` 为 `workflow_attempts` 和 `workflow_jobs` 增量添加可空 `timing_evidence JSONB`，版本 1 保存各指标**实际验证得到的秒数**，而非仅保存布尔标记：`{"version":1,"trigger_at":…, "queue_duration_seconds":…, "runtime_seconds":…, "total_duration_seconds":…}`。各键独立、可缺省；Workflow 的 queue 是首跑 trigger→首个 Job 开始，Runtime 是 attempt 开始→完成，Total 是首跑 trigger→完成；Job 的 queue、Runtime、Total 分别是 created→started、started→completed、created→completed。已验证的显式完成端点还可记录 `completed_at` 原始时间戳及 `completion_source`，分别为 `github_run.completed_at` 或 `github_job.completed_at`。`trigger_at` 仅在首跑且其 E2E/queue 证据成立时记录，值为导出这些时长的同一已验证原触发时间；消费方须同时校验它与 attempt 行的 `created_at` 一致才可用作 trigger。写入要求来源记录和 attempt/Job 身份相符、端点有效且不倒序；Workflow 首跑 queue 还依赖同次绑定的 Jobs 采集与可确认的首个开始。重跑 trigger 仍未知。标准 GitHub workflow-run 响应可能没有显式 `completed_at`；`updated_at` 即使写入旧列，在来源未支持其作为完成代理时也不能产生可信完成证据。旧列仍可能有值，但无对应版本 1 指标值就应视为未知。

已接入的读路径通过 `to_jsonb(wa)` / `to_jsonb(wj)` 读取可选字段，兼容尚无该列的旧 schema；版本不符、缺键、非数值或无效数值均为未知，不以旧列补值。写入端逐表检测列是否存在；符合 [ADR-038](038-september-gap-targeted-backfill.md) 保留条件（仅重写 run、未重取 Jobs、身份不变）时，旧已验证证据与新证据合并（旧字段缺省时由新值补充，queue 恒取旧已验证值），不会仅因脱水重写就抹去 `trigger_at`、`completed_at` 等已验证字段。此增量结构不要求清库、全量重采或历史重算；旧 schema 能读取但无法持久化新证据。

## 现状与剩余收口

基线为 `feat/rerun-attempt-timing` 的 `b3186ca627`；本文所述实现位于其后的未提交工作树，而非该提交本身。隔离 PostgreSQL 上 schema 已连续应用两次；实际 writer 和 Runs 页面、图表、统计使用同一 fixture 验证：首跑完整保留 `trigger_at`/queue/Runtime/Total/`completed_at`，重跑仅可信 Runtime `5358 s`，脱水重写后合并语义不丢字段，旧 schema 读取返回 `null`。全量 `TZ=UTC npm test`、lint、type-check、仓库校验与报表离线单测在当前工作树均通过（含 MST 基线已知差异）。这些是局部验证，不代表所有视图或产物通过验收。

Runs 的日期锚点与实际 trigger 要分开：延续 [ADR-024](024-pr-card-hours-evidence-and-coverage.md) 按 run 创建时间归属的集合审计；Runs 视图用于窗口归属的时间在重跑时取 `run_started_at`，首跑依次取 attempt 创建、父 run 创建或 attempt 开始。它是选窗/展示锚点，不证明触发请求时间，也不能用来补算重跑 trigger 指标。

以下为需要继续检查或完成的范围；部分路径已有实现，不能把清单理解为全部尚未动工。每项仍须验证其证据、覆盖和展示契约，禁止将旧非空值视为证据。

1. **验证读边界。** `src/lib/dashboard-read-model.ts` 的 `fetchWorkflowAttemptRows`、`fetchWorkflowGroupRows`（Workflow 与 Cost 共用）、`fetchWorkflowAttemptDrilldown`：保留已加的遮罩；将首跑及 Runtime 也纳入证据校验，覆盖各 SQL 分组及 API 输出。检查 `fetchJobGroupRows`、`fetchQueuePopulationStats`、`fetchQueueDailyP90`、`fetchJobAttemptDrilldown` 等 Job/Queue 读路径，历史伪零不能进入统计。`src/lib/pr-data-fetcher.ts` 的 `mapAttemptRunRow` 与 `etl/scripts/rebuild-pr-artifacts.ts` 的 `fetchWorkflowAttemptRunsFromClient` 分开传递 run 级元数据与 attempt 端点；解除父 run、Runtime 或 `0` 对 attempt 计时的回退（涉及类型时改 `src/lib/types.ts`）。同一套证据规则用于 SQL 聚合与 TS 映射；先验证带陈旧非空值的 fixture，再开放上层展示。不改写 `src/lib/pr-metrics.ts` 的 PR 包络公式或 merge-time 状态判定。
2. **验证写入边界。** `etl/scripts/collect.ts` → `etl/scripts/workflow-attempts.ts` → `etl/scripts/pg-storage.ts`/`etl/scripts/workflow-attempt-writes.ts`，以及并行入口 `etl/scripts/backfill-missing-jobs.ts`：保留已修的 attempt status/conclusion/时间戳选择与重跑清空逻辑；禁止用父 run 时长、当前时钟、缺失状态的默认 `completed` 或负数截零生成指标。回填只用已验证的 attempt 行和该 attempt Jobs，不把旧行可疑完成时间洗成可信。保住已验证的首跑等待值在「仅重写 run、未重取 Jobs」时不衰减（[ADR-038](038-september-gap-targeted-backfill.md)）；未知或冲突证据不能被 `COALESCE` 升为有效。Step 采集门槛是采集策略，不把其 Runtime 判定值当成 E2E。
3. **完成 Dashboard/PR 展示及覆盖验收。** `src/app/page.tsx` → `getDashboardReadModel`；`src/app/api/data/route.ts` → Workflow/Job/PR drill-down。给 `buildWorkflowCards`、`buildWorkflowDashboardResult`、Cost 的分组均值及 Job/Queue 计时传递各自覆盖；`src/app/DashboardShell.tsx` 的 `WorkflowBody`、`WorkflowDrillDown`、`JobDrillDown`、`QueueBody` 与 Cost/PR 相应展示分开 E2E、Runtime、启动前等待，移除图表的 `?? 0`，不用堆叠暗示加和关系。`src/lib/ci-cycles.ts` → `src/app/CiCycleGantt.tsx`：保留有效首跑 push wall；不要从未知重跑的原创建时间画 bar、填 wall，或把未知标为正在执行/idle。`fetchPullRequestDetail` 的关联、结论与 Job/card-hours 展示仍可独立工作。
4. **Terra：报表接入剩余契约。** 在 `.agents/skills/ci-effective-report/SKILL.md` 放强制入口：生成或修改 Workflow attempt 计时、Job 启动等待或 CI 对比报告前，先读 `docs/adr/043-workflow-attempt-trigger-evidence.md`；把冲突的 run 级分布表述改为引用本文，保留只读 PostgreSQL、不调用 GitHub API 的规则。继续在 `scripts/ci_analyze.py` 的 `fetch_runs` 去除 `DISTINCT ON (run_id)` 只留最新 attempt 的选样，`fetch_jobs`/`fetch_steps` 与 PR 链接按 attempt 键关联；历史回退不得混入无归属计时。`analyze_workflow_stats`、`analyze_comparison`、`build_report_mode_data` 及对应 Excel/HTML 输出分别带覆盖，不再把有效时长数当执行次数或把空值报成零。复用现有 Runtime/E2E 分列与 Job 文案，只在 `tests/test_ci_analyze.py` 补首跑+重跑并存、证据校验和覆盖回归；不重新生成旧报告。独立专题脚本若输出本 ADR 的计时或比较，也须遵循同一契约；仅做资源机时/取消归因的输出不扩范围。

### 回归门槛（实现合并前）

- **同一份离线 fixture 对齐 ETL、读模型、PR 与报表**：同一 run 有真实长尾首跑（进适用 P90/最长档）及相隔两天的重跑（两项触发指标为空，可信 Runtime 为 `5358 s`）；两条 attempt 均计入，结论和 Job 启动前等待保留，不把间隔算进任一 attempt。多 Job join 不重计；不同仓/attempt 键不串；首跑与重跑同 push 时仍可显示有效首跑，PR 包络快照不变。
- **负例**：用父 run 完成配旧 attempt 开始（即便时间正序）、无出处的旧 Runtime、进行中 `updated_at`、缺失/倒序 Job 时间戳都必须使对应指标未知；同刻真实 `0` 另测。带依赖等待的 Job 可有有效启动前等待，但无 ready 证据时纯 runner 排队未知；内部等待仍包含在适用 E2E/Runtime 区间。ETL 测 insert、conflict upsert 及 backfill，包含旧的非空重跑值和未重取 Jobs 的首跑写入。
- **分母与产物**：一个成功首跑加一个同范围成功重跑，若只首跑具备 E2E 证据且两者 Runtime 可信，E2E 显示 `1/2`、Runtime `2/2`；验证全未知 `0/N`、不同时长门槛/结论/资源过滤和分页。对照 Dashboard API/UI、PR drill-down 和报表 Excel/HTML，确认不画零值、覆盖不足不报提速且比较口径可追溯。
- **命令**：以 `etl/scripts/{workflow-attempts,workflow-attempt-writes,backfill-missing-jobs}.test.ts`、`src/lib/{dashboard-read-model-workflow,dashboard-read-model-job-queue,pr-data-fetcher,pr-metrics,ci-cycles}.test.ts`、`src/app/DashboardShell.test.tsx` 为定向回归入口（缺的用例补到对应文件）；再跑 `npm run lint`、`npm test`、`npm run validate:repos` 和 `DRY_RUN=1 npx tsx etl/scripts/collect.ts --help`。在 `.agents/skills/ci-effective-report` 跑 `uv run python -B -m unittest discover -s tests`。回归用 mock 客户端/离线 fixture，不依赖生产 DB 或 API。

## 后续扩采：有可验证事件才接入

不预设 GitHub API、Webhook、日志或其他事件当前能提供所需时点。候选来源必须先过以下验收，才另行决定采集、证据落库和启用方式：

1. **语义及归属**：以实际脱敏样本与来源定义证明记录的是触发请求发生时刻（不是投递/采集时间），可唯一关联 `(repo, run_id, run_attempt)`；若是 Job ready，另须证明同一 `job_id` 此刻已经满足调度前置条件。只有 run id 或按时间邻近猜测均不通过。首跑、连续重跑及部分 Job 重跑均应验证；不支持的情形保持未知。
2. **出处可复核**：保留来源、事件/记录标识、原始时间、键映射及验证规则版本；能独立核对语义与对应的执行记录。用缺失、重复、冲突、迟到、乱序和错误 attempt 的样本验证幂等与拒收；跳过或拒收仍记录覆盖，不能自动补零或拿历史值顶替。
3. **端到端验收**：同一受控 fixture 中，仅有确证 trigger 的重跑，其触发指标从未知变成实际区间，有效数随之增加而分母和独立 Runtime 不变；拒收样本及无证据存量仍为空。Job ready 接入单独验收，不改变启动前等待或扣减 E2E。接入前给出可审计的覆盖、权限与采集成本评估；若需要迁移或历史补录，单独审批，且只录可独立核验的证据。
